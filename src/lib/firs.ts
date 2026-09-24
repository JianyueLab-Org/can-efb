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

/**
 * 标注线：边界折成若干段，每段带 `labelEdge` 和 `inside`。`fir-labels` 只画这些，
 * `fir-line` 不画这些。
 *
 * 做法照 Jeppesen 航路图：名字写在边界线旁边，写在**自己那一侧**。相邻两个情报区
 * 共用的那条边各出一段，同一条几何、同一个走向，所以两边的字并排落在同一处。
 *
 * - 每段都朝东走（正南北的朝南），字因此在正北朝上时是正的；`inside` 说范围在走向
 *   的左边（`left`，字在线上方）还是右边（`right`，字在线下方）。
 * - 转角超过 `RUN_MAX_TURN` 或走向要掉头的地方断开，所以一段之内朝向不变。
 * - 图层关了 `text-keep-upright`：开着的话 MapLibre 在地图转过去时把字翻过来，偏移
 *   跟着翻到另一侧，名字就写进了邻区。
 */
export function firLabelEdges(features: Feature[]): Feature[] {
  const edges: Feature[] = [];
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
        for (const run of ringRuns(ring, index > 0)) {
          edges.push({
            type: "Feature",
            properties: { code, name, labelEdge: true, inside: run.inside },
            geometry: { type: "LineString", coordinates: run.coordinates },
          });
        }
      });
    }
  }
  return edges;
}

type Run = { coordinates: Position[]; inside: "left" | "right" };

/** 墨卡托下的 y，和经度同一个单位：方向和转角按屏幕上的算。 */
function mercatorY(lat: number): number {
  const rad = Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2)) / rad;
}

/** 环按走向切成段。`hole` 是内环：范围在它外面。 */
function ringRuns(ring: Position[], hole: boolean): Run[] {
  // 鞋带公式：正的是逆时针，范围在走向左边。
  let area = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  const insideLeft = area > 0 !== hole;

  const runs: Run[] = [];
  let current: Position[] = [];
  let currentFlip = false;
  let currentAngle = 0;
  const flush = () => {
    if (current.length < 2) return;
    const coordinates = currentFlip ? [...current].reverse() : current;
    runs.push({
      coordinates,
      inside: insideLeft !== currentFlip ? "left" : "right",
    });
  };

  for (let i = 0; i + 1 < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[i + 1];
    const dx = bx - ax;
    const dy = mercatorY(by) - mercatorY(ay);
    if (dx === 0 && dy === 0) continue;
    // 朝西走的、正北走的反过来画。
    const flip = dx < 0 || (dx === 0 && dy > 0);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    let turn = Math.abs(angle - currentAngle);
    if (turn > 180) turn = 360 - turn;
    if (current.length > 0 && flip === currentFlip && turn <= RUN_MAX_TURN) {
      current.push(ring[i + 1]);
    } else {
      flush();
      current = [ring[i], ring[i + 1]];
      currentFlip = flip;
    }
    currentAngle = angle;
  }
  flush();
  return runs;
}
