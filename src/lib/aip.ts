import type { Feature, FeatureCollection, Position } from "geojson";

/**
 * 导航台与空域：从 can-db 取回来，转成地图能画的东西。
 *
 * 和 `lib/airways.ts` 是同一条路子（走本站的 can-db 反代、失败抛出而不是给空
 * 图）。分成两个文件是因为它们是两批独立的图层，各自可以单独开关。
 */

// ---------------------------------------------------------------- 导航台

/**
 * 拆信封。can-db 大部分接口包着 `{status, data}`，少数裸奔 —— 两种都收，调用方
 * 只面对一种形状。
 *
 * 拿 `unknown` 进来再收窄，而不是写一个 `{data?: T[]} & T[]` 的交叉类型：那种写
 * 法在 `Array.isArray` 收窄之后就访问不到 `.data` 了，编译器是对的，是类型写错
 * 了。
 */
export function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const data = (body as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

export interface Navaid {
  ident: string;
  kind: string | null;
  name: string | null;
  lat: number;
  lon: number;
  /** VOR/DME 用兆赫。 */
  freqMhz: number | null;
  /** NDB 用千赫。 */
  freqKhz: number | null;
  channel: string | null;
  magVar: number | null;
  /** **米。** */
  elevM: number | null;
  servedAirport: string | null;
  inAirway: boolean;
}

export async function fetchNavaids(): Promise<Navaid[]> {
  const response = await fetch("/api/db/aip/navaids");
  if (!response.ok) throw new Error(`navaids: ${response.status}`);
  return unwrapList<Navaid>(await response.json());
}

/**
 * 导航台的标注，形如 `YANGZHOU D 113.1 SJD`。
 *
 * 这个格式是照航图上的写法来的：**台名 · D 频率 · 识别码**。`D` 是 DME —— 只有
 * 带兆赫频率的才这么写；NDB 只有千赫，写成 `名字 识别码 频率`，不冒充 DME。
 *
 * 频率不补零也不四舍五入：汇编上印的是 `113` 就是 `113`，印的是 `113.1` 就是
 * `113.1`。把 113 显示成 113.0 是在原文上添东西，而频率是要照着调的。
 */
export function navaidLabel(n: Navaid): string {
  const name = n.name ?? n.ident;
  if (n.freqMhz != null) return `${name} D ${n.freqMhz} ${n.ident}`;
  if (n.freqKhz != null) return `${name} ${n.ident} ${n.freqKhz}`;
  return `${name} ${n.ident}`;
}

export function toNavaidPoints(list: Navaid[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: list.map((n) => ({
      type: "Feature",
      properties: { ident: n.ident, label: navaidLabel(n) },
      geometry: { type: "Point", coordinates: [n.lon, n.lat] },
    })),
  };
}

// ---------------------------------------------------------------- 空域

export type AirspaceFamily = "fir" | "restricted" | "special" | "controlled";

export interface Airspace {
  family: string;
  code: string | null;
  kind: string | null;
  localType: string | null;
  name: string | null;
  reason: string | null;
  activeTime: string | null;
  note: string | null;
  /** **米。** 图上标的是英尺，换算见 verticalLabel。 */
  lowerM: number | null;
  upperM: number | null;
  /** "polygon" 或 "circle"。 */
  shape: string;
  centreLat: number | null;
  centreLon: number | null;
  radiusKm: number | null;
  /** [lat, lon]，已按 seq 排好；circle 的是空的。 */
  vertices: [number, number][];
  airac: string;
}

export async function fetchAirspaces(
  family: AirspaceFamily,
): Promise<Airspace[]> {
  const response = await fetch(`/api/db/aip/airspaces?family=${family}`);
  if (!response.ok) throw new Error(`airspaces ${family}: ${response.status}`);
  return unwrapList<Airspace>(await response.json());
}

/** 米 → 英尺。航图标的是英尺，库里存的是米。 */
const FT_PER_M = 3.280839895;

/**
 * 垂直范围标注，形如 `GND-41100`、`19700-41100`。
 *
 * **单位要换**：库里是米（汇编按米发布），航图标英尺。换算只写在这一处 —— 散在
 * 各个组件里迟早有一处忘了乘，而那种错误画出来完全正常。
 *
 * 下限为 0 或空写 `GND`（地面），上限为空写 `UNLTD`（不封顶）—— 这两个词是航图
 * 上的写法，不是我发明的缩写。
 */
export function verticalLabel(a: Airspace): string {
  const lower =
    a.lowerM == null || a.lowerM === 0
      ? "GND"
      : String(Math.round(a.lowerM * FT_PER_M));
  const upper =
    a.upperM == null || a.upperM === 0
      ? "UNLTD"
      : String(Math.round(a.upperM * FT_PER_M));
  return `${lower}-${upper}`;
}

/**
 * 圆形空域转成多边形。
 *
 * **不能当成「顶点还没导进来」跳过**：汇编里相当一部分禁区、危险区就是用圆心加
 * 半径发布的，跳过它们等于屏幕上缺一块空域而没有任何报错。
 *
 * 64 段：在这张图的缩放范围内，再细肉眼看不出，再粗能看出多边形的角。
 */
function circleRing(
  lat: number,
  lon: number,
  radiusKm: number,
  segments = 64,
): Position[] {
  const ring: Position[] = [];
  // 一度纬度约 111.32 km；经度要按纬度收窄，否则高纬度上圆会被压扁成椭圆。
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return ring;
}

/**
 * 空域转成多边形要素。
 *
 * 顶点不足以成面的（少于 3 个）直接丢掉：画一条线冒充一块空域，比不画糟得多。
 */
export function toAirspacePolygons(list: Airspace[]): FeatureCollection {
  const features: Feature[] = [];
  let dropped = 0;

  for (const a of list) {
    let ring: Position[] | null = null;

    if (
      a.shape === "circle" &&
      a.centreLat != null &&
      a.centreLon != null &&
      a.radiusKm
    ) {
      ring = circleRing(a.centreLat, a.centreLon, a.radiusKm);
    } else if (a.vertices.length >= 3) {
      // vertices 是 [lat, lon]，GeoJSON 要 [lon, lat]。
      ring = a.vertices.map(([lat, lon]) => [lon, lat] as Position);
      // 环必须闭合。
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    }

    if (!ring) {
      dropped++;
      continue;
    }

    features.push({
      type: "Feature",
      properties: {
        family: a.family,
        code: a.code ?? a.name ?? "",
        localType: a.localType ?? "",
        vertical: verticalLabel(a),
        activeTime: a.activeTime ?? "",
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  if (dropped) {
    console.warn(`[efb:map] 空域没有可用几何，丢弃 ${dropped} 块`);
  }
  return { type: "FeatureCollection", features };
}
