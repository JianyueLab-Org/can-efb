import { describe, expect, test } from "bun:test";
import {
  IFR_SPLIT_M,
  airspaceOnChart,
  airspacesOnChart,
  isIfrChart,
  parseLimitM,
} from "@/lib/ifrChart";

describe("parseLimitM", () => {
  test("can-db 的米：下限 0 是地面，上限 0 / null 是不封顶", () => {
    expect(parseLimitM(0, "lower")).toBe(0);
    expect(parseLimitM(4500, "lower")).toBe(4500);
    expect(parseLimitM(0, "upper")).toBe(Infinity);
    expect(parseLimitM(null, "upper")).toBe(Infinity);
    expect(parseLimitM(undefined, "upper")).toBe(Infinity);
    expect(parseLimitM(12500, "upper")).toBe(12500);
  });

  test("下限缺席是读不出来", () => {
    expect(parseLimitM(null, "lower")).toBeNull();
    expect(parseLimitM(Number.NaN, "lower")).toBeNull();
  });

  test("地面和不封顶的几种写法", () => {
    for (const s of ["GND", "sfc", " MSL "]) {
      expect(parseLimitM(s, "lower")).toBe(0);
    }
    for (const s of ["UNL", "UNLTD", "unlim", "UNLIMITED"]) {
      expect(parseLimitM(s, "upper")).toBe(Infinity);
    }
  });

  test("飞行高度层、公制高度层、英尺、米", () => {
    expect(parseLimitM("FL197", "upper")).toBeCloseTo(6004.56, 1);
    expect(parseLimitM("fl 245", "upper")).toBeCloseTo(7467.6, 1);
    expect(parseLimitM("S0840", "upper")).toBe(8400);
    expect(parseLimitM("19700FT", "upper")).toBeCloseTo(6004.56, 1);
    expect(parseLimitM("5000 ft AMSL", "lower")).toBeCloseTo(1524, 1);
    expect(parseLimitM("6000M", "lower")).toBe(6000);
    expect(parseLimitM("3000", "lower")).toBe(3000);
    expect(parseLimitM("600 m AGL", "lower")).toBe(600);
  });

  test("认不出的给 null", () => {
    expect(parseLimitM("", "lower")).toBeNull();
    expect(parseLimitM("byNOTAM", "upper")).toBeNull();
    expect(parseLimitM("FL", "upper")).toBeNull();
  });
});

describe("airspaceOnChart", () => {
  const zone = (lowerM: number | null, upperM: number | null) => ({
    lowerM,
    upperM,
  });

  test("分界是 6000 m", () => {
    expect(IFR_SPLIT_M).toBe(6000);
  });

  test("整块在分界以下：只上低空图", () => {
    const z = zone(0, 3000);
    expect(airspaceOnChart(z, "low")).toBe(true);
    expect(airspaceOnChart(z, "high")).toBe(false);
  });

  test("整块在分界以上：只上高空图", () => {
    const z = zone(8400, 12500);
    expect(airspaceOnChart(z, "low")).toBe(false);
    expect(airspaceOnChart(z, "high")).toBe(true);
  });

  test("跨过分界：两张都上", () => {
    const z = zone(3000, 9000);
    expect(airspaceOnChart(z, "low")).toBe(true);
    expect(airspaceOnChart(z, "high")).toBe(true);
  });

  /** 6000 m（含）以下是中低空：上限正好 6000 不上高空图，下限正好 6000 不上低空图。 */
  test("正好压在分界上", () => {
    expect(airspaceOnChart(zone(0, 6000), "high")).toBe(false);
    expect(airspaceOnChart(zone(6000, 9000), "low")).toBe(false);
  });

  test("地面到不封顶：两张都上", () => {
    expect(airspaceOnChart(zone(0, 0), "high")).toBe(true);
    expect(airspaceOnChart(zone(0, null), "low")).toBe(true);
  });

  test("读不出来的那一端不藏它", () => {
    expect(airspaceOnChart(zone(null, null), "low")).toBe(true);
    expect(airspaceOnChart(zone(null, null), "high")).toBe(true);
    // 下限读不出，上限在分界以下：高空图照样不上。
    expect(airspaceOnChart(zone(null, 3000), "high")).toBe(false);
  });

  test("过滤一份清单", () => {
    const list = [zone(0, 3000), zone(8400, 12500), zone(3000, 9000)];
    expect(airspacesOnChart(list, "high")).toEqual([list[1], list[2]]);
    expect(airspacesOnChart(list, "low")).toEqual([list[0], list[2]]);
  });
});

describe("isIfrChart", () => {
  test("只认 high / low", () => {
    expect(isIfrChart("high")).toBe(true);
    expect(isIfrChart("low")).toBe(true);
    expect(isIfrChart("off")).toBe(false);
    expect(isIfrChart(undefined)).toBe(false);
  });
});
