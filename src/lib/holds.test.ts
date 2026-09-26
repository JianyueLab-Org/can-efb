import { describe, expect, test } from "bun:test";
import {
  attachTerminalHolds,
  courseText,
  estimateVariation,
  holdMarks,
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
  const shape = {
    inboundTrue: 0,
    inboundMag: 0,
    turn: "R" as const,
    legNm: 4,
    radiusNm: 1,
  };

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

test("courseText writes three digits and a degree sign, 360 not 000", () => {
  expect(courseText(347)).toBe("347°");
  expect(courseText(5.4)).toBe("005°");
  expect(courseText(0)).toBe("360°");
  expect(courseText(359.6)).toBe("360°");
  expect(courseText(527)).toBe("167°");
});

describe("holdMarks", () => {
  // At the equator 1 NM = 1/60°, so lon/lat × 60 is a flat NM plane.
  const nm = ([lon, lat]: [number, number]): [number, number] => [
    lon * 60,
    lat * 60,
  ];
  const base = { legNm: 4, radiusNm: 1 };

  test("one arrow per leg, pointing the way the aircraft flies", () => {
    const marks = holdMarks(0, 0, {
      ...base,
      inboundTrue: 0,
      inboundMag: 7,
      turn: "R",
    });
    const arrows = marks.filter((m) => m.kind === "arrow");
    expect(arrows.map((m) => m.rotate)).toEqual([0, 180]);
    // Inbound leg is the fix's own meridian, halfway back; outbound is 2 NM east.
    const [inX, inY] = nm(arrows[0].at);
    expect(inX).toBeCloseTo(0, 6);
    expect(inY).toBeCloseTo(-2, 6);
    const [outX, outY] = nm(arrows[1].at);
    expect(outX).toBeCloseTo(2, 6);
    expect(outY).toBeCloseTo(-2, 6);
    // A left hold puts the outbound arrow on the west side.
    const left = holdMarks(0, 0, {
      ...base,
      inboundTrue: 0,
      inboundMag: 7,
      turn: "L",
    }).filter((m) => m.kind === "arrow");
    expect(nm(left[1].at)[0]).toBeCloseTo(-2, 6);
  });

  test("courses are the published magnetic inbound and its reciprocal", () => {
    const texts = holdMarks(0, 0, {
      ...base,
      inboundTrue: 340,
      inboundMag: 347,
      turn: "R",
    }).flatMap((m) => (m.kind === "course" ? [m.text] : []));
    expect(texts).toEqual(["347°", "167°"]);
  });

  // Every inbound course, both turn directions: the text never reads upside down
  // and is pushed to the outside of the racetrack, not across the other leg.
  test.each(["L", "R"] as const)(
    "course labels read upright and sit outside (%s turns)",
    (turn) => {
      for (let inbound = 0; inbound < 360; inbound += 15) {
        const shape = {
          ...base,
          inboundTrue: inbound,
          inboundMag: inbound,
          turn,
        };
        const th = (inbound * Math.PI) / 180;
        const u = [Math.sin(th), Math.cos(th)];
        const n = turn === "R" ? [u[1], -u[0]] : [-u[1], u[0]];
        const centre = [n[0] - 2 * u[0], n[1] - 2 * u[1]];
        for (const m of holdMarks(0, 0, shape)) {
          if (m.kind !== "course") continue;
          expect(m.rotate).toBeGreaterThan(-90);
          expect(m.rotate).toBeLessThanOrEqual(90);
          // Text "up" points at true bearing `rotate`; side -1 moves up.
          const b =
            (((m.side < 0 ? m.rotate : m.rotate + 180) % 360) * Math.PI) / 180;
          const [x, y] = nm(m.at);
          const outward =
            Math.sin(b) * (x - centre[0]) + Math.cos(b) * (y - centre[1]);
          expect(outward).toBeGreaterThan(0.5);
        }
      }
    },
  );
});
