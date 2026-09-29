import { describe, expect, test } from "bun:test";
import { cacheKey } from "@/server/responseCache";
import {
  isWeatherTileFailure,
  msUntilNextBucket,
  noteWeatherTile,
  parseMaxAge,
  parseTile,
  remainingMaxAge,
  weatherBucket,
  weatherCacheTtlMs,
  weatherErrorCode,
  weatherTilePath,
  weatherTileUrl,
  withMaxAge,
  type WeatherBurst,
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

describe("时间桶", () => {
  test("按墙上时钟的十分钟对齐", () => {
    expect(weatherBucket(0)).toBe(0);
    expect(weatherBucket(599_999)).toBe(0);
    expect(weatherBucket(600_000)).toBe(1);
    expect(msUntilNextBucket(0)).toBe(600_000);
    expect(msUntilNextBucket(599_999)).toBe(1);
    expect(msUntilNextBucket(600_001)).toBe(599_999);
  });

  test("地址带桶号", () => {
    expect(weatherTileUrl(2_950_000)).toBe(
      "/api/v1/weather/precipitation/{z}/{x}/{y}?t=2950000",
    );
  });
});

describe("反代缓存时长", () => {
  test("parseMaxAge", () => {
    expect(parseMaxAge("public, max-age=412")).toBe(412);
    expect(parseMaxAge("max-age=30, public")).toBe(30);
    expect(parseMaxAge("public, s-maxage=100, max-age=90")).toBe(90);
    expect(parseMaxAge("public")).toBeNull();
    expect(parseMaxAge("max-age=abc")).toBeNull();
    expect(parseMaxAge("max-age=-5")).toBeNull();
    expect(parseMaxAge("s-maxage=100")).toBeNull();
    expect(parseMaxAge(null)).toBeNull();
    expect(parseMaxAge("")).toBeNull();
  });

  test("weatherCacheTtlMs：跟上游，缺失按 600，上限 600", () => {
    expect(weatherCacheTtlMs("public, max-age=412")).toBe(412_000);
    expect(weatherCacheTtlMs("public, max-age=3600")).toBe(600_000);
    expect(weatherCacheTtlMs(null)).toBe(600_000);
    expect(weatherCacheTtlMs("public, max-age=x")).toBe(600_000);
    expect(weatherCacheTtlMs("max-age=0")).toBe(0);
  });

  test("remainingMaxAge：向上取整，下限 30", () => {
    expect(remainingMaxAge(1_000_000 + 412_000, 1_000_000)).toBe(412);
    expect(remainingMaxAge(1_000_000 + 400_500, 1_000_000)).toBe(401);
    expect(remainingMaxAge(1_000_000 + 10_000, 1_000_000)).toBe(30);
    expect(remainingMaxAge(1_000_000, 1_000_000)).toBe(30);
  });

  test("withMaxAge 只换 max-age", () => {
    expect(withMaxAge("public, max-age=600", 412)).toBe("public, max-age=412");
    expect(withMaxAge("max-age=600,public", 30)).toBe("max-age=30, public");
    expect(withMaxAge("public", 90)).toBe("public, max-age=90");
    expect(withMaxAge(null, 90)).toBe("public, max-age=90");
  });
});

describe("noteWeatherTile", () => {
  const fail = { ok: false } as const;
  const ok = { ok: true } as const;

  function run(
    events: [number, Parameters<typeof noteWeatherTile>[1]][],
  ): boolean[] {
    let burst: WeatherBurst | null = null;
    return events.map(([at, outcome]) => {
      const next = noteWeatherTile(burst, outcome, at);
      burst = next.burst;
      return next.down;
    });
  }

  test("一两张失败只空着那一张", () => {
    expect(
      run([
        [0, fail],
        [100, fail],
      ]),
    ).toEqual([false, false]);
  });

  test("一阵里三张失败、没有成功：整层挂了", () => {
    expect(
      run([
        [0, fail],
        [100, fail],
        [200, fail],
      ]),
    ).toEqual([false, false, true]);
  });

  test("有一张成功就不算整层挂了", () => {
    expect(
      run([
        [0, ok],
        [100, fail],
        [200, fail],
        [300, fail],
        [400, fail],
      ]),
    ).toEqual([false, false, false, false, false]);
  });

  test("间隔超过 5 秒另起一阵", () => {
    expect(
      run([
        [0, fail],
        [100, fail],
        [6_000, fail],
        [6_100, fail],
      ]),
    ).toEqual([false, false, false, false]);
    // 上一阵的成功不带到下一阵。
    expect(
      run([
        [0, ok],
        [10_000, fail],
        [10_100, fail],
        [10_200, fail],
      ]),
    ).toEqual([false, false, false, true]);
  });

  test("not_configured 一次就算", () => {
    expect(
      run([
        [0, ok],
        [100, { ok: false, code: "not_configured" }],
      ]),
    ).toEqual([false, true]);
    expect(run([[0, { ok: false, code: "upstream_budget" }]])).toEqual([false]);
  });
});

describe("weatherErrorCode", () => {
  test("从响应体读 error", async () => {
    const body = new Blob([
      JSON.stringify({ error: "not_configured", message: "x" }),
    ]);
    expect(await weatherErrorCode({ status: 503, body })).toBe(
      "not_configured",
    );
  });

  test("没有响应体、不是 JSON", async () => {
    expect(await weatherErrorCode(new Error("x"))).toBeUndefined();
    expect(await weatherErrorCode(undefined)).toBeUndefined();
    expect(
      await weatherErrorCode({ body: new Blob(["<html>"]) }),
    ).toBeUndefined();
  });
});
