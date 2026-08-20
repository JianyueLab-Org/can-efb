import type { Feature, FeatureCollection } from "geojson";

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
 * 前两个回答的是一条具体航路，这一个给的是全国的图 —— 图层要的是后者。
 */

/** can-db 的 `AirwayGraph`，字段和它的 Go 结构逐字对齐。 */
export interface AirwayGraph {
  /** ident → [lat, lon]。**注意是纬度在前**，和 GeoJSON 相反。 */
  fixes: Record<string, [number, number]>;
  segments: AirwaySegment[];
  /** designator → 整条航路的属性。按 level 过滤时它不跟着筛。 */
  airways: Record<string, AirwayMeta>;
}

export interface AirwaySegment {
  airway: string;
  from: string;
  to: string;
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

/**
 * 拉航路网。走本站的 can-db 反代，不直连 —— 理由见
 * `pages/api/db/[...path].ts` 顶上。
 *
 * 失败**抛出**而不是返回空：这一层是用户明确打开的图层，不是装饰性底图。悄悄给
 * 一张空图会被当成「这一带没有航路」，那是错的信息，比一个错误提示糟得多。
 */
export async function fetchAirways(level: AirwayLevel): Promise<AirwayGraph> {
  const response = await fetch(`/api/db/aip/airways?level=${level}`);
  if (!response.ok) {
    throw new Error(`airways ${level}: ${response.status}`);
  }
  const body = (await response.json()) as { data?: AirwayGraph } & AirwayGraph;
  // can-db 大部分接口包着 {status, data}，少数裸奔 —— 和 canApi 那边同一个拆法。
  return (body.data ?? body) as AirwayGraph;
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
export function toAirwayLines(graph: AirwayGraph): FeatureCollection {
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
    features.push({
      type: "Feature",
      properties: {
        airway: seg.airway,
        locType: meta?.locType ?? "",
        minAlt: seg.minAlt ?? 0,
      },
      geometry: {
        type: "LineString",
        // fixes 是 [lat, lon]，GeoJSON 要 [lon, lat] —— 这一步反过来，别省。
        coordinates: [
          [from[1], from[0]],
          [to[1], to[0]],
        ],
      },
    });
  }

  if (dropped) {
    console.warn(`[efb:map] 航段端点查不到坐标，丢弃 ${dropped} 条`);
  }
  return { type: "FeatureCollection", features };
}

/**
 * 数据里出现过哪些 `locType`。
 *
 * **这是给人看的，不是给代码用的。** 分色规则要按真实取值来定，而我写这一版时
 * 手上没有这个库的读权限，无从知道汇编到底发布了哪几种类型。所以先把它们打出
 * 来 —— 看到实际取值之后，再把分色从「一个默认色」细化成一张表。
 */
export function distinctLocTypes(graph: AirwayGraph): string[] {
  const seen = new Set<string>();
  for (const meta of Object.values(graph.airways)) {
    if (meta.locType) seen.add(meta.locType);
  }
  return [...seen].sort();
}

/**
 * 航路点：把图的 `fixes` 转成点要素。
 *
 * 这是**航路网自己的点集**（`fir IS NULL` 的那一份，约 2,300 个），不是全国所有
 * 航路点 —— can-db 的注释里专门解释过为什么两者不能混：ident 不唯一，267 个名字
 * 对应不止一个物理点，用全量去铺会把 21,204 行塌成 10,335 个条目、最后一个赢。
 */
export function toAirwayFixes(graph: AirwayGraph): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Object.entries(graph.fixes).map(([ident, [lat, lon]]) => ({
      type: "Feature",
      properties: { ident },
      // fixes 是 [lat, lon]，GeoJSON 要 [lon, lat]。
      geometry: { type: "Point", coordinates: [lon, lat] },
    })),
  };
}
