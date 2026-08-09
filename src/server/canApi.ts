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
}

/**
 * 向 can-api 解出调用者。
 *
 * `/api/v1/auth/session` 在没人登录时回的是 200 + `user: null`，不是 401 ——
 * 「没登录」在公开页面上是预期状态而不是错误 —— 所以这里对「没登录」和「调用
 * 失败」都返回 null。
 *
 * 失败和登出不可区分是**安全的那个方向**：can-api 不可达时页面按匿名渲染，而
 * 不是按某个人渲染。
 */
export async function resolveSession(
  context: Pick<APIContext, "request">,
): Promise<SessionUser | null> {
  const result = await callApi<{ user: SessionUser | null }>(
    context,
    "/api/v1/auth/session",
  );
  if (!result.ok || !result.data) return null;
  return result.data.user ?? null;
}
