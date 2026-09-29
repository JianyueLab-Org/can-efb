/**
 * 降水图层：瓦片地址、瓦片坐标校验、图层失败的判定。
 *
 * 另有：反代缓存时长与 `Cache-Control` 的换算、十分钟刷新的时间桶、图层「整层挂了」
 * 的判定。
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

/** 刷新周期，也是时间桶的宽度。按墙上时钟对齐，所有成员同一时刻拿到同一组地址。 */
export const WEATHER_REFRESH_MS = 600_000;

/** `now` 所在的时间桶：`floor(now / 10 分钟)`。 */
export function weatherBucket(now: number): number {
  return Math.floor(now / WEATHER_REFRESH_MS);
}

/** 离下一个时间桶边界还有多少毫秒（1..WEATHER_REFRESH_MS）。 */
export function msUntilNextBucket(now: number): number {
  return (weatherBucket(now) + 1) * WEATHER_REFRESH_MS - now;
}

/**
 * 带时间桶的瓦片地址模板：`…/{z}/{x}/{y}?t=<桶>`。反代的缓存键和上游请求都不带
 * 查询串，`t` 只让浏览器和 MapLibre 换一组地址。
 */
export function weatherTileUrl(bucket: number): string {
  return `${WEATHER_TILE_URL}?t=${bucket}`;
}

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

// ------------------------------------------------------------ 反代缓存时长

/** 反代缓存一张瓦片最多多久（秒）。上游没给或给不出数时也用它。 */
export const WEATHER_CACHE_MAX_S = 600;

/** 从反代缓存回给浏览器的 `max-age` 下限（秒）。 */
export const WEATHER_CACHE_MIN_S = 30;

const MAX_AGE = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i;

/** `Cache-Control` 里的 `max-age`（秒）。没有、不是非负整数都回 `null`。 */
export function parseMaxAge(
  cacheControl: string | null | undefined,
): number | null {
  if (!cacheControl) return null;
  const match = MAX_AGE.exec(cacheControl);
  return match ? Number(match[1]) : null;
}

/**
 * 反代缓存这张瓦片多少毫秒：上游 `max-age`，缺失或解析不了按 600 秒，上限 600 秒。
 * 0 表示不缓存。
 */
export function weatherCacheTtlMs(
  cacheControl: string | null | undefined,
): number {
  const seconds = parseMaxAge(cacheControl) ?? WEATHER_CACHE_MAX_S;
  return Math.min(seconds, WEATHER_CACHE_MAX_S) * 1000;
}

/** 缓存条目还剩多少秒，向上取整，下限 30。 */
export function remainingMaxAge(expiresAt: number, now: number): number {
  return Math.max(WEATHER_CACHE_MIN_S, Math.ceil((expiresAt - now) / 1000));
}

/**
 * 把 `Cache-Control` 的 `max-age` 换成 `seconds`，其余指令原样。没有这个头、或头里
 * 没有 `max-age` 时回 `public, max-age=<seconds>` / 末尾补一条。
 */
export function withMaxAge(
  cacheControl: string | null | undefined,
  seconds: number,
): string {
  if (!cacheControl) return `public, max-age=${seconds}`;
  const directives = cacheControl
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
  let found = false;
  const out = directives.map((d) => {
    if (/^max-age\s*=/i.test(d)) {
      found = true;
      return `max-age=${seconds}`;
    }
    return d;
  });
  if (!found) out.push(`max-age=${seconds}`);
  return out.join(", ");
}

// ------------------------------------------------------------ 整层挂了的判定

/** 一阵加载里至少这么多张失败、且一张都没成功，判整层挂了。 */
export const WEATHER_DOWN_FAILURES = 3;

/** 两次瓦片结果间隔超过这个毫秒数，算新的一阵。 */
export const WEATHER_BURST_GAP_MS = 5_000;

/** can-api 没配 OpenWeather key 时 503 的错误码。见到一次就判整层挂了。 */
export const WEATHER_NOT_CONFIGURED = "not_configured";

/** 一阵加载的计数。`null` 表示还没有、或刚被重置。 */
export interface WeatherBurst {
  /** 这一阵最后一次结果的时间。 */
  last: number;
  failures: number;
  successes: number;
}

export type WeatherTileOutcome =
  | { ok: true }
  | { ok: false; /** 响应体里的 `error`，读得到才有。 */ code?: string };

/**
 * 记一张瓦片的结果，回新的计数和这一层是不是整层挂了。
 *
 * 挂了：`not_configured`；或这一阵里失败 ≥ 3 张且没有成功的。其余失败只让那一张
 * 空着。距上一次结果超过 5 秒另起一阵。
 */
export function noteWeatherTile(
  burst: WeatherBurst | null,
  outcome: WeatherTileOutcome,
  now: number,
): { burst: WeatherBurst; down: boolean } {
  const fresh =
    !burst || now - burst.last > WEATHER_BURST_GAP_MS
      ? { last: now, failures: 0, successes: 0 }
      : { ...burst, last: now };
  if (outcome.ok) {
    fresh.successes += 1;
    return { burst: fresh, down: false };
  }
  fresh.failures += 1;
  const down =
    outcome.code === WEATHER_NOT_CONFIGURED ||
    (fresh.failures >= WEATHER_DOWN_FAILURES && fresh.successes === 0);
  return { burst: fresh, down };
}

/**
 * 失败瓦片响应体里的错误码（can-api 的 `{"error": "...", "message": "..."}`）。
 * MapLibre 的 `AJAXError` 把响应体放在 `body`（Blob）。读不到、不是 JSON 都回
 * `undefined`。
 */
export async function weatherErrorCode(
  error: unknown,
): Promise<string | undefined> {
  const body = (error as { body?: unknown } | undefined)?.body;
  if (!body || typeof (body as Blob).text !== "function") return undefined;
  try {
    const parsed = JSON.parse(await (body as Blob).text()) as {
      error?: unknown;
    };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}
