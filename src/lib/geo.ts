/**
 * 球面几何。**逐字取自 can-radar 的 `src/lib/radar.ts`**（只拿了这三样：
 * `LatLon`、`distanceNm`、`greatCircle`），注释一并保留成英文原文。
 *
 * 为什么是复制而不是抽包：两个站分属不同仓库、不同 CI，为三个纯函数拉一条发布
 * 通道不划算。代价是可能各改各的 —— 但这三个函数是封闭的数学，没有产品需求会
 * 推着它们变，唯一会变的是发现算错了，而那时两边都得改，跨仓库的包也拦不住。
 *
 * 改这里之前先看 can-radar 那一份，两边要一起动。
 */

export type LatLon = [lat: number, lon: number];

/** Great-circle distance in nautical miles. */
export function distanceNm(from: LatLon, to: LatLon): number {
  const EARTH_RADIUS_NM = 3440.065;
  const rad = Math.PI / 180;

  const dLat = (to[0] - from[0]) * rad;
  const dLon = (to[1] - from[1]) * rad;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from[0] * rad) * Math.cos(to[0] * rad) * Math.sin(dLon / 2) ** 2;

  return EARTH_RADIUS_NM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Points along the great circle between two coordinates.
 *
 * A straight line on a Mercator map is not the path an aircraft flies —
 * ZBAA to KLAX bows a long way north of it — so a route leg is drawn as an
 * interpolated arc. This is spherical linear interpolation, the same shape
 * turf's `greatCircle` produces for vatsim-radar, without the dependency.
 *
 * Longitudes come back unwrapped (they may run past ±180) so a leg crossing
 * the antimeridian draws as one line instead of snapping back across the
 * whole map.
 */
export function greatCircle(from: LatLon, to: LatLon, points = 64): LatLon[] {
  const rad = Math.PI / 180;
  const [lat1, lon1] = [from[0] * rad, from[1] * rad];

  // Take the shorter way round before interpolating.
  let lon2 = to[1];
  while (lon2 - from[1] > 180) lon2 -= 360;
  while (lon2 - from[1] < -180) lon2 += 360;
  const [lat2, lon2rad] = [to[0] * rad, lon2 * rad];

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2rad - lon1) / 2) ** 2,
      ),
    );

  // Coincident, or close enough that the arc and the chord are the same line.
  if (!Number.isFinite(d) || d < 1e-9) return [from, [to[0], lon2]];

  const path: LatLon[] = [];
  for (let i = 0; i <= points; i++) {
    const f = i / points;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);

    const x =
      a * Math.cos(lat1) * Math.cos(lon1) +
      b * Math.cos(lat2) * Math.cos(lon2rad);
    const y =
      a * Math.cos(lat1) * Math.sin(lon1) +
      b * Math.cos(lat2) * Math.sin(lon2rad);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);

    path.push([
      Math.atan2(z, Math.sqrt(x * x + y * y)) / rad,
      Math.atan2(y, x) / rad,
    ]);
  }

  // Undo the ±180 wrap atan2 reintroduces.
  for (let i = 1; i < path.length; i++) {
    while (path[i][1] - path[i - 1][1] > 180) path[i][1] -= 360;
    while (path[i][1] - path[i - 1][1] < -180) path[i][1] += 360;
  }

  return path;
}

/** Enough interpolation to bend a long leg, none wasted on a short one. */
export function arc(from: LatLon, to: LatLon): LatLon[] {
  const distance = distanceNm(from, to);
  if (distance < 60) return [from, to];
  return greatCircle(from, to, Math.min(64, Math.ceil(distance / 60)));
}
