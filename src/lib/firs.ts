/**
 * 飞行情报区边界。
 *
 * ## 这一层不走 can-db
 *
 * 站里其余空域（扇区、限制区）都从 can-db 取，唯独情报区不是，而且是**故意的**：
 *
 * **汇编没有发布完整的情报区边界。** 它给的是边界国内一侧的折线，首尾标着「是国境
 * 点」，其余沿国境线走 —— 而国境线不在那份数据里。照 seq 闭合成环就等于在国境线该
 * 在的地方切一条直线：乌鲁木齐全区只有 6 个顶点（VATSpy 那份 275 个），那条弦直接
 * 横穿新疆。**它不报错，看起来还挺像回事**，这才是麻烦的地方。
 *
 * 用的是 VATSpy 那份（经 `scripts/build-firs.mjs` 处理），边界是描好的完整轮廓，还
 * 自带标注位置。can-radar 画管制区边界用的是同一份数据 —— 两个站的边界因此对得上，
 * 而不是各画各的。
 *
 * ## 由此还带来两件事
 *
 * **不需要登录也看得到。** 它是随站点发的静态文件，不是 can-db 的接口 —— 没有
 * `aipAccess` 的成员打开 EFB 也有边界可看，而这一层是默认开的。
 *
 * **必须署名。** VATSpy 是 CC BY-SA 4.0，`RouteMap.vue` 的 `attributionControl`
 * 因此是开着的。换这份数据之前它是关的，理由是 Natural Earth 属公有领域 —— 那个理
 * 由不再成立。
 */
import type { Feature, FeatureCollection, Position } from "geojson";

/**
 * **从 `src/` 里 `?url` 引进来，不放 `public/`** —— 理由和陆地那份一样，完整写在
 * `RouteMap.vue` 的 `LAND_URL` 上面：`public/` 下的固定名字只能拿到
 * `max-age=0`，而 `_astro/` 下的哈希名字拿到一年的 immutable，浏览器因此不再重复
 * 下载。那里也记了两件容易踩的事：量这个头必须用 GET 而不是 `curl -I`，以及边缘
 * 缓存还需要一条 Cloudflare 的 Cache Rule。
 */
import FIRS_URL from "@/basemap/firs.json?url";

/** 取过就不再取：这份文件是静态的，一个周期内不会变。 */
let cache: FeatureCollection | null = null;

export async function fetchFIRs(): Promise<FeatureCollection> {
  if (cache) return cache;
  const response = await fetch(FIRS_URL);
  if (!response.ok) throw new Error(`firs: ${response.status}`);
  cache = (await response.json()) as FeatureCollection;
  return cache;
}

/**
 * 情报区图层要画的那部分（`fir`）：不含区调，日本是拼好的一整块 `RJJJ`。
 *
 * 另一部分留给实时那一层圈在线席位。判据在 `scripts/build-firs.mjs` 的「两个标记」。
 */
export function firBoundaries(
  collection: FeatureCollection,
): FeatureCollection {
  const boundaries = collection.features.filter(
    (feature) => feature.properties?.fir !== false,
  );
  return {
    ...collection,
    features: [...boundaries, ...firLabelEdges(boundaries)],
  };
}

/** 一段标注线里相邻两条边的方向最多差这么多度，再大就断开另起一段。 */
const RUN_MAX_TURN = 30;

/** 顶点落在别人的边上、两点算同一点的容差，度。 */
const EPS = 1e-4;

/**
 * 标注线：边界折成若干段，每段带 `labelEdge` 和 `inside`。`fir-labels` 只画这些，
 * `fir-line` 不画这些。
 *
 * 做法照 Jeppesen 航路图：名字写在边界线旁边，写在**自己那一侧**，共用边界上两边的
 * 名字并排。
 *
 * - **并排靠同一条几何。** 两个情报区描同一条边界时顶点常常不一样（一边在中间多一
 *   个点，那是第三个区的角）。所以先把每条边在别的环的顶点处切开，切完两边的小段
 *   就一一对得上；再按「两侧各是谁」连成段。
 * - **一段一个标注。** 两侧都有区就是两行，上行是线上方那一侧，骑在线上（`inside:
 *   both`），所以沿线重复时两个名字总在一起。分成两个要素不行：`line` 放置的第一个
 *   锚点按字长算，两边名字长短不一，锚点就错开。同一侧有几个区（数据里有重叠的）
 *   用「 / 」连起来。
 * - 每段都朝东走（正南北的朝南），字因此在正北朝上时是正的；只有一侧有区时
 *   `inside` 说它在走向的左边（`left`，字在线上方）还是右边（`right`，字在线下方）。
 * - 转角超过 `RUN_MAX_TURN`、走向掉头、两侧换了人或者有岔路的地方断开。
 * - 图层关了 `text-keep-upright`：开着的话 MapLibre 在地图转过去时把字翻过来，偏移
 *   跟着翻到另一侧，名字就写进了邻区。
 */
export function firLabelEdges(features: Feature[]): Feature[] {
  const rings: { ring: Position[]; insideLeft: boolean; label: Label }[] = [];
  for (const feature of features) {
    const { code, name } = feature.properties ?? {};
    if (!code) continue;
    const geometry = feature.geometry;
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : [];
    for (const polygon of polygons) {
      polygon.forEach((ring, index) => {
        // 鞋带公式：正的是逆时针，范围在走向左边。内环反过来。
        let area = 0;
        for (let i = 0; i + 1 < ring.length; i++) {
          area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        rings.push({
          ring,
          insideLeft: area > 0 !== index > 0,
          label: { code, name },
        });
      });
    }
  }

  const grid = vertexGrid(rings.map((r) => r.ring));

  // 切开、朝东、按端点去重：同一条小段两边的情报区记在一起。
  const edges = new Map<string, Edge>();
  for (const { ring, insideLeft, label } of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const pieces = splitAt(ring[i], ring[i + 1], grid);
      for (let j = 0; j + 1 < pieces.length; j++) {
        let a = pieces[j];
        let b = pieces[j + 1];
        if (key(a) === key(b)) continue;
        const dx = b[0] - a[0];
        const dy = mercatorY(b[1]) - mercatorY(a[1]);
        // 朝西走的、正北走的反过来画。
        const flip = dx < 0 || (Math.abs(dx) < EPS && dy > 0);
        if (flip) [a, b] = [b, a];
        const id = `${key(a)}>${key(b)}`;
        let edge = edges.get(id);
        if (!edge) {
          edge = { a, b, angle: angleOf(a, b), sides: [] };
          edges.set(id, edge);
        }
        const inside = insideLeft !== flip ? "left" : "right";
        if (
          !edge.sides.some((s) => s.code === label.code && s.inside === inside)
        ) {
          edge.sides.push({ ...label, inside });
        }
      }
    }
  }

  // 按「两侧各是谁」连成段。
  const signature = (e: Edge) =>
    e.sides
      .map((s) => `${s.code}:${s.inside}`)
      .sort()
      .join("|");
  const starts = new Map<string, Edge[]>();
  const ends = new Map<string, Edge[]>();
  for (const edge of edges.values()) {
    const sig = signature(edge);
    push(starts, `${key(edge.a)}|${sig}`, edge);
    push(ends, `${key(edge.b)}|${sig}`, edge);
  }
  const next = (edge: Edge): Edge | null => {
    const sig = signature(edge);
    const out = starts.get(`${key(edge.b)}|${sig}`) ?? [];
    const into = ends.get(`${key(edge.b)}|${sig}`) ?? [];
    if (out.length !== 1 || into.length !== 1) return null;
    return turn(edge.angle, out[0].angle) <= RUN_MAX_TURN ? out[0] : null;
  };
  const hasPrev = new Set<Edge>();
  for (const edge of edges.values()) {
    const n = next(edge);
    if (n && n !== edge) hasPrev.add(n);
  }

  const result: Feature[] = [];
  const used = new Set<Edge>();
  const emit = (first: Edge) => {
    const coordinates: Position[] = [first.a];
    let edge: Edge | null = first;
    while (edge && !used.has(edge)) {
      used.add(edge);
      coordinates.push(edge.b);
      edge = next(edge);
    }
    // 一段只出一个标注：同一侧的区（数据里有重叠的）用「 / 」连起来，两侧都有就是
    // 两行，上行是线上方那一侧。两行骑在线上，这样两边的名字总是并排。
    const side = (inside: Side["inside"]) =>
      first.sides
        .filter((s) => s.inside === inside)
        .map(labelText)
        .join(" / ");
    const left = side("left");
    const right = side("right");
    result.push({
      type: "Feature",
      properties: {
        label: left && right ? `${left}\n${right}` : left || right,
        labelEdge: true,
        inside: left && right ? "both" : left ? "left" : "right",
      },
      geometry: { type: "LineString", coordinates },
    });
  };
  // 先从段头开始，剩下的是首尾相接的环。
  for (const edge of edges.values()) if (!hasPrev.has(edge)) emit(edge);
  for (const edge of edges.values()) if (!used.has(edge)) emit(edge);
  return result;
}

type Label = { code: string; name?: string };

/** 「代号 名字」（`RKRR INCHEON`），没有名字只写代号。 */
function labelText({ code, name }: Label): string {
  return name ? `${code} ${name.toUpperCase()}` : code;
}
type Side = Label & { inside: "left" | "right" };
type Edge = { a: Position; b: Position; angle: number; sides: Side[] };

function push<T>(map: Map<string, T[]>, k: string, value: T) {
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
}

function key([lon, lat]: Position): string {
  return `${Math.round(lon / EPS)},${Math.round(lat / EPS)}`;
}

/** 墨卡托下的 y，和经度同一个单位：方向和转角按屏幕上的算。 */
function mercatorY(lat: number): number {
  const rad = Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2)) / rad;
}

function angleOf(a: Position, b: Position): number {
  return (
    (Math.atan2(mercatorY(b[1]) - mercatorY(a[1]), b[0] - a[0]) * 180) / Math.PI
  );
}

function turn(from: number, to: number): number {
  const d = Math.abs(from - to);
  return d > 180 ? 360 - d : d;
}

const CELL = 0.5;

/** 所有顶点按 0.5° 格子分桶，切边时只看边经过的格子。 */
function vertexGrid(rings: Position[][]): Map<string, Position[]> {
  const grid = new Map<string, Position[]>();
  const seen = new Set<string>();
  for (const ring of rings) {
    for (const p of ring) {
      const k = key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      push(grid, `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`, p);
    }
  }
  return grid;
}

/** 边 a→b 在落在它上面的别的顶点处切开，按离 a 的远近排好，首尾是 a 和 b。 */
function splitAt(
  a: Position,
  b: Position,
  grid: Map<string, Position[]>,
): Position[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return [a, b];
  const hits: { t: number; p: Position }[] = [];
  const x0 = Math.floor((Math.min(a[0], b[0]) - EPS) / CELL);
  const x1 = Math.floor((Math.max(a[0], b[0]) + EPS) / CELL);
  const y0 = Math.floor((Math.min(a[1], b[1]) - EPS) / CELL);
  const y1 = Math.floor((Math.max(a[1], b[1]) + EPS) / CELL);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (const p of grid.get(`${x},${y}`) ?? []) {
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2;
        if (t <= 0 || t >= 1) continue;
        const ex = a[0] + t * dx - p[0];
        const ey = a[1] + t * dy - p[1];
        if (ex * ex + ey * ey > EPS * EPS) continue;
        hits.push({ t, p });
      }
    }
  }
  hits.sort((m, n) => m.t - n.t);
  return [a, ...hits.map((h) => h.p), b];
}
