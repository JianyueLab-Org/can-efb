import { afterEach, describe, expect, test } from "bun:test";
import { previewKey, resolveRoute, shouldPreview } from "@/lib/routePreview";

/**
 * 边打字边画：起降机场还没填完整就去问 can-db，每敲一个字母就是一次必然失败的请
 * 求，而失败提示会在人打字的时候一直闪。
 */
describe("shouldPreview", () => {
  test("两个四字码加一段航路才画", () => {
    expect(shouldPreview("ZBAA", "zsss", "ELKUR A461 SASAN")).toBe(true);
  });

  test("机场没填完、航路是空的，都不画", () => {
    expect(shouldPreview("ZBA", "ZSSS", "ELKUR")).toBe(false);
    expect(shouldPreview("ZBAA", "", "ELKUR")).toBe(false);
    expect(shouldPreview("ZBAA", "ZSSS", "   ")).toBe(false);
  });
});

describe("previewKey", () => {
  test("大小写和多余空白不算改动", () => {
    expect(previewKey("zbaa", "ZSSS", " elkur  A461 sasan ")).toBe(
      previewKey("ZBAA", "zsss", "ELKUR A461 SASAN"),
    );
  });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** 画不出来的三种原因各说各的：没权限、没读到、读到了但一个点都没对上。 */
describe("resolveRoute", () => {
  test("有点就是数据", async () => {
    answer(200, {
      data: [{ ident: "ZBAA", lat: 40.08, lon: 116.58, kind: "airport" }],
    });
    const state = await resolveRoute("ZBAA", "ZSSS", "ELKUR");
    expect(state.kind).toBe("data");
  });

  test("一个点都没对上是空", async () => {
    answer(200, { data: [] });
    expect((await resolveRoute("ZBAA", "ZSSS", "XXXXX")).kind).toBe("empty");
  });

  test("can-db 401/403 是没权限", async () => {
    answer(403, { error: "forbidden" });
    expect((await resolveRoute("ZBAA", "ZSSS", "ELKUR")).kind).toBe(
      "forbidden",
    );
  });

  test("连不上是错误，不是空", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await resolveRoute("ZBAA", "ZSSS", "ELKUR")).toEqual({
      kind: "error",
      status: 0,
    });
  });
});
