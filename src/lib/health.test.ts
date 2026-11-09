import { describe, expect, test } from "bun:test";
import { createHealth, healthResponse, upstreamCheck } from "@/lib/health";

function fakeFetch(status: number, calls: { n: number }) {
  return (async () => {
    calls.n++;
    return new Response("", { status });
  }) as unknown as typeof fetch;
}

describe("health", () => {
  test("200 when upstream is ok", async () => {
    const calls = { n: 0 };
    const health = createHealth({
      "can-api": upstreamCheck("http://x/health", fakeFetch(200, calls)),
    });
    const res = healthResponse(await health());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { "can-api": "ok" },
    });
  });

  test("503 when upstream fails", async () => {
    const calls = { n: 0 };
    const health = createHealth({
      "can-api": upstreamCheck("http://x/health", fakeFetch(500, calls)),
    });
    const res = healthResponse(await health());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "fail",
      checks: { "can-api": "status 500" },
    });
  });

  test("caches for 10 s and shares in-flight checks", async () => {
    const calls = { n: 0 };
    let t = 0;
    const health = createHealth(
      { "can-api": upstreamCheck("http://x/health", fakeFetch(200, calls)) },
      () => t,
    );
    await Promise.all([health(), health(), health()]);
    expect(calls.n).toBe(1);
    t = 9_999;
    await health();
    expect(calls.n).toBe(1);
    t = 10_000;
    await health();
    expect(calls.n).toBe(2);
  });
});
