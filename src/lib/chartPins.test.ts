import { describe, expect, test } from "bun:test";
import type { ChartEntry } from "@/lib/charts";
import { EMPTY_SELECTION } from "@/lib/procedureSelection";
import {
  autoPins,
  chartRunways,
  EMPTY_PINS,
  isPinned,
  matchesApproach,
  matchesRoute,
  normalizeRunway,
  parseApproachLabel,
  parsePins,
  pinnedCharts,
  pinsKey,
  procedureFix,
  readPins,
  readPlan,
  roleOf,
  sortByCategory,
  togglePin,
  unmatchedProcedures,
  writePins,
} from "@/lib/chartPins";

function chart(
  id: number,
  category: ChartEntry["category"],
  name: string,
): ChartEntry {
  return { id, category, name, page: null, kind: "", isSup: false, bytes: 1 };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

/** ZSPD 2610 的真实航图名。 */
const ZSPD: ChartEntry[] = [
  chart(1, "TAXI", "机场图"),
  chart(2, "TAXI", "停机位置图"),
  chart(3, "TAXI", "机场地面活动图"),
  chart(10, "SID", "RNAVRWY34L34R35L35R(PIKAS)"),
  chart(11, "SID", "RWY16L16R17L17R(PIKASODULO)"),
  chart(20, "STAR", "RNAVRWY16L16R34L34R(DUMET)"),
  chart(21, "STAR", "RWY34L34R35L35R(MATNUDUMETBKANDSASAN)"),
  chart(30, "APP", "ILSDMEyRWY16L"),
  chart(31, "APP", "RNAVILSDMEzRWY16L"),
  chart(32, "APP", "RNPRWY35R"),
  chart(33, "APP", "VORDMERWY17L"),
  chart(34, "APP", "RNAVILSDMEyRWY35R"),
];
const byId = (id: number) => ZSPD.find((c) => c.id === id)!;

describe("readPlan / roleOf", () => {
  test("起降两个，备降有才加", () => {
    expect(
      readPlan({ departure: "zspd", arrival: " ZBAA ", alternate: "" }),
    ).toEqual({
      departure: "ZSPD",
      arrival: "ZBAA",
      airports: [
        { role: "departure", icao: "ZSPD" },
        { role: "arrival", icao: "ZBAA" },
      ],
    });
    expect(
      readPlan({ departure: "ZSPD", arrival: "ZBAA", alternate: "ZBTJ" })
        ?.airports,
    ).toHaveLength(3);
  });

  test("缺起飞或落地就是没有计划", () => {
    expect(readPlan({ departure: "ZSPD" })).toBeNull();
    expect(readPlan(null)).toBeNull();
    expect(readPlan({ departure: 1, arrival: "ZBAA" })).toBeNull();
  });

  test("roleOf 按起飞、落地、备降的顺序认第一个", () => {
    const plan = readPlan({ departure: "ZSPD", arrival: "ZSPD" })!;
    expect(roleOf(plan, "zspd")).toBe("departure");
    expect(roleOf(plan, "ZBAA")).toBeNull();
  });
});

describe("名称解析", () => {
  test("procedureFix 取第一个数字之前的字母", () => {
    expect(procedureFix("PIKAS6D")).toBe("PIKAS");
    expect(procedureFix("dumet1a")).toBe("DUMET");
    expect(procedureFix("")).toBe("");
  });

  test("normalizeRunway 去掉 RW / RWY 前缀", () => {
    expect(normalizeRunway("rw16l")).toBe("16L");
    expect(normalizeRunway("RWY34R")).toBe("34R");
    expect(normalizeRunway("01")).toBe("01");
  });

  test("chartRunways 拆 RWY 后面那一串", () => {
    expect(chartRunways("RNAVRWY34L34R35L35R(PIKAS)")).toEqual([
      "34L",
      "34R",
      "35L",
      "35R",
    ]);
    expect(chartRunways("ILSDMEyRWY16L")).toEqual(["16L"]);
    expect(chartRunways("机场图")).toEqual([]);
  });

  test("parseApproachLabel", () => {
    expect(parseApproachLabel("R01-Y")).toEqual({
      type: "R",
      runway: "01",
      variant: "y",
    });
    expect(parseApproachLabel("I16L")).toEqual({
      type: "I",
      runway: "16L",
      variant: "",
    });
    expect(parseApproachLabel("PIKAS6D")).toBeNull();
  });
});

describe("matchesRoute", () => {
  test("SID：定位点在括号里，跑道在 RWY 那一串里", () => {
    expect(matchesRoute(byId(10), "PIKAS6D", "34L")).toBe(true);
    expect(matchesRoute(byId(11), "PIKAS6D", "34L")).toBe(false);
    expect(matchesRoute(byId(11), "PIKAS6D", "RW16L")).toBe(true);
  });

  test("没选跑道就不查跑道", () => {
    expect(matchesRoute(byId(10), "PIKAS6D", "")).toBe(true);
    expect(matchesRoute(byId(11), "PIKAS6D", "")).toBe(true);
  });

  test("STAR：括号里拼在一起的定位点也算", () => {
    expect(matchesRoute(byId(20), "DUMET1A", "16L")).toBe(true);
    expect(matchesRoute(byId(21), "DUMET1A", "16L")).toBe(false);
    expect(matchesRoute(byId(21), "DUMET1A", "34L")).toBe(true);
  });

  test("已知误中：AND 命中 BKANDSASAN，照样算匹配", () => {
    expect(matchesRoute(byId(21), "AND1A", "")).toBe(true);
  });

  test("没有括号的名字永远不中", () => {
    expect(matchesRoute(byId(1), "PIKAS6D", "")).toBe(false);
  });
});

describe("matchesApproach", () => {
  test("I：名字里有 ILS；不带变体时 y、z 都中", () => {
    expect(matchesApproach(byId(30), "I16L")).toBe(true);
    expect(matchesApproach(byId(31), "I16L")).toBe(true);
    expect(matchesApproach(byId(32), "I16L")).toBe(false);
  });

  test("变体对上 RWY 前面那个小写字母", () => {
    expect(matchesApproach(byId(30), "I16L-Y")).toBe(true);
    expect(matchesApproach(byId(31), "I16L-Y")).toBe(false);
    expect(matchesApproach(byId(31), "I16L-Z")).toBe(true);
  });

  test("R：RNP / RNAV 开头且不含 ILS", () => {
    expect(matchesApproach(byId(32), "R35R")).toBe(true);
    expect(matchesApproach(byId(34), "R35R")).toBe(false);
  });

  test("D、V 都认 VOR；跑道要完全一致", () => {
    expect(matchesApproach(byId(33), "D17L")).toBe(true);
    expect(matchesApproach(byId(33), "V17L")).toBe(true);
    expect(matchesApproach(byId(33), "V17R")).toBe(false);
  });
});

describe("autoPins / unmatchedProcedures", () => {
  test("起飞：机场图、停机位置图，加选中的 SID", () => {
    const sel = { ...EMPTY_SELECTION, sid: "PIKAS6D", depRunway: "34L" };
    expect([...autoPins(ZSPD, "departure", sel)].sort((a, b) => a - b)).toEqual(
      [1, 2, 10],
    );
    expect([...autoPins(ZSPD, "departure", EMPTY_SELECTION)]).toEqual([1, 2]);
  });

  test("落地：机场图、停机位置图，加 STAR 和进近", () => {
    const sel = {
      ...EMPTY_SELECTION,
      star: "DUMET1A",
      arrRunway: "16L",
      approach: "I16L-Y",
    };
    expect([...autoPins(ZSPD, "arrival", sel)].sort((a, b) => a - b)).toEqual([
      1, 2, 20, 30,
    ]);
  });

  test("备降：只有机场图，也不看程序", () => {
    const sel = { ...EMPTY_SELECTION, sid: "PIKAS6D", star: "DUMET1A" };
    expect([...autoPins(ZSPD, "alternate", sel)]).toEqual([1]);
  });

  test("选了程序却一张都没中，要说出来", () => {
    const sel = { ...EMPTY_SELECTION, star: "DUMET1A", approach: "N16L" };
    expect(unmatchedProcedures(ZSPD, "arrival", sel)).toEqual(["N16L"]);
    expect(
      unmatchedProcedures(ZSPD, "departure", {
        ...EMPTY_SELECTION,
        sid: "XYZ1A",
      }),
    ).toEqual(["XYZ1A"]);
    expect(unmatchedProcedures(ZSPD, "alternate", sel)).toEqual([]);
  });
});

describe("存储", () => {
  test("pinsKey 和程序选择的键同一种写法", () => {
    expect(pinsKey("zspd", " zbaa")).toBe("efb:chart-pins:ZSPD-ZBAA");
  });

  test("parsePins：坏数据、非正整数一律丢掉", () => {
    expect(parsePins(null)).toEqual(EMPTY_PINS);
    expect(parsePins("{")).toEqual(EMPTY_PINS);
    expect(parsePins("[1]")).toEqual(EMPTY_PINS);
    expect(parsePins('{"pinned":[1,"x",-2,1,1.5],"unpinned":null}')).toEqual({
      pinned: [1],
      unpinned: [],
    });
  });

  test("readPins：localStorage 会抛就当空的", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readPins("ZSPD", "ZBAA", throwing)).toEqual(EMPTY_PINS);
    expect(readPins("ZSPD", "ZBAA", null)).toEqual(EMPTY_PINS);
  });

  test("写进去再读出来；写空的就删键", () => {
    const storage = memoryStorage();
    writePins("ZSPD", "ZBAA", { pinned: [3], unpinned: [10] }, storage);
    expect(readPins("ZSPD", "ZBAA", storage)).toEqual({
      pinned: [3],
      unpinned: [10],
    });
    writePins("ZSPD", "ZBAA", EMPTY_PINS, storage);
    expect(storage.data.has("efb:chart-pins:ZSPD-ZBAA")).toBe(false);
  });

  test("writePins：setItem 会抛也不往外抛", () => {
    const throwing = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() =>
      writePins("ZSPD", "ZBAA", { pinned: [1], unpinned: [] }, throwing),
    ).not.toThrow();
  });
});

describe("合并与切换", () => {
  const auto = new Set([1, 10]);

  test("自动 + 手动钉住 − 手动取消；索引里没有的 id 不出现", () => {
    const pins = { pinned: [3, 999], unpinned: [10] };
    expect(pinnedCharts(ZSPD, auto, pins).map((c) => c.id)).toEqual([1, 3]);
  });

  test("取消自动的进 unpinned，再钉回去就从 unpinned 拿掉", () => {
    const off = togglePin(EMPTY_PINS, 10, auto);
    expect(off).toEqual({ pinned: [], unpinned: [10] });
    expect(isPinned(10, auto, off)).toBe(false);
    const on = togglePin(off, 10, auto);
    expect(on).toEqual({ pinned: [], unpinned: [] });
    expect(isPinned(10, auto, on)).toBe(true);
  });

  test("手动钉住的进 pinned，取消就从 pinned 拿掉", () => {
    const on = togglePin(EMPTY_PINS, 3, auto);
    expect(on).toEqual({ pinned: [3], unpinned: [] });
    expect(togglePin(on, 3, auto)).toEqual({ pinned: [], unpinned: [] });
  });

  test("sortByCategory 按 STAR APP TAXI SID REF，类别内保持原顺序", () => {
    expect(sortByCategory(ZSPD).map((c) => c.id)).toEqual([
      20, 21, 30, 31, 32, 33, 34, 1, 2, 3, 10, 11,
    ]);
  });
});
