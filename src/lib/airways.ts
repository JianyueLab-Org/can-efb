import type { Feature, FeatureCollection } from "geojson";
import { distanceNm, type LatLon } from "@/lib/geo";
import { dbFetch } from "@/lib/naip";
import { wrapLon } from "@/lib/mapText";

/**
 * 航路网：从 can-db 取回来，转成地图能画的线。
 *
 * **数据源是 can-db 的 `/api/v1/aip/airways`，不是 can-api 的 `/api/v1/route`。**
 * 这两个是不同的东西，容易混：
 *
 *   /api/v1/route      can-api  —— 「这串航路字符串展开成哪些点」，RoutePlanner 用它
 *   /api/v1/aip/route  can-db   —— 「从 A 到 B 该怎么飞」的规划器，EFB 目前没用
 *   /api/v1/aip/airways can-db  —— **整张航路网**，这个文件用的就是它
 *
 * 前两个回答的是一条具体航路，这一个给的是整张图 —— 图层要的是后者。
 *
 * ## 端点是图键，不是代号
 *
 * 航段的 `from` / `to` 是**图键**：Navigraph 的行是 `ident@region/kind`（例如
 * `AKAGI@RJ/waypoint`），没匹配上的 NAIP 点是裸代号。`fixes` 按图键索引。给人看
 * 的、和计划里的代号比的，一律用 `fromIdent` / `toIdent`（旧版 can-db 没有这两项，
 * 退回 `from` / `to`，那时图键就是代号）。同一个代号在两个地区是两个图键、两个点，
 * 不许按代号并起来。
 */

/** can-db 的 `AirwayGraph`，字段和它的 Go 结构逐字对齐。 */
export interface AirwayGraph {
  /** 图键 → [lat, lon]。**注意是纬度在前**，和 GeoJSON 相反。 */
  fixes: Record<string, [number, number]>;
  segments: AirwaySegment[];
  /** designator → 整条航路的属性。按 level 过滤时它不跟着筛。 */
  airways: Record<string, AirwayMeta>;
}

export interface AirwaySegment {
  airway: string;
  /** 图键（见文件顶上）。只拿来查 `fixes` 和认航段，不给人看。 */
  from: string;
  to: string;
  /** 两端的代号，标注和比对计划用。旧版 can-db 不给，用 `segmentIdents` 取。 */
  fromIdent?: string;
  toIdent?: string;
  /** "both" | "forward" | "backward"。 */
  dir: string;
  /** 英尺，可空 —— 来源不发布高度带时就是 null。 */
  minAlt: number | null;
  maxAlt: number | null;
}

export interface AirwayMeta {
  /** 汇编给的类型，例如 '国内对外开放航路'。地图按它分色。 */
  locType: string | null;
  lengthKm: number | null;
  lengthNm: number | null;
  mtcaM: number | null;
  note: string | null;
}

export type AirwayLevel = "high" | "low";

/** 航段两端的代号。旧版 can-db 没有 `fromIdent` / `toIdent`，那时图键就是代号。 */
export function segmentIdents(seg: AirwaySegment): [string, string] {
  return [seg.fromIdent ?? seg.from, seg.toIdent ?? seg.to];
}

/** 取数框：`[south, west, north, east]`，度。`west > east` 表示跨 180°。 */
export type AirwayBbox = [number, number, number, number];

/** 航路网按视野取时一块多大（度）。块的边界是它的整数倍，从 -180 / -90 算起。 */
export const AIRWAY_BLOCK = 10;
/** 最多攒多少块。超过时丢视野外最早取的那些。 */
export const AIRWAY_MAX_BLOCKS = 64;

/**
 * 视野框 → 覆盖它的那些块的左下角。
 *
 * 经度是 MapLibre 原样给的展开值（过日界线后是 `170..190` 或 `-200..-170`），这里
 * 折回 [-180, 180) 再取块，所以跨 180° 的视野拆成两侧的块，每块自己不跨。视野横跨
 * 360° 以上就是整圈。和 `lib/mora.ts` 的 `blocksFor` 同一个做法，只是纬度只取
 * [-90, 90) 里的块 —— 航路没有 MORA 那个「格子北边」的偏移。
 */
export function airwayBlocksFor(
  south: number,
  west: number,
  north: number,
  east: number,
): { lat: number; lon: number }[] {
  const floor = (v: number) => Math.floor(v / AIRWAY_BLOCK) * AIRWAY_BLOCK;
  const [from, to] =
    east - west >= 360
      ? [-180, 180 - AIRWAY_BLOCK]
      : [floor(west), floor(east)];
  const lons = new Set<number>();
  for (let lon = from; lon <= to; lon += AIRWAY_BLOCK) lons.add(wrapLon(lon));
  const out: { lat: number; lon: number }[] = [];
  const lat0 = Math.max(-90, floor(south));
  const lat1 = Math.min(90 - AIRWAY_BLOCK, floor(north));
  for (let lat = lat0; lat <= lat1; lat += AIRWAY_BLOCK) {
    for (const lon of lons) out.push({ lat, lon });
  }
  return out;
}

/**
 * 一条航段在图上归哪一层。`both` 是两个视图里都有的那些（can-db 的 `both` 加上没有
 * 高低空这根轴的 `NULL`，那边两个视图都给）。
 */
export type SegmentLevel = "high" | "low" | "both";

const LEVEL_RANK: Record<SegmentLevel, number> = { low: 0, both: 1, high: 2 };

export interface TaggedSegment extends AirwaySegment {
  level: SegmentLevel;
}

export interface TaggedAirwayGraph extends Omit<AirwayGraph, "segments"> {
  segments: TaggedSegment[];
}

/**
 * 拉航路网。走本站的 can-db 反代，不直连 —— 理由见
 * `pages/api/db/[...path].ts` 顶上。
 *
 * 失败**抛出**而不是返回空：这一层是用户明确打开的图层，不是装饰性底图。悄悄给
 * 一张空图会被当成「这一带没有航路」，那是错的信息，比一个错误提示糟得多。
 */
export async function fetchAirways(
  level: AirwayLevel,
  bbox?: AirwayBbox,
): Promise<AirwayGraph> {
  const box = bbox ? `&bbox=${bbox.join(",")}` : "";
  const response = await dbFetch(`aip/airways?level=${level}${box}`);
  if (!response.ok) {
    throw new Error(`airways ${level}: ${response.status}`);
  }
  const body = (await response.json()) as { data?: AirwayGraph } & AirwayGraph;
  // can-db 大部分接口包着 {status, data}，少数裸奔 —— 和 canApi 那边同一个拆法。
  return (body.data ?? body) as AirwayGraph;
}

/**
 * 两个层级一起取，合成一张带层级标记的图。
 *
 * can-db 的响应里**没有 level 这一列**（`AirwaySegment` 不带它），只能按 `?level=`
 * 分两次取：`high` 给 high + both + NULL，`low` 给 low + both + NULL。两边都出现的
 * 就是 `both`。地图按缩放决定画哪一层（`lib/chartStyle.ts` 的 `ZOOM`），不再让人去
 * 选。
 */
export async function fetchAirwayNetwork(
  bbox?: AirwayBbox,
): Promise<TaggedAirwayGraph> {
  const [high, low] = await Promise.all([
    fetchAirways("high", bbox),
    fetchAirways("low", bbox),
  ]);
  return mergeAirwayLevels(high, low);
}

/**
 * 把按块取回来的几张图并成一张。
 *
 * 航段按图键认（`segmentKey`），跨块边界的那一段在两块里各出现一次，只留一份。两
 * 块给同一段打的层级不一样时记为 `both` —— 每块都是高低空两次都取的，正常不会发生，
 * 取并集只是防御。
 */
export function unionAirwayGraphs(
  graphs: Iterable<TaggedAirwayGraph>,
): TaggedAirwayGraph {
  const fixes: AirwayGraph["fixes"] = {};
  const airways: AirwayGraph["airways"] = {};
  const byKey = new Map<string, TaggedSegment>();
  for (const g of graphs) {
    Object.assign(fixes, g.fixes);
    Object.assign(airways, g.airways);
    for (const seg of g.segments) {
      const key = segmentKey(seg);
      const seen = byKey.get(key);
      if (!seen) byKey.set(key, { ...seg });
      else if (seen.level !== seg.level) seen.level = "both";
    }
  }
  return { fixes, airways, segments: [...byKey.values()] };
}

/** 同一行航段在两次响应里一模一样，按这几项认。 */
function segmentKey(s: AirwaySegment): string {
  return `${s.airway}|${s.from}|${s.to}|${s.dir}`;
}

/**
 * 合并两个视图，每条航段只留一份并打上层级。
 *
 * 点集和航路属性两边本来就是全量（can-db 不按 level 筛它们），取并集只是防御。同
 * 一视图里重复出现的航段也收成一条 —— 两条重合的线画出来没有区别，高亮时却会算两
 * 遍。
 */
export function mergeAirwayLevels(
  high: AirwayGraph,
  low: AirwayGraph,
): TaggedAirwayGraph {
  const byKey = new Map<string, TaggedSegment>();
  for (const seg of high.segments) {
    const key = segmentKey(seg);
    if (!byKey.has(key)) byKey.set(key, { ...seg, level: "high" });
  }
  for (const seg of low.segments) {
    const key = segmentKey(seg);
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...seg, level: "low" });
    else if (seen.level === "high") seen.level = "both";
  }
  return {
    fixes: { ...low.fixes, ...high.fixes },
    airways: { ...low.airways, ...high.airways },
    segments: [...byKey.values()],
  };
}

/**
 * 把图转成线要素，一条航段一条线。
 *
 * **按航段而不是按整条航路连成一条线**：航段是数据的单位，而一条航路在图上未必
 * 是一条连续的折线（它可以分叉、可以有断点）。把同名航段首尾相接地串起来，遇到
 * 数据里本来就不连的地方就会画出一条凭空的连线 —— 那是编出来的几何。
 *
 * 端点查不到坐标的航段**直接丢掉**，不画半条：`fixes` 是这张图自己的点集，查不
 * 到意味着数据不一致，而画一条从已知点通向 `[0,0]` 的线，比不画糟得多。
 */
/**
 * 一条航段的键，**和方向无关**。
 *
 * 航段在库里存成哪个朝向是导入时那一段碰巧的存法，而一条计划可能反着飞过去 ——
 * 认朝向的话，反着飞的那半条航路就点不亮，而**图上看不出来**：线还在，只是没高亮。
 * can-db 的航路限制匹配踩过同一个坑，那边的结论也是不看朝向。
 */
export function legKey(airway: string, a: string, b: string): string {
  return a < b ? `${airway}|${a}|${b}` : `${airway}|${b}|${a}`;
}

/**
 * 把一条已解析的航路变成航段键的集合。
 *
 * `via` 是**走这条腿用的航路代号**，属于到达的那个点。没有 `via`、或者它是 `DCT`，
 * 就说明这条腿不在任何航路上 —— 那种腿没有可点亮的东西，得自己画线。
 */
export function routeLegKeys(all: RouteLegPoint[]): Set<string> {
  return new Set(routeLegs(all).map((l) => l.key));
}

/** 计划里的一个点。`lat` / `lon` 有的话，同名航段靠它挑（见 `routeLegsOnAirways`）。 */
export interface RouteLegPoint {
  ident: string;
  via?: string;
  shape?: boolean;
  lat?: number;
  lon?: number;
}

/** 计划里走航路的一条腿：键，加上两端在计划里的位置（有的话）。 */
export interface RouteLeg {
  key: string;
  ends?: [[number, number], [number, number]];
}

/** 同 `routeLegKeys`，但带上两端位置。 */
export function routeLegs(all: RouteLegPoint[]): RouteLeg[] {
  const out: RouteLeg[] = [];
  // 画弯插进来的几何点不是航路点，比键时越过它们。
  const points = all.filter((p) => !p.shape);
  for (let i = 1; i < points.length; i++) {
    const via = points[i].via;
    if (!via || via === "DCT") continue;
    const a = points[i - 1];
    const b = points[i];
    const leg: RouteLeg = { key: legKey(via, a.ident, b.ident) };
    if (
      a.lat !== undefined &&
      a.lon !== undefined &&
      b.lat !== undefined &&
      b.lon !== undefined
    ) {
      leg.ends = [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ];
    }
    out.push(leg);
  }
  return out;
}

/** 两点的粗略距离（度的平方和，经度差折回 ±180）。只拿来比大小。 */
function roughDist(a: [number, number], b: [number, number]): number {
  const dLat = a[0] - b[0];
  const dLon = wrapLon(a[1] - b[1]);
  return dLat * dLat + dLon * dLon;
}

/** 航段要素两端（[lat, lon]），不分方向地和计划那条腿比有多远。 */
function legDistance(
  f: Feature,
  ends: [[number, number], [number, number]],
): number {
  if (f.geometry.type !== "LineString") return Infinity;
  const c = f.geometry.coordinates;
  const p: [number, number] = [c[0][1], c[0][0]];
  const q: [number, number] = [c[c.length - 1][1], c[c.length - 1][0]];
  return Math.min(
    roughDist(p, ends[0]) + roughDist(q, ends[1]),
    roughDist(p, ends[1]) + roughDist(q, ends[0]),
  );
}

/** 一份航段集合的索引：计划键 → 那些航段（`leg`）和它们实线段的要素。 */
type LegIndex = Map<string, { leg: string; line: Feature }[]>;

/** 按集合对象记一份：航路网一律整份换掉，不就地改。 */
const legIndexOf = new WeakMap<FeatureCollection, LegIndex>();

function legIndex(collection: FeatureCollection): LegIndex {
  const cached = legIndexOf.get(collection);
  if (cached) return cached;
  const index: LegIndex = new Map();
  const seen = new Set<string>();
  for (const f of collection.features) {
    const props = f.properties ?? {};
    const leg = props.leg;
    // 一段三截（实线加两截虚线）同一个 `leg`，按实线那截认。
    if (typeof leg !== "string" || props.part === "stub" || seen.has(leg))
      continue;
    seen.add(leg);
    const key = legKey(
      String(props.airway ?? ""),
      String(props.fromIdent ?? props.from ?? ""),
      String(props.toIdent ?? props.to ?? ""),
    );
    const bucket = index.get(key);
    if (bucket) bucket.push({ leg, line: f });
    else index.set(key, [{ leg, line: f }]);
  }
  legIndexOf.set(collection, index);
  return index;
}

/**
 * 计划走过的航段在航路网上对上了哪些。航段数据不动：样式按 `lit` 点亮（`chartStyle.ts`
 * 的 `onRouteOf`，比的是每条航段的 `leg` 属性），高亮变了不重传航路网。
 *
 * - `planned`：对上了的**计划键**（`legKey`，代号）。
 * - `lit`：要点亮的航段的 `leg`（图键）。
 *
 * ## 为什么要返回「对上了的」
 *
 * 不是每条腿都点得亮：航路图层可能关着，某个航段可能因为高低空过滤不在这份集合
 * 里，端点也可能解析不出坐标而被丢掉。调用方要拿 `planned` 去决定**哪几条腿仍然得
 * 自己画线** —— 假设「有 via 就一定被点亮了」的话，那些没点上的腿会从图上消失，而
 * 航路断在中间是看不出来的：剩下的线本身都对。
 *
 * ## 按代号比，不按图键比
 *
 * 计划里写的是代号，航段的 `from` / `to` 是图键。比的是要素上的 `fromIdent` /
 * `toIdent`。同一个航路代号加同一对点名可能在两个地区各有一段（两个图键）：腿带着
 * 位置（`routeLegs`）时只点亮离计划那条腿最近的一段；不带位置（传进来的是
 * `Set`）时同名的都点亮。
 */
export function routeLegsOnAirways(
  collection: FeatureCollection,
  legs: Set<string> | RouteLeg[],
): { planned: Set<string>; lit: Set<string> } {
  const list: RouteLeg[] = Array.isArray(legs)
    ? legs
    : [...legs].map((key) => ({ key }));
  const index = legIndex(collection);
  const planned = new Set<string>();
  const lit = new Set<string>();
  for (const leg of list) {
    const candidates = index.get(leg.key);
    if (!candidates) continue;
    let chosen = candidates;
    if (candidates.length > 1 && leg.ends) {
      const ends = leg.ends;
      let best = candidates[0];
      let bestDist = legDistance(best.line, ends);
      for (const c of candidates.slice(1)) {
        const d = legDistance(c.line, ends);
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      }
      chosen = [best];
    }
    for (const c of chosen) lit.add(c.leg);
    planned.add(leg.key);
  }
  return { planned, lit };
}

/**
 * RNAV 航路的代号首字母。**启发式**：can-db 没有 RNAV 标记，只能按代号猜。
 *
 * ICAO 附件 11 附录 1：`L M N P`（地区）、`Q T Y Z`（国内）是 RNAV；中国的 `W V X`
 * 系列按 RNAV 画（产品决定，和 ICAO 的 `V W` 属常规不一致）。其余（`A B G R H J`
 * 等）按常规。
 */
export const RNAV_LETTERS = new Set([
  "L",
  "M",
  "N",
  "P",
  "Q",
  "T",
  "Y",
  "Z",
  "W",
  "V",
  "X",
]);

/** ICAO 的前缀字母：`U` 高空、`K` 直升机低空、`S` 超音速。后面还跟一个字母才算前缀。 */
const DESIGNATOR_PREFIX = /^[UKS](?=[A-Z])/;

/**
 * 航路是不是 RNAV，决定代号牌的颜色。先去掉一个 ICAO 前缀（`UL888` → `L`），再看
 * 首字母是否在 `RNAV_LETTERS` 里。
 */
export function isRnavDesignator(designator: string): boolean {
  const d = designator.trim().toUpperCase().replace(DESIGNATOR_PREFIX, "");
  return RNAV_LETTERS.has(d.charAt(0));
}

/** 航段在两端各让出多少海里给定位点（航图画法：实线停在点外，虚线接进去）。 */
export const AIRWAY_FIX_GAP_NM = 1;

/**
 * 一端实际让出多少海里：`min(1, 0.4 × 航段长)`。
 *
 * 2.5 NM 以上的航段两端各让 1 NM，中间至少还剩 0.5 NM 实线；更短的按比例让，两个量在
 * 2.5 NM 处接上，不会在门槛两边跳一下。重合的两点（长度 0）不让。
 */
export function airwayGapNm(lengthNm: number): number {
  if (!(lengthNm > 0)) return 0;
  return Math.min(AIRWAY_FIX_GAP_NM, 0.4 * lengthNm);
}

/**
 * 大圆上从 `from` 往 `to` 走 `fraction`（0–1）处的点。`geo.ts` 是从 can-radar 逐字抄的，
 * 不往里加东西，所以这一个插值写在这里。
 */
export function alongGreatCircle(
  from: LatLon,
  to: LatLon,
  fraction: number,
): LatLon {
  const rad = Math.PI / 180;
  const [lat1, lon1] = [from[0] * rad, from[1] * rad];
  const [lat2, lon2] = [to[0] * rad, to[1] * rad];
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (d < 1e-12) return [from[0], from[1]];
  const a = Math.sin((1 - fraction) * d) / Math.sin(d);
  const b = Math.sin(fraction * d) / Math.sin(d);
  const x =
    a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
  const y =
    a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);
  return [
    Math.atan2(z, Math.sqrt(x * x + y * y)) / rad,
    Math.atan2(y, x) / rad,
  ];
}

/**
 * 航路网：每个航段一条线。
 *
 * **实线在两端各停在定位点外 1 NM**（`airwayGapNm`），让出来的那一截单独出一条
 * `part: "stub"` 的线，样式画成细淡的虚线接进点里 —— 照航图画法，点的符号和点名落在
 * 空白里，不被实线穿过。在数据里切而不是用 `line-offset` 一类的样式技巧：缩放变了，
 * 让出的距离还是 1 NM。
 *
 * 三段都带同一个 `leg`，所以高亮照样点得亮整段；计划走过的那几段，虚线那两截也画成
 * 实线（样式里按 `onRouteOf` 收回实线层），计划航线在点上不断开。代号牌只放在实线
 * 那一段上（`part: "line"`）。
 */
export function toAirwayLines(
  graph: AirwayGraph | TaggedAirwayGraph,
): FeatureCollection {
  const features: Feature[] = [];
  let dropped = 0;

  for (const seg of graph.segments) {
    const from = graph.fixes[seg.from];
    const to = graph.fixes[seg.to];
    if (!from || !to) {
      dropped++;
      continue;
    }
    const meta = graph.airways[seg.airway];
    const [fromIdent, toIdent] = segmentIdents(seg);
    const lengthNm = distanceNm(from, to);
    const gap = airwayGapNm(lengthNm);
    const start = gap ? alongGreatCircle(from, to, gap / lengthNm) : from;
    const end = gap ? alongGreatCircle(from, to, 1 - gap / lengthNm) : to;
    /* fixes 是 [lat, lon]，GeoJSON 要 [lon, lat] —— 这一步反过来，别省。
     * 经度挪到起点那一侧（可以超出 ±180）：跨 180° 的航段走短的那一边，不横穿整张图。 */
    const xy = (p: LatLon): [number, number] => {
      const d = p[1] - from[1];
      return [Math.abs(d) > 180 ? from[1] + wrapLon(d) : p[1], p[0]];
    };
    const properties = {
      airway: seg.airway,
      // 没打过标记的图（单层取的）按 `both` 算：哪一层都不该把它藏掉。
      level: "level" in seg ? seg.level : "both",
      locType: meta?.locType ?? "",
      rnav: isRnavDesignator(seg.airway) ? 1 : 0,
      minAlt: seg.minAlt ?? 0,
      /* 两端代号带上，`routeLegsOnAirways` 靠它和计划比。**属性里没有它就点不亮** ——
       * 而那不会报错，只会让高亮一条都不出现。`from` / `to` 是图键，只认航段。 */
      from: seg.from,
      to: seg.to,
      fromIdent,
      toIdent,
      /* 样式按它点亮（`onRouteOf`）。用图键：同名的两段是两个 `leg`，只点亮挑中的那
       * 一段。和方向无关。 */
      leg: legKey(seg.airway, seg.from, seg.to),
    };
    features.push({
      type: "Feature",
      properties: { ...properties, part: "line" },
      geometry: { type: "LineString", coordinates: [xy(start), xy(end)] },
    });
    if (gap) {
      // 两截都从实线端点画进定位点。
      for (const [edge, fix] of [
        [start, from],
        [end, to],
      ] as const) {
        features.push({
          type: "Feature",
          properties: { ...properties, part: "stub" },
          geometry: {
            type: "LineString",
            coordinates: [xy(edge), xy(fix)],
          },
        });
      }
    }
  }

  if (dropped) {
    console.warn(`[efb:map] 航段端点查不到坐标，丢弃 ${dropped} 条`);
  }
  return { type: "FeatureCollection", features };
}

/**
 * 航路点：把图的 `fixes` 转成点要素。
 *
 * 这是**航路网自己的点集**（`fir IS NULL` 的那一份，约 2,300 个），不是全国所有
 * 航路点 —— can-db 的注释里专门解释过为什么两者不能混：ident 不唯一，267 个名字
 * 对应不止一个物理点，用全量去铺会把 21,204 行塌成 10,335 个条目、最后一个赢。
 *
 * ## 只画**这一层真的用到**的那些点
 *
 * `fixes` 是整张图的顶点集，**它不跟着 `?level=` 筛** —— can-db 那边是有意的，注
 * 释写得很清楚：航段筛掉了，顶点留着，调用方于是能在本地换一层而不必再跑一趟。
 *
 * 那句话的另一半是：**筛的责任因此落在这里。** 全量铺出去的后果不是"多画了几个
 * 点"，而是图上出现一批**没有任何航路连着的孤点**：高空只有约 1111 条航段，它们
 * 引用的顶点远少于 2308 个，其余那些在高空图上不该存在 —— 画出来等于说"这里有个
 * 高空航路点"，而那是假的。
 *
 * 所以这是**先修正确性，顺带省开销**：少掉的那些点同时也是标注，而标注是这张图上
 * 最贵的一类要素（MapLibre 要为每个做碰撞检测）。
 *
 * 判据和 `toAirwayLines` 保持一致 —— 只认**真的画出来了**的航段：端点查不到坐标
 * 的航段在那边被丢掉，它引用的顶点在这边也就不该留下。两处各写一套判断，迟早会出
 * 现"线没画、点还在"的孤点。
 */
export function toAirwayFixes(
  graph: AirwayGraph | TaggedAirwayGraph,
): FeatureCollection {
  /* 点的层级跟着连着它的航段走，取最高的那一级：high > both > low。只被低空航段用
   * 到的点，只在低空那一层出现时才画。 */
  /* 按图键记：同名的两个点是两个要素。标注用代号。 */
  const used = new Map<string, { ident: string; level: SegmentLevel }>();
  for (const seg of graph.segments) {
    // 两端都要在 —— 和 toAirwayLines 的丢弃条件同一句话。
    if (graph.fixes[seg.from] && graph.fixes[seg.to]) {
      const level: SegmentLevel = "level" in seg ? seg.level : "both";
      const idents = segmentIdents(seg);
      [seg.from, seg.to].forEach((key, i) => {
        const prev = used.get(key);
        if (!prev) used.set(key, { ident: idents[i], level });
        else if (LEVEL_RANK[level] > LEVEL_RANK[prev.level]) prev.level = level;
      });
    }
  }

  const features: Feature[] = [];
  for (const [key, { ident, level }] of used) {
    const [lat, lon] = graph.fixes[key];
    features.push({
      type: "Feature",
      properties: { ident, key, level, navaid: "" },
      // fixes 是 [lat, lon]，GeoJSON 要 [lon, lat]。
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 航路点和导航台算同一个点的容差（度，约 0.6 NM）。 */
export const NAVAID_FIX_TOLERANCE_DEG = 0.01;

/**
 * 给和导航台重合的航路点打上 `navaid`（那个台的 `tier`：`vor` / `minor`），不重合的
 * 是空串。重合 = ident 相同且经纬度差都不超过 `NAVAID_FIX_TOLERANCE_DEG`。
 *
 * 导航台优先：样式在那个台画出来的缩放上把这个航路点藏掉（`chartStyle.ts` 的
 * `fixVisible`）。打标记而不是删：NDB 比航路点晚出现，删了中间那一级谁都不画。
 * 导航台图层关着（`navaids` 为空）时原样返回。
 */
export function markNavaidFixes(
  fixes: FeatureCollection | null,
  navaids: FeatureCollection | null,
): FeatureCollection | null {
  if (!fixes || !navaids?.features.length) return fixes;
  const byIdent = new Map<
    string,
    { lon: number; lat: number; tier: string }[]
  >();
  for (const f of navaids.features) {
    if (f.geometry.type !== "Point") continue;
    const ident = String(f.properties?.ident ?? "");
    const [lon, lat] = f.geometry.coordinates;
    const list = byIdent.get(ident) ?? [];
    list.push({ lon, lat, tier: String(f.properties?.tier ?? "minor") });
    byIdent.set(ident, list);
  }
  return {
    ...fixes,
    features: fixes.features.map((f) => {
      let navaid = "";
      if (f.geometry.type === "Point") {
        const [lon, lat] = f.geometry.coordinates;
        const hit = byIdent
          .get(String(f.properties?.ident ?? ""))
          ?.find(
            (n) =>
              Math.abs(n.lon - lon) <= NAVAID_FIX_TOLERANCE_DEG &&
              Math.abs(n.lat - lat) <= NAVAID_FIX_TOLERANCE_DEG,
          );
        if (hit) navaid = hit.tier;
      }
      return { ...f, properties: { ...f.properties, navaid } };
    }),
  };
}
