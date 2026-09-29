import { describe, expect, test } from "bun:test";
import { cacheKey } from "@/server/responseCache";
import {
  isWeatherTileFailure,
  parseTile,
  weatherTilePath,
} from "@/lib/weather";

/**
 * 反代按它决定转不转发。放宽了不会被屏幕出卖：图照样画，只是这个站成了一个能拿任意
 * 路径去打 can-api 的跳板。
 */
describe("parseTile", () => {
  test("合法坐标", () => {
    expect(parseTile("0", "0", "0")).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTile("6", "63", "63")).toEqual({ z: 6, x: 63, y: 63 });
    expect(parseTile("3", "6", "3")).toEqual({ z: 3, x: 6, y: 3 });
  });

  test("z 超出 0..6", () => {
    expect(parseTile("7", "0", "0")).toBeNull();
    expect(parseTile("-1", "0", "0")).toBeNull();
  });

  test("x / y 超出这一级的范围", () => {
    expect(parseTile("0", "1", "0")).toBeNull();
    expect(parseTile("3", "8", "0")).toBeNull();
    expect(parseTile("3", "0", "8")).toBeNull();
  });

  test("不是纯整数", () => {
    for (const bad of ["", "1.0", "+1", "1e0", " 1", "0x1", "abc", "1234"]) {
      expect(parseTile("1", bad, "0")).toBeNull();
    }
    expect(parseTile(undefined, "0", "0")).toBeNull();
  });
});

describe("weatherTilePath / 缓存键", () => {
  test("前导零落在同一个键上", () => {
    const a = parseTile("3", "06", "3")!;
    const b = parseTile("3", "6", "03")!;
    expect(weatherTilePath(a)).toBe("weather/precipitation/3/6/3");
    expect(cacheKey(weatherTilePath(a), new URLSearchParams())).toBe(
      cacheKey(weatherTilePath(b), new URLSearchParams()),
    );
  });
});

describe("isWeatherTileFailure", () => {
  test("降水 source 的错误算失败", () => {
    expect(
      isWeatherTileFailure({
        sourceId: "weather",
        error: Object.assign(new Error("503"), { status: 503 }),
      }),
    ).toBe(true);
  });

  test("别的 source、没有 source、被取消的请求都不算", () => {
    expect(
      isWeatherTileFailure({ sourceId: "airways", error: new Error("x") }),
    ).toBe(false);
    expect(isWeatherTileFailure({ error: new Error("x") })).toBe(false);
    expect(
      isWeatherTileFailure({
        sourceId: "weather",
        error: new DOMException("aborted", "AbortError"),
      }),
    ).toBe(false);
  });
});
