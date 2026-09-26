import { describe, expect, test } from "bun:test";
import { legKey } from "@/lib/airways";
import {
  pointFeatures,
  routeLines,
  type RoutePoint,
} from "@/lib/routeGeometry";

const route: RoutePoint[] = [
  { ident: "ZBAA", lat: 40.08, lon: 116.58, kind: "airport" },
  { ident: "ELKUR", lat: 39.8, lon: 117.2, kind: "sid", via: "ELKU4K" },
  { ident: "SASAN", lat: 38.0, lon: 118.0, kind: "fix", via: "A461" },
  { ident: "ZSSS", lat: 31.2, lon: 121.3, kind: "airport", via: "DCT" },
];

/**
 * 一条腿被丢掉只是图上少一截线，剩下的都画得好好的 —— 看不出来。所以腿数、每条腿
 * 的样式归属、交给航路网的那几条还在不在，都钉住。
 */
describe("routeLines", () => {
  test("n 个点 n-1 条腿，样式取自到达的那个点", () => {
    const lines = routeLines(route);
    expect(lines.features).toHaveLength(3);
    expect(lines.features.map((f) => f.properties?.procedure)).toEqual([
      1, 0, 0,
    ]);
    expect(lines.features.map((f) => f.properties?.via)).toEqual([
      "ELKU4K",
      "A461",
      "DCT",
    ]);
  });

  test("航路网点亮了的腿仍在集合里，只标上 onAirway", () => {
    const lines = routeLines(
      route,
      new Set([legKey("A461", "ELKUR", "SASAN")]),
    );
    expect(lines.features).toHaveLength(3);
    expect(lines.features.map((f) => f.properties?.onAirway)).toEqual([
      0, 1, 0,
    ]);
  });

  test("坐标是 [经, 纬]，首尾落在两个端点上", () => {
    const coords = (
      routeLines(route).features[2].geometry as { coordinates: number[][] }
    ).coordinates;
    expect(coords[0][0]).toBeCloseTo(118.0, 3);
    expect(coords[0][1]).toBeCloseTo(38.0, 3);
    expect(coords[coords.length - 1][0]).toBeCloseTo(121.3, 3);
    expect(coords[coords.length - 1][1]).toBeCloseTo(31.2, 3);
  });

  test("不到两个点就没有线", () => {
    expect(routeLines(route.slice(0, 1)).features).toEqual([]);
  });
});

/** 只有航路上的点该标名字；全国几百个机场都标上就是一团糊。 */
describe("pointFeatures", () => {
  test("onRoute 和 airport 两个标记", () => {
    const features = pointFeatures([
      { ...route[0], onRoute: true },
      { ident: "ZSPD", lat: 31.14, lon: 121.8, kind: "airport" },
      { ...route[2], onRoute: true },
    ]).features;
    expect(features.map((f) => f.properties)).toEqual([
      { ident: "ZBAA", airport: 1, onRoute: 1 },
      { ident: "ZSPD", airport: 1, onRoute: 0 },
      { ident: "SASAN", airport: 0, onRoute: 1 },
    ]);
  });
});

describe("等待的方向箭头和航向", () => {
  const hold = {
    inboundTrue: 0,
    inboundMag: 347,
    turn: "R" as const,
    legNm: 4,
    radiusNm: 1,
  };

  test("每个等待两支箭头、一个入航航向，按那个点所在的段取色", () => {
    const features = routeLines([
      { ident: "A", lat: 0, lon: 0, kind: "approach" },
      { ident: "PD231", lat: 0, lon: 1, kind: "missed", hold },
    ]).features;
    const marks = features.filter((f) => f.properties?.holdMark);
    expect(
      marks.map((f) => [f.properties?.holdMark, f.properties?.seg]),
    ).toEqual([
      ["arrow", "missed"],
      ["arrow", "missed"],
      ["course", "missed"],
    ]);
    expect(marks.every((f) => f.geometry.type === "Point")).toBe(true);
    expect(marks.map((f) => f.properties?.text).filter(Boolean)).toEqual([
      "347°",
    ]);
  });

  test("几何点上的等待不画，标记也不出", () => {
    const features = routeLines([
      { ident: "A", lat: 0, lon: 0, kind: "sid" },
      { ident: "", lat: 0, lon: 1, kind: "sid", shape: true, hold },
    ]).features;
    expect(features.some((f) => f.properties?.holdMark)).toBe(false);
  });
});
