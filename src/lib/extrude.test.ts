import { describe, expect, test } from "bun:test";
import type { FeatureCollection } from "geojson";
import {
  M_PER_FT,
  parseCruiseLevel,
  profileAltitudeFt,
  routeProfile,
  trafficColumns,
} from "@/lib/extrude";
import type { RoutePoint } from "@/lib/routeGeometry";

describe("parseCruiseLevel", () => {
  test("高度层、高度、米制、纯英尺", () => {
    expect(parseCruiseLevel("FL350")).toBe(35000);
    expect(parseCruiseLevel("f350")).toBe(35000);
    expect(parseCruiseLevel("A045")).toBe(4500);
    expect(parseCruiseLevel("35000")).toBe(35000);
    // S1190 是 11900 m。
    expect(parseCruiseLevel("S1190")).toBe(Math.round(11900 / M_PER_FT));
  });

  /** 三位纯数字可能是 FL350，也可能是 350 ft，差一百倍，不猜。 */
  test("认不出的不猜", () => {
    expect(parseCruiseLevel("350")).toBeNull();
    expect(parseCruiseLevel("")).toBeNull();
    expect(parseCruiseLevel(undefined)).toBeNull();
    expect(parseCruiseLevel("VFR")).toBeNull();
  });
});

describe("profileAltitudeFt", () => {
  test("两端是 0，中间封顶在巡航高度", () => {
    expect(profileAltitudeFt(0, 600, 35000)).toBe(0);
    expect(profileAltitudeFt(600, 600, 35000)).toBe(0);
    expect(profileAltitudeFt(300, 600, 35000)).toBe(35000);
  });

  test("下降按 3:1：离终点 30 NM 是 10000 ft", () => {
    expect(profileAltitudeFt(570, 600, 35000)).toBeCloseTo(10000);
  });

  /** 航线短到爬不上巡航高度：顶点是爬升线和下降线的交点，不是巡航高度。 */
  test("短航线到不了巡航高度", () => {
    const peak = Math.max(
      ...Array.from({ length: 61 }, (_, i) => profileAltitudeFt(i, 60, 35000)),
    );
    expect(peak).toBeLessThan(35000);
    expect(peak).toBeGreaterThan(0);
  });
});

const A: RoutePoint = {
  ident: "ZBAA",
  lat: 40.08,
  lon: 116.58,
  kind: "airport",
};
const B: RoutePoint = {
  ident: "ZSSS",
  lat: 31.2,
  lon: 121.34,
  kind: "airport",
};

describe("routeProfile", () => {
  test("没有巡航高度就不画", () => {
    expect(routeProfile([A, B], null, 1000).features).toHaveLength(0);
  });

  test("每小段一面幕一条带，最高不过巡航高度", () => {
    const out = routeProfile([A, B], 30000, 1000);
    const walls = out.features.filter((f) => f.properties?.part === "wall");
    const ribbons = out.features.filter((f) => f.properties?.part === "ribbon");
    expect(walls.length).toBe(ribbons.length);
    expect(ribbons.length).toBeGreaterThan(100);
    const top = Math.max(...ribbons.map((f) => f.properties!.topM as number));
    expect(top).toBeCloseTo(30000 * M_PER_FT);
  });

  /** 复飞段接在落地之后，算进全长会把下降点往后推。 */
  test("复飞段和旁切角点不进剖面", () => {
    const base = routeProfile([A, B], 30000, 1000).features.length;
    const missed: RoutePoint = {
      ident: "MA",
      lat: 30,
      lon: 122,
      kind: "missed",
    };
    const corner: RoutePoint = {
      ident: "X",
      lat: 45,
      lon: 100,
      kind: "fix",
      offPath: true,
    };
    expect(
      routeProfile([A, corner, B, missed], 30000, 1000).features.length,
    ).toBe(base);
  });
});

function point(properties: Record<string, unknown>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties,
        geometry: { type: "Point", coordinates: [116, 40] },
      },
    ],
  };
}

describe("trafficColumns", () => {
  test("在飞的一架立一根柱加一块顶", () => {
    const out = trafficColumns(
      point({ cid: "1", band: 3, onGround: 0, altitude: 20000 }),
      null,
      500,
    );
    expect(out.features.map((f) => f.properties?.part)).toEqual([
      "stalk",
      "cap",
    ]);
    expect(out.features[1].properties?.topM).toBeCloseTo(20000 * M_PER_FT);
  });

  test("地面上的不立柱，自己那架按地速判", () => {
    const ground = point({ cid: "1", band: 0, onGround: 1, altitude: 100 });
    const ownParked = point({ cid: "2", altitude: 1200, groundspeed: 0 });
    expect(trafficColumns(ground, ownParked, 500).features).toHaveLength(0);
    const ownFlying = point({ cid: "2", altitude: 9000, groundspeed: 250 });
    const out = trafficColumns(null, ownFlying, 500);
    expect(out.features.every((f) => f.properties?.own === 1)).toBe(true);
  });
});
