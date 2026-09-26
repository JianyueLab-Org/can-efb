import { describe, expect, test } from "bun:test";
import type { MapPoint } from "./mapBus";
import { smoothProcedureTurns } from "./procedureGeometry";

// 赤道附近：1 NM ≈ 1/60°，局部平面几乎无畸变。
const nm = 1 / 60;
const pt = (
  ident: string,
  x: number,
  y: number,
  extra: Partial<MapPoint> = {},
): MapPoint => ({
  ident,
  lat: y * nm,
  lon: x * nm,
  kind: "sid",
  via: "TEST1",
  ...extra,
});

const xy = (p: MapPoint): [number, number] => [p.lon / nm, p.lat / nm];

describe("smoothProcedureTurns", () => {
  test("leaves straight lines and short inputs alone", () => {
    const line = [pt("A", 0, 0), pt("B", 10, 0), pt("C", 20, 0)];
    expect(smoothProcedureTurns(line)).toEqual(line);
    expect(smoothProcedureTurns(line.slice(0, 2))).toEqual(line.slice(0, 2));
  });

  test("does not touch enroute corners", () => {
    const line = [
      pt("A", 0, 0, { kind: "fix" }),
      pt("B", 10, 0, { kind: "fix" }),
      pt("C", 10, 10, { kind: "fix" }),
    ];
    expect(smoothProcedureTurns(line)).toEqual(line);
  });

  test("fly-by cuts the corner and keeps the fix for labels only", () => {
    const out = smoothProcedureTurns([
      pt("A", 0, 0),
      pt("B", 10, 0),
      pt("C", 10, 10),
    ]);
    const corner = out.find((p) => p.ident === "B");
    expect(corner?.offPath).toBe(true);
    const onPath = out.filter((p) => !p.offPath);
    // Every arc point stays inside the corner: x ≤ 10, y ≥ 0.
    for (const p of onPath) {
      const [x, y] = xy(p);
      expect(x).toBeLessThanOrEqual(10 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
    }
    // Arc ends on the outbound leg (x = 10).
    const last = onPath[onPath.length - 2];
    expect(xy(last)[0]).toBeCloseTo(10, 4);
    // Shape points carry no ident.
    expect(out.filter((p) => p.shape).every((p) => p.ident === "")).toBe(true);
  });

  test("a turn against the short way loops around after the fix", () => {
    // Heading east, next fix due north, but the leg says turn right.
    const out = smoothProcedureTurns([
      pt("A", 0, 0),
      pt("B", 10, 0, { turn: "R" }),
      pt("C", 10, 10),
    ]);
    const b = out.find((p) => p.ident === "B");
    expect(b?.offPath).toBeUndefined();
    const arc = out.filter((p) => p.shape).map(xy);
    // A right turn from east goes south first.
    expect(Math.min(...arc.map(([, y]) => y))).toBeLessThan(-1);
    // The last arc point heads straight at C.
    const [tx, ty] = arc[arc.length - 1];
    const [px, py] = arc[arc.length - 2];
    const heading = Math.atan2(ty - py, tx - px);
    const toC = Math.atan2(10 - ty, 10 - tx);
    expect(Math.abs(heading - toC)).toBeLessThan(0.2);
  });

  test("fly-over turns after the fix, on the short side", () => {
    const out = smoothProcedureTurns([
      pt("A", 0, 0),
      pt("B", 10, 0, { flyover: true }),
      pt("C", 10, 10),
    ]);
    const arc = out.filter((p) => p.shape).map(xy);
    expect(arc.length).toBeGreaterThan(2);
    // Left turn: the arc bulges east of B.
    expect(Math.max(...arc.map(([x]) => x))).toBeGreaterThan(10);
  });

  test("arc points take the via of the leg they belong to", () => {
    const out = smoothProcedureTurns([
      pt("A", 0, 0),
      pt("B", 10, 0),
      pt("C", 10, 10, { kind: "fix", via: "Y71" }),
    ]);
    const shapes = out.filter((p) => p.shape);
    expect(shapes[0].via).toBe("TEST1");
    expect(shapes[shapes.length - 1].via).toBe("Y71");
  });

  test("skips label-only points when finding the legs around a turn", () => {
    const out = smoothProcedureTurns([
      pt("A", 0, 0, { kind: "approach" }),
      pt("B", 10, 0, { kind: "approach" }),
      pt("APT", 50, 50, { kind: "airport", offPath: true }),
      pt("M", 10, 10, { kind: "missed" }),
    ]);
    // The arc at B turns toward M, not toward the airport.
    const arc = out.filter((p) => p.shape).map(xy);
    for (const [x, y] of arc) {
      expect(x).toBeLessThanOrEqual(10 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(out.find((p) => p.ident === "APT")?.offPath).toBe(true);
  });
});
