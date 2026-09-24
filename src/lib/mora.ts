/**
 * Grid MORA —— 航图上每个一度格子里那个绿数字。
 *
 * ## 它答的是航路答不了的那个问题
 *
 * 航路的 MTCA 只覆盖航路两侧那条走廊，**偏离航路就没有数了** —— 而雷达引导、绕
 * 飞积雨云、备降改航恰恰都发生在走廊之外。Grid MORA 铺满全图，一格一个数。
 *
 * ## 格子怎么定位
 *
 * 一格覆盖 `[lat-1, lat] × [lon, lon+1]` —— **纬度是北边，经度是西边**，即西北
 * 角。这个不对称来自源数据的位图扫描顺序，can-db 的 0018 迁移里有对齐的证据。
 *
 * 所以标注画在 `(lat - 0.5, lon + 0.5)`。**把它画在 (lat, lon) 上会整体偏半格**，
 * 而那种错误在屏幕上完全看不出来 —— 数字还是那些数字，只是挪到了隔壁山头。
 */
import type { Feature, FeatureCollection } from "geojson";

import { unwrapList } from "@/lib/aip";
import { wrapLon } from "@/lib/mapText";

export interface MORACell {
  /** 格子北边纬度。 */
  lat: number;
  /** 格子西边经度。 */
  lon: number;
  /** **英尺**，不是米 —— 这一列和库里其余高度反过来，因为航图印的是英尺。 */
  moraFt: number;
}

/**
 * can-db 那边一次最多给 60 度见方。这里按 10 度分块取，块内整块缓存。
 *
 * 分块不是为了绕过上限，是为了**平移时不重取**：视野挪一点点就换一个框的话，
 * 每一次拖动都是一个新请求，而格子本身是固定不动的。
 */
export const MORA_BLOCK = 10;

/**
 * 视野框 → 覆盖它的那些块的左下角。
 *
 * **经度是 MapLibre 原样给的展开值**（`getBounds()` 平移过日界线后是 `170..190`，
 * 往西是 `-200..-170`），这里折回 [-180, 180) 再取块。不折的话 180° 以东的块全被
 * 当成越界扔掉，图上日界线那一侧整片没有 MORA，而那看起来像那边没有数据。
 *
 * 返回的块经度一律是折回后的真实值：取数按它发，缓存按它记，同一块从哪个世界副本
 * 看过去都是同一个键。标注落在格子的真实经度上，MapLibre 默认的世界副本
 * （`renderWorldCopies`）会把它画到视野旁边那一份上。
 *
 * 视野横跨 360° 以上（缩到最小时）就是整圈，不再逐块走 —— 否则同一块会被数好几遍。
 */
export function blocksFor(
  south: number,
  west: number,
  north: number,
  east: number,
): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [];
  const floor = (v: number) => Math.floor(v / MORA_BLOCK) * MORA_BLOCK;
  const [from, to] =
    east - west >= 360 ? [-180, 180 - MORA_BLOCK] : [floor(west), floor(east)];
  const lons = new Set<number>();
  // 块边界是 10 的倍数，360 也是，所以折回之后仍然对齐在块边界上。
  for (let lon = from; lon <= to; lon += MORA_BLOCK) lons.add(wrapLon(lon));
  for (let lat = floor(south); lat <= floor(north); lat += MORA_BLOCK) {
    // 网格本身是 lat -89..90（格子的北边）。`-90` 那一块覆盖北边 -89..-81 的格子，
    // 取数时下界会收到 -89，所以要留着；整块落在 -90 以南或 90 以北的才扔 ——
    // 请求出去只会换回一个 400。
    if (lat < -90 || lat > 90) continue;
    for (const lon of lons) out.push({ lat, lon });
  }
  return out;
}

export async function fetchMORABlock(
  lat: number,
  lon: number,
): Promise<MORACell[]> {
  // 块的四角。上界收在网格边界内，否则 can-db 会拒。
  const minLat = Math.max(lat, -89);
  const maxLat = Math.min(lat + MORA_BLOCK, 90);
  const minLon = Math.max(lon, -180);
  const maxLon = Math.min(lon + MORA_BLOCK, 179);
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;

  const response = await fetch(
    `/api/db/aip/mora?bbox=${encodeURIComponent(bbox)}`,
  );
  if (!response.ok) throw new Error(`mora ${bbox}: ${response.status}`);
  return unwrapList<MORACell>(await response.json());
}

/**
 * 格子 → 标注点。
 *
 * 千位和百位分开成两个属性，因为航图上它们**不是一个字号**：千位大、百位小。
 * 拼成一个字符串就没法再分开排版了。
 */
export function toMORAPoints(cells: MORACell[]): FeatureCollection {
  const features: Feature[] = cells.map((c) => ({
    type: "Feature",
    properties: {
      // 15000 → "15" + "0"；5100 → "5" + "1"。
      thousands: String(Math.floor(c.moraFt / 1000)),
      hundreds: String(Math.floor((c.moraFt % 1000) / 100)),
    },
    geometry: {
      type: "Point",
      // 见文件顶上：格子由西北角定位，标注落在格心。
      coordinates: [c.lon + 0.5, c.lat - 0.5],
    },
  }));
  return { type: "FeatureCollection", features };
}
