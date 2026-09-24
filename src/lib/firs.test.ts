import { describe, expect, test } from "bun:test";
import type { Feature, FeatureCollection } from "geojson";
import { firBoundaries } from "./firs";

/** 逆时针的正方形：范围在走向左边。 */
const west = {
  type: "Polygon" as const,
  coordinates: [
    [
      [120, 30],
      [125, 30],
      [125, 35],
      [120, 35],
      [120, 30],
    ],
  ],
};

/** 顺时针，和 `west` 共用 125° 那条边。 */
const east = {
  type: "Polygon" as const,
  coordinates: [
    [
      [125, 30],
      [125, 35],
      [130, 35],
      [130, 30],
      [125, 30],
    ],
  ],
};

function edges(collection: FeatureCollection): Feature[] {
  return firBoundaries(collection).features.filter(
    (f) => f.properties?.labelEdge,
  );
}

function feature(code: string, geometry: typeof west, fir = true): Feature {
  return {
    type: "Feature",
    properties: { code, name: code, fir },
    geometry,
  };
}

describe("firBoundaries", () => {
  test("每条边一段，朝东走，正南北的朝南", () => {
    const runs = edges({
      type: "FeatureCollection",
      features: [feature("ZSHA", west)],
    });
    expect(runs.map((f) => f.geometry)).toEqual([
      {
        type: "LineString",
        coordinates: [
          [120, 30],
          [125, 30],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [125, 35],
          [125, 30],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [120, 35],
          [125, 35],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [120, 35],
          [120, 30],
        ],
      },
    ]);
    // 下边范围在上方，上边在下方；朝南走时东边那条范围在右（西），西边那条在左（东）。
    expect(runs.map((f) => f.properties?.inside)).toEqual([
      "left",
      "right",
      "right",
      "left",
    ]);
  });

  test("共用的边两边各一段，同一条几何，各写在自己那侧", () => {
    const shared = edges({
      type: "FeatureCollection",
      features: [feature("ZSHA", west), feature("RKRR", east)],
    }).filter(
      (f) =>
        f.geometry.type === "LineString" &&
        f.geometry.coordinates.every(([lon]) => lon === 125),
    );
    expect(shared.map((f) => f.geometry)).toEqual([
      {
        type: "LineString",
        coordinates: [
          [125, 35],
          [125, 30],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [125, 35],
          [125, 30],
        ],
      },
    ]);
    expect(
      shared.map((f) => [f.properties?.code, f.properties?.inside]),
    ).toEqual([
      ["ZSHA", "right"],
      ["RKRR", "left"],
    ]);
  });

  test("转角小的相邻边连成一段", () => {
    const runs = edges({
      type: "FeatureCollection",
      features: [
        feature("ZSHA", {
          type: "Polygon",
          coordinates: [
            [
              [120, 30],
              [122, 30.2],
              [125, 30],
              [125, 35],
              [120, 35],
              [120, 30],
            ],
          ],
        }),
      ],
    });
    expect(runs[0].geometry).toEqual({
      type: "LineString",
      coordinates: [
        [120, 30],
        [122, 30.2],
        [125, 30],
      ],
    });
  });

  test("区调不出标注线", () => {
    expect(
      edges({
        type: "FeatureCollection",
        features: [feature("ZSHA-E", west, false)],
      }),
    ).toHaveLength(0);
  });
});
