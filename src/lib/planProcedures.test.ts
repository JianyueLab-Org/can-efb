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

/**
 * ZBAA OMDE9Z：`aip/resolve` 把整串腿都展开 —— RW01、RW36L、RW36R 三条转换来回穿插。
 * 代号和结构照抄，坐标是合成的（导航数据不进这个公开仓库）。
 */
describe("航路串里写着、本机没选的程序", () => {
  const t = (ident: string, transition: string, at: number): ProcedureLeg => ({
    ...leg(ident, at, at),
    transition,
  });
  const omde9z = [
    t("AA171", "RW01", 1),
    t("AA137", "ALL", 2),
    t("AA197", "ALL", 3),
    t("AA111", "RW36L", 4),
    t("AA197", "RW36L", 3),
    t("AA131", "RW36R", 5),
    t("AA197", "RW36R", 3),
    { ...t("AA197", "ALL", 3), path: "IF" },
    t("OMDEK", "ALL", 6),
  ];
  const zbaa: AirportProcedures = {
    ...dep,
    icao: "ZBAA",
    procedures: [
      {
        kind: "sid",
        name: "OMDE9Z",
        runway: null,
        runways: "01,36L,36R",
        chart: null,
        variant: null,
        points: [],
        path: omde9z,
      },
    ],
  };
  // 和 can-db 的 resolve 一样：每条有坐标的腿依次一个点，相邻同坐标的收掉。
  const expanded: MapPoint[] = [
    { ident: "ZBAA", lat: 0, lon: 0, kind: "airport" },
    ...omde9z
      .filter((l, i, all) => i === 0 || l.lat !== all[i - 1].lat)
      .map((l) => ({
        ident: l.ident,
        lat: l.lat as number,
        lon: l.lon as number,
        kind: "sid",
        via: "OMDE9Z",
      })),
    { ident: "OMDEK", lat: 6, lon: 6, kind: "fix" },
    { ident: "ZSSS", lat: 9, lon: 9, kind: "airport" },
  ];
  const idents = (out: MapPoint[]) =>
    out.filter((p) => !p.shape).map((p) => p.ident);

  test("没选任何东西时只画公共段，不画三条跑道转换", () => {
    const out = applySelectionTo(expanded, EMPTY_SELECTION, zbaa, null);
    expect(idents(out)).toEqual(["ZBAA", "AA197", "OMDEK", "ZSSS"]);
  });

  test("只选了跑道时画那条跑道的转换", () => {
    const out = applySelectionTo(
      expanded,
      { ...EMPTY_SELECTION, depRunway: "36L" },
      zbaa,
      null,
    );
    expect(idents(out)).toEqual(["ZBAA", "AA111", "AA197", "OMDEK", "ZSSS"]);
  });

  test("机场数据没取到时 resolve 那一段原样留着", () => {
    const out = applySelectionTo(expanded, EMPTY_SELECTION, null, null);
    expect(idents(out)).toContain("AA111");
    expect(idents(out)).toContain("AA131");
  });
});
