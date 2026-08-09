/**
 * 岛屿怎么跟 can-api 说话。
 *
 * 浏览器安全：没有密钥，不 import `src/server` 下的任何东西。
 *
 * 和 can-web 的同名文件有一处**关键差别** —— 这里打的是**同源**的
 * `/api/v1/...`，由本站的反代（`src/pages/api/v1/[...path].ts`）转给 can-api，
 * 而不是直连 api.airwaysn.org。理由写在那个文件顶上：can-api 的
 * `ALLOWED_ORIGINS` 里没有 efb 这个域。
 *
 * 代价是路径必须在那份白名单里，收益是这个站不依赖 can-api 的一次部署改动。
 * 路径本身**一个字都没变** —— `/api/v1/...` 是published contract。
 */

export interface ApiFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
  /** 422 时 can-api 会逐字段告诉你哪里不对。 */
  fields?: Record<string, string>;
  /** 409 tracked：航空器的雷达标牌被这名管制员占着。 */
  controller?: string;
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/**
 * 调 can-api。
 *
 * 失败**不抛异常**。绝大多数失败是成员把表单填错了，那句话该出现在字段旁边而
 * 不是一个 500 页面；真正的网络故障是 status 0，调用方能分得出来。
 */
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      // 同源请求，cookie 本来就会带上；写出来是为了下一个人不会以为这里漏了
      // 什么，也为了万一将来改成直连时这一行已经在位。
      credentials: "same-origin",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: "network",
      message: "网络连接失败，请稍后再试。",
    };
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: String(body.error ?? "http_error"),
      message: String(body.message ?? `请求失败（${response.status}）`),
      fields: (body.fields as Record<string, string>) ?? undefined,
      controller:
        typeof body.controller === "string" ? body.controller : undefined,
    };
  }

  // can-api 大部分接口包着 {status, data, timestamp}，少数裸奔。
  const data = "data" in body ? body.data : body;
  return { ok: true, data: data as T };
}
