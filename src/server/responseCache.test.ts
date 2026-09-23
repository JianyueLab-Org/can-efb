import { describe, expect, test } from "bun:test";
import { ResponseCache, cacheKey, type CachedResponse } from "./responseCache";

function response(text: string): CachedResponse {
  return {
    status: 200,
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}

describe("ResponseCache", () => {
  test("过期之前命中，过期之后丢掉", () => {
    let now = 0;
    const cache = new ResponseCache(10, () => now);
    cache.set("metar?icao=ZBAA", response("a"), 1000);
    now = 999;
    expect(cache.get("metar?icao=ZBAA")).toBeDefined();
    now = 1000;
    expect(cache.get("metar?icao=ZBAA")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("满了先丢最早放进来的那条", () => {
    const cache = new ResponseCache(2, () => 0);
    cache.set("a", response("a"), 1000);
    cache.set("b", response("b"), 1000);
    cache.set("c", response("c"), 1000);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  test("重写一个键会把它排到末尾", () => {
    const cache = new ResponseCache(2, () => 0);
    cache.set("a", response("a"), 1000);
    cache.set("b", response("b"), 1000);
    cache.set("a", response("a2"), 1000);
    cache.set("c", response("c"), 1000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
  });
});

describe("cacheKey", () => {
  test("参数顺序和机场代码大小写不影响键", () => {
    const a = cacheKey(
      "route",
      new URLSearchParams("departure=zbaa&arrival=ZSSS&route=A461"),
    );
    const b = cacheKey(
      "route",
      new URLSearchParams("route=A461&arrival=zsss&departure= ZBAA "),
    );
    expect(a).toBe(b);
  });

  test("航路串不同就是不同的键", () => {
    const a = cacheKey(
      "route",
      new URLSearchParams("departure=ZBAA&arrival=ZSSS&route=A461"),
    );
    const b = cacheKey(
      "route",
      new URLSearchParams("departure=ZBAA&arrival=ZSSS&route=W1"),
    );
    expect(a).not.toBe(b);
  });

  test("路径不同就是不同的键", () => {
    const q = new URLSearchParams("icao=ZBAA");
    expect(cacheKey("metar", q)).not.toBe(cacheKey("route", q));
  });
});
