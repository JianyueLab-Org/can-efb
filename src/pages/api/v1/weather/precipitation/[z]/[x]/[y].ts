import type { APIRoute } from "astro";
import { CAN_API_ORIGIN } from "@/lib/config";
import { parseTile, weatherTilePath } from "@/lib/weather";
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
 * 成功的响应在本进程缓存 600 秒，键只由 z/x/y 组成；非 2xx 不缓存。`Cache-Control`
 * 原样交给浏览器（can-api 发的是 `public, max-age=600`）。
 */

/** z 0..6 一共 5461 张，常看的是中国周边几级，1000 张够用。 */
const cache = new ResponseCache(1000);

const TTL_MS = 600_000;

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
  if (hit) {
    return new Response(hit.body.slice(0), {
      status: hit.status,
      headers: hit.headers,
    });
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
  cache.set(key, { status: upstream.status, headers: kept, body }, TTL_MS);
  return new Response(body.slice(0), {
    status: upstream.status,
    headers: kept,
  });
};
