import { describe, expect, test } from "bun:test";
import {
  fromApiResult,
  fromDbResponse,
  isForbiddenStatus,
} from "@/lib/requestState";

/**
 * 这个站反复踩的坑：把「没读到」画成「没有」（AGENTS.md〈别把「失败」画成「没
 * 有」〉）。所以每一种请求结果落到哪一类，在这里钉死。
 */
describe("fromApiResult（can-api）", () => {
  test("读到了、有内容", () => {
    expect(fromApiResult({ ok: true, data: { callsign: "CCA1501" } })).toEqual({
      kind: "data",
      data: { callsign: "CCA1501" },
    });
  });

  test("读到了、确实没有：null 是空，不是错", () => {
    expect(fromApiResult({ ok: true, data: null })).toEqual({ kind: "empty" });
  });

  test("空数组由调用方说了算", () => {
    expect(
      fromApiResult<number[]>({ ok: true, data: [] }, (list) => !list.length),
    ).toEqual({ kind: "empty" });
    expect(fromApiResult<number[]>({ ok: true, data: [] })).toEqual({
      kind: "data",
      data: [],
    });
  });

  test("can-api 的 401 是登录失效，是错误，不是没权限", () => {
    const failure = {
      ok: false as const,
      status: 401,
      error: "unauthorized",
      message: "Unauthorized",
    };
    expect(fromApiResult(failure)).toEqual({
      kind: "error",
      status: 401,
      failure,
    });
  });

  test("网络断了是 status 0 的错误", () => {
    expect(
      fromApiResult({
        ok: false,
        status: 0,
        error: "network",
        message: "Network request failed.",
      }).kind,
    ).toBe("error");
  });
});

/**
 * can-db 的 401/403 是「你没有 aipAccess」—— 大多数飞行员的常态，不是故障，要有
 * 自己的一句话（can-db 的门是 `aipAccess >= 1 || rating >= 8`）。
 */
describe("fromDbResponse（can-db）", () => {
  test("401 和 403 都是没权限", () => {
    expect(fromDbResponse(false, 401, null)).toEqual({
      kind: "forbidden",
      status: 401,
    });
    expect(fromDbResponse(false, 403, null)).toEqual({
      kind: "forbidden",
      status: 403,
    });
  });

  test("别的失败都是错误，连不上是 status 0", () => {
    expect(fromDbResponse(false, 502, null)).toEqual({
      kind: "error",
      status: 502,
    });
    expect(fromDbResponse(false, 0, null)).toEqual({
      kind: "error",
      status: 0,
    });
  });

  test("成功但空", () => {
    expect(
      fromDbResponse<string[]>(true, 200, [], (list) => !list.length),
    ).toEqual({ kind: "empty" });
    expect(fromDbResponse(true, 200, null)).toEqual({ kind: "empty" });
  });

  test("成功有内容", () => {
    expect(fromDbResponse(true, 200, ["ZBAA"])).toEqual({
      kind: "data",
      data: ["ZBAA"],
    });
  });
});

describe("isForbiddenStatus", () => {
  test("只有 401 和 403", () => {
    expect([400, 401, 403, 404, 500].map(isForbiddenStatus)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });
});
