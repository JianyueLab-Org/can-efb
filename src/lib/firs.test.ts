import { describe, expect, test } from "bun:test";
import type { FeatureCollection } from "geojson";
import { firBoundaries } from "./firs";

const square = {
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

describe("firBoundaries", () => {
  test("情报区标注是范围内的标注点，不是边界线", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            code: "ZSHA",
            name: "Shanghai",
            fir: true,
            labelLat: 32,
            labelLon: 122,
          },
          geometry: square,
        },
        {
          type: "Feature",
          properties: {
            code: "ZSHA-E",
            fir: false,
            labelLat: 32,
            labelLon: 124,
          },
          geometry: square,
        },
        {
          type: "Feature",
          properties: {
            code: "XXXX",
            fir: true,
            labelLat: null,
            labelLon: null,
          },
          geometry: square,
        },
      ],
    };
    const points = firBoundaries(collection).features.filter(
      (f) => f.properties?.labelPoint,
    );
    expect(points).toHaveLength(1);
    expect(points[0].properties).toEqual({
      code: "ZSHA",
      name: "Shanghai",
      labelPoint: true,
    });
    expect(points[0].geometry).toEqual({
      type: "Point",
      coordinates: [122, 32],
    });
  });
});
