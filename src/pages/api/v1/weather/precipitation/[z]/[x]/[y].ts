import type { APIRoute } from "astro";
import { CAN_API_ORIGIN } from "@/lib/config";
import {
  parseTile,
  remainingMaxAge,
  weatherCacheTtlMs,
  weatherTilePath,
  withMaxAge,
} from "@/lib/weather";
import { ResponseCache, cacheKey } from "@/server/responseCache";
import { fetchHeadersWithin } from "@/server/upstreamFetch";

export const prerender = false;

/**
 * 降水瓦片的同源反代：`/api/v1/weather/precipitation/{z}/{x}/{y}` → can-api 同一路径。
 *
 * 谁在用：`RouteMap.vue` 的降水图层（`lib/chartStyle.ts` 里的 `weather` source）。
 *
 * 不进 `[...path].ts` 的白名单：那张表按整条路径精确匹配，瓦片路径带 z/x/y。这里是
 * 单独一条窄路由 —— 只接 GET、z/x/y 先按 `parseTile` 校验（z 0..6，x/y 在这一级
 * 范围内），不合法回 400，不去打 can-api。Astro 里具名参数的路由优先于 `[...path]`。
 *
 * 不转发 cookie：瓦片与请求者无关，can-api 这条路由也不看会话。OpenWeather 的 key 在
 * can-api（`OPENWEATHER_API_KEY`），这个站不持有。
 *
 * 成功的响应在本进程缓存上游 `max-age` 那么久（缺失或解析不了按 600 秒，上限 600
 * 秒，0 不缓存），键只由 z/x/y 组成；非 2xx 不缓存。查询串（地图带的时间桶 `?t=`）
 * 不进缓存键，也不转给 can-api。`Cache-Control` 原样交给浏览器；从缓存回时
 * `max-age` 改成条目的剩余秒数（下限 30）。换算在 `lib/weather.ts`。
 */

/** z 0..6 一共 5461 张，常看的是中国周边几级，1000 张够用。 */
const cache = new ResponseCache(1000);

const PASS_THROUGH = ["content-type", "cache-control"];

export const GET: APIRoute = async (context) => {
  const tile = parseTile(context.params.z, context.params.x, context.params.y);
  if (!tile) {
    return Response.json(
      { error: "bad_tile", message: "瓦片坐标不合法（z 0..6）。" },
      { status: 400 },
    );
  }

  const path = weatherTilePath(tile);
  const key = cacheKey(path, new URLSearchParams());
  const hit = cache.get(key);
  const expires = cache.expiresAt(key);
  if (hit && expires !== undefined) {
    const maxAge = remainingMaxAge(expires, Date.now());
    const headers = hit.headers.filter(([name]) => name !== "cache-control");
    const upstreamCc = hit.headers.find(([name]) => name === "cache-control");
    headers.push(["cache-control", withMaxAge(upstreamCc?.[1], maxAge)]);
    return new Response(hit.body.slice(0), { status: hit.status, headers });
  }

  let upstream: Response;
  try {
    // 超时只管到头到达为止 —— 理由见 server/upstreamFetch.ts。
    upstream = await fetchHeadersWithin(
      `${CAN_API_ORIGIN}/api/v1/${path}`,
      { method: "GET" },
      15_000,
    );
  } catch (error) {
    console.error(`can-api ${path} unreachable:`, error);
    return Response.json(
      { error: "unreachable", message: "无法连接到 can-api，请稍后再试。" },
      { status: 502 },
    );
  }

  const kept: [string, string][] = [];
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) kept.push([name, value]);
  }

  if (!upstream.ok) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: kept,
    });
  }

  const body = await upstream.arrayBuffer();
  const ttl = weatherCacheTtlMs(upstream.headers.get("cache-control"));
  if (ttl > 0) {
    cache.set(key, { status: upstream.status, headers: kept, body }, ttl);
  }
  return new Response(body.slice(0), {
    status: upstream.status,
    headers: kept,
  });
};
