/**
 * 一次请求的结果落到哪一类：有数据、真的没有、没读到、没有权限、还在读。
 *
 * 这个站反复踩的坑是把「没读到」画成「没有」：概览说「还没有提交飞行计划」、设置说
 * 「未绑定」，而那两句话读起来完全正常，人会照着它做决定（AGENTS.md〈别把「失败」
 * 画成「没有」〉）。每一处各写一遍 `if (!result.ok)`，迟早有一处落错分支。所以分类
 * 只在这里做一次，岛屿按类渲染 `StateCard`。
 *
 * **两个来源分开判 401/403。** can-api 的 401 是登录失效 —— 一种错误，刷新重登就
 * 好；can-db 的 401/403 是「你没有航行资料库权限」—— 大多数飞行员的常态，要说清楚
 * 是权限、找谁开通，而不是弹一个像坏了的错误。
 */
import type { ApiFailure, ApiResult } from "@/lib/canApi";

export type StateKind = "loading" | "empty" | "error" | "forbidden";

export type RequestState<T> =
  | { kind: "loading" }
  | { kind: "data"; data: T }
  | { kind: "empty" }
  /** `failure` 只有 can-api 的结果带：界面用它按错误码给一句话（describeFailure）。 */
  | { kind: "error"; status: number; failure?: ApiFailure }
  | { kind: "forbidden"; status: number };

export const LOADING = { kind: "loading" } as const;

export function isForbiddenStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function present<T>(
  data: T | null | undefined,
  isEmpty?: (data: T) => boolean,
): RequestState<T> {
  if (data === null || data === undefined) return { kind: "empty" };
  return isEmpty?.(data) ? { kind: "empty" } : { kind: "data", data };
}

/** can-api（`lib/canApi.ts` 的 `api()`）。它的失败一律是错误。 */
export function fromApiResult<T>(
  result: ApiResult<T | null | undefined>,
  isEmpty?: (data: T) => boolean,
): RequestState<T> {
  if (!result.ok) {
    return { kind: "error", status: result.status, failure: result };
  }
  return present(result.data, isEmpty);
}

/** can-db（同源 `/api/db/*` 或 SSR 的 `server/canDb.ts`）。401/403 是没权限。 */
export function fromDbResponse<T>(
  ok: boolean,
  status: number,
  data: T | null | undefined,
  isEmpty?: (data: T) => boolean,
): RequestState<T> {
  if (!ok) {
    return isForbiddenStatus(status)
      ? { kind: "forbidden", status }
      : { kind: "error", status };
  }
  return present(data, isEmpty);
}
