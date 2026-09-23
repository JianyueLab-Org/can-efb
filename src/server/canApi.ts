import type { APIContext } from "astro";
import { CAN_API_ORIGIN } from "@/lib/config";

/**
 * 服务端调用 can-api。
 *
 * 和 can-web 的 `src/server/canApi.ts` 是同一件东西：SSR 的时候没有浏览器替我
 * 们带 cookie，所以把进来的 `Cookie` 头**原样转发**过去，页面因此能渲染出这名
 * 成员自己的数据。
 *
 * 转发而不是自己解会话，是刻意的：can-api 拥有 token 的格式、密钥和有效期，这
 * 个站只是把凭据递过去再读回答案，两边没有需要保持同步的东西。
 *
 * **服务端专用**，它读请求头，绝不能被岛屿 import。
 */

const ORIGIN = CAN_API_ORIGIN;

/**
 * 短超时是故意的：SSR 页面没法「先渲染个 loading 再说」，所以慢掉的 can-api
 * 必须尽快变成一个降级结果，而不是一个挂到访客放弃为止的请求。
 */
const TIMEOUT_MS = 5_000;

export interface ServerApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  message?: string;
}

export async function callApi<T = unknown>(
  context: Pick<APIContext, "request"> | null,
  path: string,
  init: RequestInit = {},
): Promise<ServerApiResult<T>> {
  const headers: Record<string, string> = {
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...((init.headers as Record<string, string>) || {}),
  };

  const cookie = context?.request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  let response: Response;
  try {
    response = await fetch(ORIGIN + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`can-api ${path} unreachable:`, error);
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

  // can-api 大部分接口包着 {status, data, timestamp}，少数裸奔。有信封就拆掉，
  // 让调用方只面对一种形状。
  const data = "data" in body ? body.data : body;
  return {
    ok: true,
    status: response.status,
    data: (data ?? null) as T | null,
  };
}

/** 请求所属的成员，没登录是 null。 */
export interface SessionUser {
  username: string;
  name: string;
  email: string;
  rating: number;
  /**
   * 资料库访问级别，由 ADM 逐个授予：0 无 / 1 只读 / 2 可编辑 / 3 受限只读 /
   * 4 受限可编辑。**3 和 4 多出来的那一份是 CAAC 的 NAIP 汇编。**
   *
   * 这个站不拿它做权限判断 —— 门在 can-db。这里只用来决定「不使用受限汇编」那个
   * 开关出不出：档下的人按它恒为空转，摆出来只会让人以为自己错过了什么。
   *
   * can-api 一直在回这个字段，这里从前只是没写进类型。
   */
  aipAccess: number;
}

/**
 * 会话查询的三种结局。
 *
 * - `signedIn` / `anonymous` 是 can-api 给出的答案。
 * - `unavailable` 是**没拿到答案**：超时、连不上、5xx、或者 429（整站在 can-api
 *   眼里是集群出口一个 IP，限流的桶是全站共用的）。
 *
 * 后两者曾经合成同一个 null，于是 can-api 一抖，全站成员都被当成没登录、踢去登
 * 录页 —— 而登录页帮不了他们，登录完回来还是同一个故障。中间件对 `unavailable`
 * 回 503，不重定向。
 */
export type SessionLookup =
  | { status: "signedIn"; user: SessionUser }
  | { status: "anonymous" }
  | { status: "unavailable" };

/**
 * 向 can-api 解出调用者。
 *
 * `/api/v1/auth/session` 在没人登录时回的是 200 + `user: null`，不是 401 ——
 * 「没登录」在公开页面上是预期状态而不是错误。其余 4xx 也按「没登录」处理：那
 * 是 can-api 对这份凭据的判断，再问一次也不会变。
 *
 * 上游失败**不按匿名处理**，理由见 `SessionLookup`。它也不会让页面按某个人渲染
 * —— 两种失败的结局都是「不渲染这一页」，仍然是安全的那个方向。
 */
export async function resolveSession(
  context: Pick<APIContext, "request">,
): Promise<SessionLookup> {
  const result = await callApi<{ user: SessionUser | null }>(
    context,
    "/api/v1/auth/session",
  );
  if (result.status === 0 || result.status === 429 || result.status >= 500) {
    return { status: "unavailable" };
  }
  const user = result.ok ? (result.data?.user ?? null) : null;
  return user ? { status: "signedIn", user } : { status: "anonymous" };
}
