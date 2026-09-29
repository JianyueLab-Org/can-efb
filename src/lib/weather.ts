/**
 * 降水图层：瓦片地址、瓦片坐标校验、图层失败的判定。
 *
 * 瓦片来自 can-api 的 `/api/v1/weather/precipitation/{z}/{x}/{y}`（OpenWeather 的
 * 降水图，can-api 已经重新着色成绿 → 红）。OpenWeather 的 key 在 can-api
 * （`OPENWEATHER_API_KEY`），这个站照旧一个 Secret 都没有。浏览器打的是本站的同源
 * 反代 `pages/api/v1/weather/precipitation/[z]/[x]/[y].ts`。
 *
 * 放在 lib 里是因为这几条错了不会被屏幕出卖：坐标校验放宽一点，反代就成了一个能拿
 * 任意路径去打 can-api 限流桶的跳板；失败判定认错一个 source，别的图层抖一下就把降
 * 水层关掉。
 */

/** can-api 只接 z 0..6，更大的回 400。MapLibre 按这个值往上放大（overzoom）。 */
export const WEATHER_MAX_ZOOM = 6;

/** 地图 source / layer 的 id，`lib/chartStyle.ts` 和 `RouteMap.vue` 共用。 */
export const WEATHER_SOURCE = "weather";

/** 浏览器打的瓦片地址模板，同源。 */
export const WEATHER_TILE_URL = "/api/v1/weather/precipitation/{z}/{x}/{y}";

/** 署名，只在图层开着时挂。OpenWeather 的使用条款要求。 */
export const WEATHER_ATTRIBUTION =
  'Weather © <a href="https://openweathermap.org/" target="_blank" rel="noreferrer">OpenWeather</a>';

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** 只认纯数字：`+1`、`1.0`、`1e0`、空串都不算。三位数足够（z ≤ 6 时 x、y < 64）。 */
const DIGITS = /^\d{1,3}$/;

/**
 * 路径里的三段 → 瓦片坐标。不合法（不是整数、z 超出 0..6、x / y 超出 0..2^z-1）
 * 一律 `null`，反代据此回 400，不去打 can-api。
 */
export function parseTile(
  z: string | undefined,
  x: string | undefined,
  y: string | undefined,
): TileCoord | null {
  if (!z || !x || !y) return null;
  if (!DIGITS.test(z) || !DIGITS.test(x) || !DIGITS.test(y)) return null;
  const tile = { z: Number(z), x: Number(x), y: Number(y) };
  if (tile.z > WEATHER_MAX_ZOOM) return null;
  const span = 2 ** tile.z;
  if (tile.x >= span || tile.y >= span) return null;
  return tile;
}

/**
 * can-api 上的路径（不带 `/api/v1/` 前缀），也是反代缓存键的路径部分。用解析后的
 * 数字拼，`03` 和 `3` 落在同一个键上。
 */
export function weatherTilePath(tile: TileCoord): string {
  return `weather/precipitation/${tile.z}/${tile.x}/${tile.y}`;
}

/**
 * 地图 `error` 事件是不是降水瓦片没取到。
 *
 * 404 MapLibre 自己咽掉，不会走到这里；平移时被取消的请求（`AbortError`）不算失败。
 * 其余的（503：can-api 没配 key 或额度用完；502：连不上）都算。
 */
export function isWeatherTileFailure(event: {
  sourceId?: unknown;
  error?: unknown;
}): boolean {
  if (event.sourceId !== WEATHER_SOURCE) return false;
  const error = event.error as { name?: unknown } | undefined;
  return error?.name !== "AbortError";
}
