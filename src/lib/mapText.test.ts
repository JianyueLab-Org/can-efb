import { describe, expect, test } from "bun:test";
import { escapeHtml, formatLatLon, wrapLon } from "@/lib/mapText";

/**
 * 平移过日界线之后 `getBounds()` 给的是展开的经度，读数必须折回来 ——
 * `E190.0°` 看起来像一个真的坐标，不会有人觉得它错了。
 */
describe("wrapLon", () => {
  test("范围内原样", () => {
    expect(wrapLon(116.4)).toBeCloseTo(116.4);
    expect(wrapLon(-73.9)).toBeCloseTo(-73.9);
    expect(wrapLon(0)).toBe(0);
  });

  test("展开的经度折回", () => {
    expect(wrapLon(190)).toBeCloseTo(-170);
    expect(wrapLon(-200)).toBeCloseTo(160);
    expect(wrapLon(540)).toBeCloseTo(-180);
    expect(wrapLon(360)).toBe(0);
  });
});

describe("formatLatLon", () => {
  test("东经 190 读作西经 170", () => {
    expect(formatLatLon(35, 190)).toBe("N35.0° W170.0°");
  });

  test("常规坐标", () => {
    expect(formatLatLon(39.9, 116.4)).toBe("N39.9° E116.4°");
    expect(formatLatLon(-33.9, -70.7)).toBe("S33.9° W70.7°");
  });
});

/** 随数据来的署名进的是 MapLibre 的 HTML 署名框，必须当纯文本。 */
describe("escapeHtml", () => {
  test("标签和引号都转义", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  test("& 先转，不会把已转义的再转坏", () => {
    expect(escapeHtml("A & B's")).toBe("A &amp; B&#39;s");
  });

  test("普通署名原样", () => {
    expect(escapeHtml("© OpenStreetMap contributors")).toBe(
      "© OpenStreetMap contributors",
    );
  });
});
