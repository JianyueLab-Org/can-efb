import { describe, expect, test } from "bun:test";
import type { MapPoint } from "./mapBus";
import { applySelectionTo } from "./planProcedures";
import { EMPTY_SELECTION } from "./procedureSelection";
import type { AirportProcedures, ProcedureLeg } from "./procedures";

const leg = (ident: string, lat: number, lon: number): ProcedureLeg => ({
  ident,
  lat,
  lon,
  path: null,
  transition: null,
  routeType: null,
  alt: null,
  speedKt: null,
  speedKind: null,
  turn: null,
  courseMag: null,
  vpaDeg: null,
  flyover: null,
  isMap: null,
  part: null,
});

const dep: AirportProcedures = {
  icao: "RJOO",
  variation: null,
  runways: [],
  runwayDetails: [],
  procedures: [
    {
      kind: "sid",
      name: "IZUMI1",
      runway: null,
      runways: null,
      chart: null,
      variant: null,
      points: [],
      path: [leg("IZU", 0, 1), leg("FIX", 0, 2)],
    },
  ],
};

const resolved: MapPoint[] = [
  { ident: "RJOO", lat: 0, lon: 0, kind: "airport" },
  { ident: "OLD", lat: 1, lon: 1, kind: "sid", via: "ASUKA4" },
  { ident: "FIX", lat: 0, lon: 2, kind: "fix" },
  { ident: "RJTT", lat: 0, lon: 3, kind: "airport" },
];

describe("applySelectionTo", () => {
  test("no selection keeps resolve's points", () => {
    const out = applySelectionTo(resolved, EMPTY_SELECTION, null, null);
    expect(out.filter((p) => !p.shape).map((p) => p.ident)).toEqual([
      "RJOO",
      "OLD",
      "FIX",
      "RJTT",
    ]);
  });

  test("a selected SID replaces resolve's SID points", () => {
    const out = applySelectionTo(
      resolved,
      { ...EMPTY_SELECTION, sid: "IZUMI1" },
      dep,
      null,
    );
    expect(out.filter((p) => !p.shape).map((p) => p.ident)).toEqual([
      "RJOO",
      "IZU",
      "FIX",
      "RJTT",
    ]);
  });

  test("a selection whose airport failed to load falls back to resolve", () => {
    const out = applySelectionTo(
      resolved,
      { ...EMPTY_SELECTION, sid: "IZUMI1" },
      null,
      null,
    );
    expect(out.some((p) => p.ident === "OLD")).toBe(true);
  });
});
