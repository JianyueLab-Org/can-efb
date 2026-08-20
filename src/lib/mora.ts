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

/** 视野框 → 覆盖它的那些块的左下角。 */
export function blocksFor(
  south: number,
  west: number,
  north: number,
  east: number,
): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = [];
  const floor = (v: number) => Math.floor(v / MORA_BLOCK) * MORA_BLOCK;
  for (let lat = floor(south); lat <= floor(north); lat += MORA_BLOCK) {
    for (let lon = floor(west); lon <= floor(east); lon += MORA_BLOCK) {
      // 网格本身是 lat -89..90 / lon -180..179，超出的块直接不要 —— 请求出去
      // 只会换回一个 400。
      if (lat < -89 || lat > 90 || lon < -180 || lon > 179) continue;
      out.push({ lat, lon });
    }
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
