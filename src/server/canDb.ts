import type { APIContext } from "astro";
import { CAN_DB_ORIGIN } from "@/lib/config";

/**
 * 服务端调用 can-db（航行资料库）。
 *
 * 形状照抄 can-database 控制台的同名文件 —— 那是这条调用路径的参考实现，两边不
 * 该各写一套。和本站的 `server/canApi.ts` 也是同一件事：SSR 的时候没有浏览器替
 * 我们带 cookie，所以把进来的 `Cookie` 头**原样转发**过去。
 *
 * **can-db 自己不验会话**：它拿这枚 cookie 去问 can-api「你是谁」，再按自己的规
 * 则判能不能读。所以这个站在这条链路上仍然只是转发，一如它对 can-api 的做法 ——
 * 不多存一份凭据，也不多一处判断。
 *
 * **谁能读，是 can-db 说了算，这里不做第二次判断。**
 * 它的门是 `aipAccess >= 1 || rating >= 8`（教员），`aipAccess` 默认 0、由 ADM 逐
 * 人授予。也就是说**大多数飞行员会拿到 401/403**，那是预期结果而不是故障 —— 调
 * 用方要把它当成一种正常状态显示出来，别当错误弹。在这里抄一份权限判断只会有两
 * 份可能不一致的答案，而不一致的方向一定是这边放行了那边拒绝的东西。
 *
 * 超时给 8 秒而不是 can-api 那边的 5 秒：这些查询要打 PostgreSQL，一次机场全表
 * 比一次会话检查重得多。
 *
 * **服务端专用**，它读请求头，绝不能被岛屿 import。
 */

const TIMEOUT_MS = 8_000;

export interface DbResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  message?: string;
}

export async function callDb<T = unknown>(
  context: Pick<APIContext, "request">,
  path: string,
): Promise<DbResult<T>> {
  const headers: Record<string, string> = {};
  const cookie = context.request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  let response: Response;
  try {
    response = await fetch(CAN_DB_ORIGIN + path, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`can-db ${path} unreachable:`, error);
    return { ok: false, status: 0, data: null, error: "unreachable" };
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: String(body.error ?? "http_error"),
      message: typeof body.message === "string" ? body.message : undefined,
    };
  }

  // 和 can-api 一样，大部分接口包着 {status, data}，少数裸奔。有信封就拆掉。
  const data = "data" in body ? body.data : body;
  return {
    ok: true,
    status: response.status,
    data: (data ?? null) as T | null,
  };
}

/**
 * 机场索引的一行。字段取自 can-database 的 `AirportSummary`，**逐字对齐** ——
 * 两个站读的是同一个接口，形状分叉了就会有一边悄悄读到 undefined。
 */
export interface AirportSummary {
  icao: string;
  fir: string | null;
  name: string | null;
  lat: number;
  lon: number;
  elev: number | null;
  variation: number | null;
  airac: string;
  /** 机位数，不是机位本身 —— 详情接口才给数组。 */
  stands: number;
}

export async function listAirports(
  context: Pick<APIContext, "request">,
): Promise<DbResult<AirportSummary[]>> {
  return callDb<AirportSummary[]>(context, "/api/v1/aip/airports");
}
