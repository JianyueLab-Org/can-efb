import { describe, expect, test } from "bun:test";
import {
  attachTerminalHolds,
  estimateVariation,
  holdShape,
  isHoldLeg,
  racetrack,
  type Holding,
} from "./holds";

describe("holdShape", () => {
  test("converts magnetic to true with west-positive variation", () => {
    expect(holdShape({ inboundMag: 299, variationWest: 7 }).inboundTrue).toBe(
      292,
    );
    expect(holdShape({ inboundMag: 3, variationWest: 7 }).inboundTrue).toBe(
      356,
    );
  });

  test("standard defaults: 1 min / 230 kt low, 1.5 min / 240 kt high", () => {
    const low = holdShape({ inboundMag: 0, variationWest: 0 });
    expect(low.legNm).toBeCloseTo(230 / 60, 5);
    expect(low.turn).toBe("R");
    const high = holdShape({ inboundMag: 0, variationWest: 0, altFt: 16740 });
    expect(high.legNm).toBeCloseTo(6, 5);
  });

  test("published leg time and speed win", () => {
    const s = holdShape({
      inboundMag: 0,
      variationWest: 0,
      legTimeMin: 1.5,
      speedKt: 200,
      turn: "left",
    });
    expect(s.legNm).toBeCloseTo(5, 5);
    expect(s.turn).toBe("L");
  });
});

describe("racetrack", () => {
  // Inbound due north at the equator: the outbound leg is south of the fix.
  const shape = { inboundTrue: 0, turn: "R" as const, legNm: 4, radiusNm: 1 };

  test("starts and ends at the fix", () => {
    const ring = racetrack(0, 0, shape);
    expect(ring[0]).toEqual([0, 0]);
    expect(ring[ring.length - 1][0]).toBeCloseTo(0, 9);
    expect(ring[ring.length - 1][1]).toBeCloseTo(0, 9);
  });

  test("right turns sit east of a northbound inbound, left turns west", () => {
    const east = racetrack(0, 0, shape).map(([lon]) => lon);
    expect(Math.min(...east)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...east) * 60).toBeCloseTo(2, 3);
    const west = racetrack(0, 0, { ...shape, turn: "L" }).map(([lon]) => lon);
    expect(Math.max(...west)).toBeLessThanOrEqual(1e-9);
  });

  test("the pattern lies behind the fix along the inbound course", () => {
    const lats = racetrack(0, 0, shape).map(([, lat]) => lat * 60);
    // Turn outbound bulges 1 NM past the fix; the far end is leg + radius back.
    expect(Math.max(...lats)).toBeCloseTo(1, 3);
    expect(Math.min(...lats)).toBeCloseTo(-5, 3);
  });
});

test("isHoldLeg", () => {
  expect(isHoldLeg("HM")).toBe(true);
  expect(isHoldLeg("HF")).toBe(true);
  expect(isHoldLeg("TF")).toBe(false);
  expect(isHoldLeg(null)).toBe(false);
});

test("estimateVariation prefers the published value, else runways", () => {
  expect(estimateVariation(6, [])).toBe(6);
  // Runway true bearing 0°, magnetic 7° → 7° west.
  expect(
    estimateVariation(null, [{ hdg: 7, lat: 0, lon: 0, endLat: 1, endLon: 0 }]),
  ).toBeCloseTo(7, 5);
  expect(estimateVariation(null, [])).toBe(0);
});

describe("attachTerminalHolds", () => {
  const base: Holding = {
    name: null,
    lat: 0,
    lon: 0,
    turn: "R",
    icao: "ZBAA",
    fix: "DUMAP",
    inboundCourseMag: 299,
    legTimeMin: 1.5,
    speedKt: null,
    altFt: 16740,
    runway: "01",
  };
  const points = [
    { ident: "ZBAA", lat: 0, lon: 0, kind: "airport" },
    { ident: "DUMAP", lat: 1, lon: 1, kind: "star" },
  ];

  test("attaches a hold at the matching fix of the airport", () => {
    const out = attachTerminalHolds(
      points,
      [base],
      [{ icao: "ZBAA", runway: "", variationWest: 7 }],
    );
    expect(out[1].hold?.inboundTrue).toBe(292);
    expect(out[0].hold).toBeUndefined();
  });

  test("ignores other airports, enroute holdings and other runways", () => {
    const other = attachTerminalHolds(
      points,
      [{ ...base, icao: "ZSSS" }],
      [{ icao: "ZBAA", runway: "", variationWest: 0 }],
    );
    expect(other[1].hold).toBeUndefined();
    const enroute = attachTerminalHolds(
      points,
      [{ ...base, inboundCourseMag: null }],
      [{ icao: "ZBAA", runway: "", variationWest: 0 }],
    );
    expect(enroute[1].hold).toBeUndefined();
    const wrongRunway = attachTerminalHolds(
      points,
      [base],
      [{ icao: "ZBAA", runway: "36L", variationWest: 0 }],
    );
    expect(wrongRunway[1].hold).toBeUndefined();
  });

  test("prefers the selected runway's hold", () => {
    const out = attachTerminalHolds(
      points,
      [base, { ...base, runway: "19", inboundCourseMag: 100 }],
      [{ icao: "ZBAA", runway: "19", variationWest: 0 }],
    );
    expect(out[1].hold?.inboundTrue).toBe(100);
  });
});
