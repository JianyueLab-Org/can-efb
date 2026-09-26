import { describe, expect, test } from "bun:test";
import { blocksFor } from "@/lib/mora";

/**
 * MapLibre 的 `getBounds()` 过了日界线给的是展开的经度（`170..190`）。块要折回
 * [-180, 180) 才取得到，折错的表现是日界线那一侧整片没有 MORA —— 看起来像那边没
 * 数据，而不像出了错。
 */
const lonsOf = (blocks: { lat: number; lon: number }[]) =>
  [...new Set(blocks.map((b) => b.lon))].sort((a, b) => a - b);

describe("blocksFor 跨日界线", () => {
  test("往东越过 180 的那一截折回西经", () => {
    expect(lonsOf(blocksFor(50, 170, 55, 195))).toEqual([-180, -170, 170]);
  });

  test("往西越过 -180 的那一截折回东经", () => {
    expect(lonsOf(blocksFor(50, -195, 55, -175))).toEqual([-180, 160, 170]);
  });

  test("不跨的视野原样", () => {
    expect(blocksFor(35, 112, 42, 118)).toEqual([
      { lat: 30, lon: 110 },
      { lat: 40, lon: 110 },
    ]);
  });

  test("横跨 360° 以上是整圈，每块只出现一次", () => {
    const blocks = blocksFor(0, -300, 5, 300);
    expect(lonsOf(blocks)).toHaveLength(36);
    expect(blocks).toHaveLength(36);
  });
});

describe("blocksFor 纬度边界", () => {
  // `-90` 那一块覆盖北边 -89..-81 的格子，而它是唯一覆盖它们的块。
  test("最南那一块不扔", () => {
    const lats = blocksFor(-90, 0, -85, 5).map((b) => b.lat);
    expect(lats).toEqual([-90]);
  });

  test("网格之外的块扔掉", () => {
    expect(blocksFor(-100, 0, -95, 5)).toEqual([]);
  });
});

describe("blocksFor 块边长", () => {
  // 航路网按 20 度取（lib/airways.ts 的 AIRWAY_BLOCK）。中国一屏在 z5 落在三块里。
  test("20 度的块对齐 20 的倍数", () => {
    expect(blocksFor(23, 98, 39, 126, 20)).toEqual([
      { lat: 20, lon: 80 },
      { lat: 20, lon: 100 },
      { lat: 20, lon: 120 },
    ]);
  });

  test("20 度的块过日界线也折回", () => {
    expect(lonsOf(blocksFor(50, 170, 55, 195, 20))).toEqual([-180, 160]);
  });
});
