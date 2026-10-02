# Chart Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Charts button on the map opens a popover with the charts for the member's flight plan, auto-pins the ones the plan and procedure selection call for, and lets members pin and unpin by hand, both there and in airport details.

**Architecture:** Matching, plan reading and pin storage are pure functions in `src/lib/chartPins.ts` with bun tests. `ChartPins.vue` is the popover, mounted by `MapStage.vue` and toggled by a new button in `MapControls.vue`. `AirportCharts.vue` gains the same pin button through a shared `ChartPinButton.vue`. Pins live in localStorage per departure-arrival pair.

**Tech Stack:** Astro 7, Vue 3 (`<script setup lang="ts">`), Tailwind 4, `bun test`, can-ui `Icon`.

**Spec:** `docs/superpowers/specs/2026-10-02-chart-pins-design.md`

## Global Constraints

- No `/charts` page. Airport details keep their chart tab.
- All `/api/db/*` calls go through `dbFetch` (`@/lib/naip`).
- can-db decides access. The EFB shows the result and does not re-check it.
- Failure is never drawn as empty. Each empty state says why.
- The mapBus stays one-way, panel to map. The map opening its own viewer is allowed.
- Islands receive only the message keys they use.
- Pure logic lives in `lib/*.ts` with tests.
- `ChartViewer.vue` is unchanged.
- Storage key: `efb:chart-pins:{DEP}-{ARR}`. Value: `{ pinned: number[], unpinned: number[] }`. Entries are `ChartEntry.id` (positive integers).
- Event: `efb:chart-pins-changed` on `window`.
- New user-facing strings go into all four of `language/zh-cn.json`, `zh-tw.json`, `en-us.json`, `ja-jp.json` (`bun run check:i18n` fails otherwise). Code comments match the surrounding Chinese.
- The working tree carries unrelated uncommitted work (`Airports.vue`, `airports.ts`, `config.ts`, `requestState.ts`, `airports.astro`, `api/db/[...path].ts`, `README.md`, staged deletion of `src/server/canDb.ts`). Never stage or commit it. Commit only the files a task names, with `git commit -m "…" -- <paths>` (pathspec commits only those paths). Never `git add -A` or `git add .`.
- Commits are signed through a YubiKey and can hang. Run them as `perl -e 'alarm 40; exec @ARGV' git commit …`. On timeout, retry with `git -c commit.gpgsign=false commit …` and report the commit as unsigned.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Scratch files go in `can-efb/.temp/`, never `/tmp`.

---

### Task 1: `lib/chartPins.ts` — plan, matching, storage

**Files:**
- Create: `src/lib/chartPins.ts`
- Test: `src/lib/chartPins.test.ts`

**Interfaces:**
- Consumes: `CHART_CATEGORIES`, `ChartEntry` from `@/lib/charts`; `ProcedureSelection`, `EMPTY_SELECTION` from `@/lib/procedureSelection`.
- Produces:
  - `type PinRole = "departure" | "arrival" | "alternate"`
  - `interface PlanAirport { role: PinRole; icao: string }`
  - `interface PinPlan { departure: string; arrival: string; airports: PlanAirport[] }`
  - `readPlan(data: { departure?: unknown; arrival?: unknown; alternate?: unknown } | null | undefined): PinPlan | null`
  - `roleOf(plan: PinPlan, icao: string): PinRole | null`
  - `procedureFix(label: string): string`
  - `normalizeRunway(runway: string): string`
  - `chartRunways(name: string): string[]`
  - `matchesRoute(chart: ChartEntry, label: string, runway: string): boolean`
  - `interface ApproachLabel { type: string; runway: string; variant: string }`
  - `parseApproachLabel(label: string): ApproachLabel | null`
  - `matchesApproach(chart: ChartEntry, label: string): boolean`
  - `autoPins(charts: readonly ChartEntry[], role: PinRole, selection: ProcedureSelection): Set<number>`
  - `unmatchedProcedures(charts: readonly ChartEntry[], role: PinRole, selection: ProcedureSelection): string[]`
  - `sortByCategory(charts: readonly ChartEntry[]): ChartEntry[]`
  - `const CHART_PINS_CHANGED_EVENT = "efb:chart-pins-changed"`
  - `interface StoredPins { pinned: number[]; unpinned: number[] }`
  - `const EMPTY_PINS: StoredPins`
  - `pinsKey(departure: string, arrival: string): string`
  - `parsePins(raw: string | null): StoredPins`
  - `readPins(departure, arrival, storage?: Pick<Storage, "getItem"> | null): StoredPins`
  - `writePins(departure, arrival, pins: StoredPins, storage?: Pick<Storage, "setItem" | "removeItem"> | null): void`
  - `isPinned(id: number, auto: ReadonlySet<number>, pins: StoredPins): boolean`
  - `togglePin(pins: StoredPins, id: number, auto: ReadonlySet<number>): StoredPins`
  - `pinnedCharts(charts: readonly ChartEntry[], auto: ReadonlySet<number>, pins: StoredPins): ChartEntry[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/chartPins.test.ts`:

```ts
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
      unmatchedProcedures(ZSPD, "departure", { ...EMPTY_SELECTION, sid: "XYZ1A" }),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/lib/chartPins.test.ts`
Expected: FAIL — cannot resolve `@/lib/chartPins`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/chartPins.ts`:

```ts
/**
 * 航图钉住：按飞行计划挑出起飞、落地、备降三个机场该看的航图（自动钉住），加上
 * 成员手动钉住的，减去手动取消的。地图上的「航图」弹出层（`ChartPins.vue`）和机场
 * 详情的航图标签（`AirportCharts.vue`）共用这一份。纯逻辑加一层 localStorage。
 *
 * 匹配按 NAIP 航图名的写法：`RNAVRWY34L34R35L35R(PIKAS)`、`ILSDMEyRWY16L`。
 * 已知局限：定位点是对括号里拼在一起的名字做子串匹配，`AND` 会命中
 * `BKANDSASAN`。自动钉住的带「自动」标记，成员可以取消。
 */
import { CHART_CATEGORIES, type ChartEntry } from "@/lib/charts";
import type { ProcedureSelection } from "@/lib/procedureSelection";

export type PinRole = "departure" | "arrival" | "alternate";

export interface PlanAirport {
  role: PinRole;
  icao: string;
}

export interface PinPlan {
  departure: string;
  arrival: string;
  airports: PlanAirport[];
}

function code(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** 飞行计划 → 三个机场。没有起飞或落地就是没有计划；备降没填就没有那一组。 */
export function readPlan(
  data:
    | { departure?: unknown; arrival?: unknown; alternate?: unknown }
    | null
    | undefined,
): PinPlan | null {
  const departure = code(data?.departure);
  const arrival = code(data?.arrival);
  const alternate = code(data?.alternate);
  if (!departure || !arrival) return null;
  const airports: PlanAirport[] = [
    { role: "departure", icao: departure },
    { role: "arrival", icao: arrival },
  ];
  if (alternate) airports.push({ role: "alternate", icao: alternate });
  return { departure, arrival, airports };
}

/** 这个机场在计划里是哪一个。起降是同一个机场时算起飞。 */
export function roleOf(plan: PinPlan, icao: string): PinRole | null {
  const c = code(icao);
  return plan.airports.find((a) => a.icao === c)?.role ?? null;
}

// ------------------------------------------------------------------ 匹配

const TAXI_MAIN = "机场图";
const TAXI_STANDS = "停机位置图";

/** 程序标签里第一个数字之前的字母：`PIKAS6D` → `PIKAS`。 */
export function procedureFix(label: string): string {
  return /^[A-Z]+/.exec(code(label))?.[0] ?? "";
}

/** 选择里存的跑道可能带 `RW` / `RWY` 前缀。 */
export function normalizeRunway(runway: string): string {
  return code(runway).replace(/^RWY?/, "");
}

/** 航图名里 `RWY` 后面那一串跑道号：`RWY34L34R35L35R` → 四条。 */
export function chartRunways(name: string): string[] {
  const upper = name.toUpperCase();
  const at = upper.indexOf("RWY");
  if (at < 0) return [];
  const run = /^(?:\d{2}[LRC]?)+/.exec(upper.slice(at + 3))?.[0] ?? "";
  return run.match(/\d{2}[LRC]?/g) ?? [];
}

function bracket(name: string): string {
  return /\(([^)]*)\)/.exec(name)?.[1]?.toUpperCase() ?? "";
}

/** SID / STAR：括号里含定位点；选了跑道时跑道在名字的跑道串里。 */
export function matchesRoute(
  chart: ChartEntry,
  label: string,
  runway: string,
): boolean {
  const fix = procedureFix(label);
  if (!fix || !bracket(chart.name).includes(fix)) return false;
  const rwy = normalizeRunway(runway);
  return !rwy || chartRunways(chart.name).includes(rwy);
}

export interface ApproachLabel {
  /** 第一个字母：I、R、D、V、N、L。 */
  type: string;
  runway: string;
  /** 小写的变体字母，没有是空串。 */
  variant: string;
}

/** `R01-Y` → R / 01 / y。读不懂回 null。 */
export function parseApproachLabel(label: string): ApproachLabel | null {
  const m = /^([A-Z])(\d{2}[LRC]?)(?:-([A-Z]))?$/.exec(code(label));
  if (!m) return null;
  return { type: m[1]!, runway: m[2]!, variant: (m[3] ?? "").toLowerCase() };
}

const APPROACH_TYPE: Record<string, (upperName: string) => boolean> = {
  I: (n) => n.includes("ILS"),
  R: (n) => (n.startsWith("RNP") || n.startsWith("RNAV")) && !n.includes("ILS"),
  D: (n) => n.includes("VOR"),
  V: (n) => n.includes("VOR"),
  N: (n) => n.includes("NDB"),
  L: (n) => n.includes("LOC"),
};

/** `RWY` 前面那个小写字母：`ILSDMEyRWY16L` → `y`。 */
function chartVariant(name: string): string {
  const at = name.toUpperCase().indexOf("RWY");
  const ch = at > 0 ? name[at - 1]! : "";
  return /^[a-z]$/.test(ch) ? ch : "";
}

/** 进近：类型、跑道（完全一致）、变体（标签不带变体时不查）。 */
export function matchesApproach(chart: ChartEntry, label: string): boolean {
  const a = parseApproachLabel(label);
  if (!a) return false;
  const isType = APPROACH_TYPE[a.type];
  if (!isType || !isType(chart.name.toUpperCase())) return false;
  if (!chartRunways(chart.name).includes(a.runway)) return false;
  return !a.variant || chartVariant(chart.name) === a.variant;
}

interface SelectedProcedure {
  label: string;
  matches: (chart: ChartEntry) => boolean;
}

/** 这个机场选了哪几个程序。备降不看程序。 */
function selectedProcedures(
  role: PinRole,
  sel: ProcedureSelection,
): SelectedProcedure[] {
  const out: SelectedProcedure[] = [];
  if (role === "departure" && sel.sid) {
    out.push({
      label: sel.sid,
      matches: (c) =>
        c.category === "SID" && matchesRoute(c, sel.sid, sel.depRunway),
    });
  }
  if (role === "arrival" && sel.star) {
    out.push({
      label: sel.star,
      matches: (c) =>
        c.category === "STAR" && matchesRoute(c, sel.star, sel.arrRunway),
    });
  }
  if (role === "arrival" && sel.approach) {
    out.push({
      label: sel.approach,
      matches: (c) => c.category === "APP" && matchesApproach(c, sel.approach),
    });
  }
  return out;
}

export function autoPins(
  charts: readonly ChartEntry[],
  role: PinRole,
  selection: ProcedureSelection,
): Set<number> {
  const taxi =
    role === "alternate" ? [TAXI_MAIN] : [TAXI_MAIN, TAXI_STANDS];
  const procedures = selectedProcedures(role, selection);
  const out = new Set<number>();
  for (const c of charts) {
    const isTaxi = c.category === "TAXI" && taxi.includes(c.name.trim());
    if (isTaxi || procedures.some((p) => p.matches(c))) out.add(c.id);
  }
  return out;
}

/** 选了、却一张航图都没中的程序标签。弹出层据此说一句，不让它安静地少一张。 */
export function unmatchedProcedures(
  charts: readonly ChartEntry[],
  role: PinRole,
  selection: ProcedureSelection,
): string[] {
  return selectedProcedures(role, selection)
    .filter((p) => !charts.some(p.matches))
    .map((p) => p.label);
}

/** 按 `CHART_CATEGORIES` 的显示顺序排，类别内保持原顺序（`sort` 是稳定的）。 */
export function sortByCategory(charts: readonly ChartEntry[]): ChartEntry[] {
  return [...charts].sort(
    (a, b) =>
      CHART_CATEGORIES.indexOf(a.category) -
      CHART_CATEGORIES.indexOf(b.category),
  );
}

// ------------------------------------------------------------------ 存储

/** 钉住变了。不带内容，收到的一方自己读。 */
export const CHART_PINS_CHANGED_EVENT = "efb:chart-pins-changed";

const PREFIX = "efb:chart-pins:";

export interface StoredPins {
  pinned: number[];
  unpinned: number[];
}

export const EMPTY_PINS: StoredPins = Object.freeze({
  pinned: [],
  unpinned: [],
}) as StoredPins;

export function pinsKey(departure: string, arrival: string): string {
  return `${PREFIX}${code(departure)}-${code(arrival)}`;
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ok = value.filter(
    (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
  );
  return [...new Set(ok)];
}

export function parsePins(raw: string | null): StoredPins {
  if (!raw) return { pinned: [], unpinned: [] };
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { pinned: [], unpinned: [] };
    }
    const r = v as Record<string, unknown>;
    return { pinned: ids(r.pinned), unpinned: ids(r.unpinned) };
  } catch {
    return { pinned: [], unpinned: [] };
  }
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 读不出来（隐私模式、被禁用、存坏了）一律当空的。 */
export function readPins(
  departure: string,
  arrival: string,
  storage: Pick<Storage, "getItem"> | null = localStorageOrNull(),
): StoredPins {
  try {
    return parsePins(storage?.getItem(pinsKey(departure, arrival)) ?? null);
  } catch {
    return { pinned: [], unpinned: [] };
  }
}

export function writePins(
  departure: string,
  arrival: string,
  pins: StoredPins,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = localStorageOrNull(),
): void {
  const key = pinsKey(departure, arrival);
  try {
    if (!pins.pinned.length && !pins.unpinned.length) storage?.removeItem(key);
    else
      storage?.setItem(
        key,
        JSON.stringify({ pinned: pins.pinned, unpinned: pins.unpinned }),
      );
  } catch {
    // 存不下时当作没存，下次读到的是空的。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHART_PINS_CHANGED_EVENT));
  }
}

export function isPinned(
  id: number,
  auto: ReadonlySet<number>,
  pins: StoredPins,
): boolean {
  if (pins.unpinned.includes(id)) return false;
  return auto.has(id) || pins.pinned.includes(id);
}

/**
 * 切换一张。取消自动的记进 `unpinned`，取消手动的从 `pinned` 拿掉；钉回自动的从
 * `unpinned` 拿掉，钉手动的记进 `pinned`。
 */
export function togglePin(
  pins: StoredPins,
  id: number,
  auto: ReadonlySet<number>,
): StoredPins {
  const without = (list: number[]) => list.filter((x) => x !== id);
  if (isPinned(id, auto, pins)) {
    return {
      pinned: without(pins.pinned),
      unpinned: auto.has(id) ? [...without(pins.unpinned), id] : without(pins.unpinned),
    };
  }
  return {
    pinned: auto.has(id) ? without(pins.pinned) : [...without(pins.pinned), id],
    unpinned: without(pins.unpinned),
  };
}

/** 钉住的那几张，按类别排。存储里有、索引里没有的 id 不出现。 */
export function pinnedCharts(
  charts: readonly ChartEntry[],
  auto: ReadonlySet<number>,
  pins: StoredPins,
): ChartEntry[] {
  return sortByCategory(charts.filter((c) => isPinned(c.id, auto, pins)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/chartPins.test.ts`
Expected: PASS, all tests.

Run: `bunx prettier --write src/lib/chartPins.ts src/lib/chartPins.test.ts && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
perl -e 'alarm 40; exec @ARGV' git commit -m "lib/chartPins.ts: plan airports, chart matching, pin storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/chartPins.ts src/lib/chartPins.test.ts
```

(`git add src/lib/chartPins.ts src/lib/chartPins.test.ts` first — new files must be tracked before a pathspec commit.)

---

### Task 2: Strings, shared row parts and the `ChartPins.vue` popover

**Files:**
- Modify: `language/zh-cn.json`, `language/zh-tw.json`, `language/en-us.json`, `language/ja-jp.json` (add `efb.airports.charts.pins`)
- Create: `src/components/chartTags.ts`
- Create: `src/components/ChartPinButton.vue`
- Create: `src/components/map/ChartPinRow.vue`
- Create: `src/components/map/ChartPins.vue`
- Modify: `src/styles/globals.css` (popover styles, after the `.map-layer-failure` block)

**Interfaces:**
- Consumes: everything Task 1 produces; `loadFlightPlan` (`@/lib/planStore`); `PLAN_CHANGED_EVENT` (`@/lib/mapBus`); `PROCEDURES_CHANGED_EVENT`, `readSelection`, `EMPTY_SELECTION` (`@/lib/procedureSelection`); `chartIndexPath`, `chartsEmptyBody`, `chartsEmptyReason`, `chartsState`, `errorCodeOf`, `parseChartIndex`, `ChartsState`, `ChartEntry` (`@/lib/charts`); `dbFetch`, `hideNaip` (`@/lib/naip`); `LOADING` (`@/lib/requestState`).
- Produces:
  - `CHART_TAG_CLASS: Record<ChartCategory, string>` from `@/components/chartTags`
  - `ChartPinButton.vue` — props `{ pinned: boolean; label: string }`, emits `toggle`
  - `ChartPins.vue` — props `{ open: boolean; aipAccess: number; messages: Record<string, unknown> }`, emits `close`. Root element id `map-chart-pins`.
  - Message keys under `airports.charts.pins.*`: `button`, `title`, `close`, `departure`, `arrival`, `alternate`, `pin`, `unpin`, `auto`, `pinnedNone`, `all` (`{count}`), `unmatched` (`{procedure}`), `noPlan`, `noPlanAction`, `planFailed`.

- [ ] **Step 1: Add the strings**

In each `language/*.json`, inside `efb.airports.charts`, add a `pins` object after `viewer`:

zh-cn:
```json
"pins": {
  "button": "航图",
  "title": "本次飞行的航图",
  "close": "关闭航图列表",
  "departure": "起飞",
  "arrival": "落地",
  "alternate": "备降",
  "pin": "钉住",
  "unpin": "取消钉住",
  "auto": "自动",
  "pinnedNone": "还没有钉住的航图。",
  "all": "全部航图（{count}）",
  "unmatched": "没有匹配 {procedure} 的航图，请从下面的列表里选。",
  "noPlan": "还没有提交飞行计划。钉住的航图跟着计划走。",
  "noPlanAction": "去提交飞行计划",
  "planFailed": "没能读取飞行计划 —— 这不代表没有。"
}
```

zh-tw:
```json
"pins": {
  "button": "航圖",
  "title": "本次飛行的航圖",
  "close": "關閉航圖清單",
  "departure": "起飛",
  "arrival": "落地",
  "alternate": "備降",
  "pin": "釘選",
  "unpin": "取消釘選",
  "auto": "自動",
  "pinnedNone": "還沒有釘選的航圖。",
  "all": "全部航圖（{count}）",
  "unmatched": "沒有符合 {procedure} 的航圖，請從下面的清單裡選。",
  "noPlan": "還沒有提交飛行計畫。釘選的航圖跟著計畫走。",
  "noPlanAction": "去提交飛行計畫",
  "planFailed": "沒能讀取飛行計畫 —— 這不代表沒有。"
}
```

en-us:
```json
"pins": {
  "button": "Charts",
  "title": "Charts for this flight",
  "close": "Close chart list",
  "departure": "Departure",
  "arrival": "Arrival",
  "alternate": "Alternate",
  "pin": "Pin",
  "unpin": "Unpin",
  "auto": "Auto",
  "pinnedNone": "No pinned charts yet.",
  "all": "All charts ({count})",
  "unmatched": "No chart matched {procedure}; pick one from the list below.",
  "noPlan": "No flight plan filed. Pinned charts follow the flight plan.",
  "noPlanAction": "File a flight plan",
  "planFailed": "Could not read the flight plan. That does not mean there is none."
}
```

ja-jp:
```json
"pins": {
  "button": "チャート",
  "title": "このフライトのチャート",
  "close": "チャート一覧を閉じる",
  "departure": "出発",
  "arrival": "到着",
  "alternate": "代替",
  "pin": "ピン留め",
  "unpin": "ピン留めを解除",
  "auto": "自動",
  "pinnedNone": "ピン留めしたチャートはまだありません。",
  "all": "すべてのチャート（{count}）",
  "unmatched": "{procedure} に一致するチャートはありません。下の一覧から選んでください。",
  "noPlan": "フライトプランが提出されていません。ピン留めはフライトプランごとに保存されます。",
  "noPlanAction": "フライトプランを提出",
  "planFailed": "フライトプランを読み込めませんでした。未提出という意味ではありません。"
}
```

- [ ] **Step 2: Shared tag colours**

Create `src/components/chartTags.ts`:

```ts
/** 航图类别的文字色。机场详情的航图标签和地图的航图弹出层共用。 */
import type { ChartCategory } from "@/lib/charts";

export const CHART_TAG_CLASS: Record<ChartCategory, string> = {
  STAR: "text-emerald-700 dark:text-emerald-300",
  APP: "text-orange-700 dark:text-orange-300",
  TAXI: "text-blue-700 dark:text-blue-300",
  SID: "text-pink-700 dark:text-pink-300",
  REF: "text-violet-700 dark:text-violet-300",
};
```

- [ ] **Step 3: Pin button**

Create `src/components/ChartPinButton.vue`:

```vue
<script setup lang="ts">
/** 钉住 / 取消钉住一张航图。地图的航图弹出层和机场详情的航图标签共用。 */
import { Icon } from "@jianyuelab-org/can-ui";

defineProps<{
  pinned: boolean;
  /** 已翻译，带航图名：「取消钉住 ILSDMEyRWY16L」。 */
  label: string;
}>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="flex w-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-overlay)]"
    :aria-pressed="pinned"
    :aria-label="label"
    :title="label"
    @click="emit('toggle')"
  >
    <Icon
      name="star"
      class="size-4"
      :class="pinned ? 'fill-current text-amber-500' : 'text-faint'"
    />
  </button>
</template>
```

- [ ] **Step 4: Popover row**

Create `src/components/map/ChartPinRow.vue`:

```vue
<script setup lang="ts">
/** 航图弹出层的一行：类别、名称、页码、「自动」标记，右边是钉住按钮。 */
import ChartPinButton from "@/components/ChartPinButton.vue";
import { CHART_TAG_CLASS } from "@/components/chartTags";
import type { ChartEntry } from "@/lib/charts";

defineProps<{
  chart: ChartEntry;
  pinned: boolean;
  /** 计划和程序选择自动挑中的。 */
  auto: boolean;
  labels: { auto: string; pin: string; unpin: string };
}>();
const emit = defineEmits<{ open: []; toggle: [] }>();
</script>

<template>
  <li class="flex items-stretch gap-1">
    <button type="button" class="map-chart-pin-row" @click="emit('open')">
      <span
        class="w-10 shrink-0 font-mono text-xs font-semibold"
        :class="CHART_TAG_CLASS[chart.category]"
      >
        {{ chart.category }}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-ink">{{ chart.name }}</span>
        <span
          v-if="chart.page || auto"
          class="mt-0.5 flex items-center gap-2 text-xs text-muted"
        >
          <span v-if="chart.page" class="font-mono">{{ chart.page }}</span>
          <span v-if="auto" class="badge">{{ labels.auto }}</span>
        </span>
      </span>
    </button>
    <ChartPinButton
      :pinned="pinned"
      :label="`${pinned ? labels.unpin : labels.pin} ${chart.name}`"
      @toggle="emit('toggle')"
    />
  </li>
</template>
```

- [ ] **Step 5: The popover**

Create `src/components/map/ChartPins.vue`:

```vue
<script setup lang="ts">
/**
 * 地图上的「航图」弹出层：本次飞行的起飞、落地、备降三个机场，钉住的在前，后面是
 * 折起来的全部航图。点一行打开 ChartViewer。
 *
 * 规则在 `lib/chartPins.ts`。第一次打开才取数，地图挂载时什么都不取。开着时计划、
 * 程序选择、「不使用受限汇编」一变就重取；钉住变了只重读本机存储，不重取。关着时
 * 这些事件只记一笔，下次打开再取。
 *
 * 每个机场的状态各管各的：一个机场没取到不影响另外两个，重试也只重试它。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import StateCard from "@/components/ui/StateCard.vue";
import ChartViewer from "@/components/ChartViewer.vue";
import ChartPinRow from "@/components/map/ChartPinRow.vue";
import { createTranslator } from "@/lib/i18n";
import { dbFetch, hideNaip } from "@/lib/naip";
import { LOADING } from "@/lib/requestState";
import { PLAN_CHANGED_EVENT } from "@/lib/mapBus";
import { loadFlightPlan } from "@/lib/planStore";
import {
  EMPTY_SELECTION,
  PROCEDURES_CHANGED_EVENT,
  readSelection,
  type ProcedureSelection,
} from "@/lib/procedureSelection";
import {
  chartIndexPath,
  chartsEmptyBody,
  chartsEmptyReason,
  chartsState,
  errorCodeOf,
  parseChartIndex,
  type ChartEntry,
  type ChartsState,
} from "@/lib/charts";
import {
  autoPins,
  CHART_PINS_CHANGED_EVENT,
  EMPTY_PINS,
  isPinned,
  pinnedCharts,
  readPins,
  readPlan,
  sortByCategory,
  togglePin,
  unmatchedProcedures,
  writePins,
  type PinPlan,
  type PinRole,
  type PlanAirport,
  type StoredPins,
} from "@/lib/chartPins";

const props = defineProps<{
  open: boolean;
  aipAccess: number;
  /** `common` 两句、`airports.denied`、`airports.charts`（含 `viewer` 和 `pins`）。 */
  messages: Record<string, unknown>;
}>();
const emit = defineEmits<{ close: [] }>();
const t = createTranslator(props.messages);

const ROLE_LABEL: Record<PinRole, string> = {
  departure: t("airports.charts.pins.departure"),
  arrival: t("airports.charts.pins.arrival"),
  alternate: t("airports.charts.pins.alternate"),
};
const ROW_LABELS = {
  auto: t("airports.charts.pins.auto"),
  pin: t("airports.charts.pins.pin"),
  unpin: t("airports.charts.pins.unpin"),
};

type PlanState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "plan"; plan: PinPlan };

const plan = ref<PlanState>({ kind: "loading" });
const states = ref<Partial<Record<PinRole, ChartsState>>>({});
const selection = ref<ProcedureSelection>({ ...EMPTY_SELECTION });
const stored = ref<StoredPins>(EMPTY_PINS);
const selected = ref<ChartEntry | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
/** 打开查看器之前焦点在哪儿，关掉时回去。 */
let returnFocus: HTMLElement | null = null;
let loaded = false;
let stale = false;
let seq = 0;

function rereadLocal() {
  if (plan.value.kind !== "plan") return;
  const { departure, arrival } = plan.value.plan;
  selection.value = readSelection(departure, arrival);
  stored.value = readPins(departure, arrival);
}

async function loadAirport(airport: PlanAirport, mine: number) {
  states.value = { ...states.value, [airport.role]: LOADING };
  const response = await dbFetch(chartIndexPath(airport.icao)).catch(
    () => null,
  );
  if (mine !== seq) return;
  if (!response) {
    states.value = {
      ...states.value,
      [airport.role]: { kind: "error", status: 0 },
    };
    return;
  }
  const body = await response.json().catch(() => null);
  if (mine !== seq) return;
  const index = response.ok ? parseChartIndex(body) : null;
  states.value = {
    ...states.value,
    [airport.role]: chartsState(
      response.ok,
      response.status,
      index,
      errorCodeOf(body),
    ),
  };
}

async function load() {
  const mine = ++seq;
  loaded = true;
  stale = false;
  selected.value = null;
  plan.value = { kind: "loading" };
  states.value = {};
  const result = await loadFlightPlan<{
    departure?: string;
    arrival?: string;
    alternate?: string;
  }>().catch(() => null);
  if (mine !== seq) return;
  if (!result || !result.ok) {
    plan.value = { kind: "error" };
    return;
  }
  const next = readPlan(result.data);
  if (!next) {
    plan.value = { kind: "none" };
    return;
  }
  plan.value = { kind: "plan", plan: next };
  rereadLocal();
  await Promise.all(next.airports.map((a) => loadAirport(a, mine)));
}

function retry(airport: PlanAirport) {
  void loadAirport(airport, seq);
}

/** 计划、程序选择、「不使用受限汇编」变了。 */
function onSourceChange() {
  if (props.open) void load();
  else if (loaded) stale = true;
}

const groups = computed(() => {
  if (plan.value.kind !== "plan") return [];
  return plan.value.plan.airports.map((airport) => {
    const state = states.value[airport.role] ?? LOADING;
    const charts = state.kind === "data" ? state.data.charts : [];
    const auto = autoPins(charts, airport.role, selection.value);
    return {
      ...airport,
      state,
      auto,
      pinned: pinnedCharts(charts, auto, stored.value),
      all: sortByCategory(charts),
      unmatched:
        state.kind === "data"
          ? unmatchedProcedures(charts, airport.role, selection.value)
          : [],
    };
  });
});

const emptyReason = computed(() =>
  chartsEmptyReason(hideNaip.value, props.aipAccess),
);
const emptyBody = computed(() => chartsEmptyBody(props.aipAccess));

function toggle(chart: ChartEntry, auto: ReadonlySet<number>) {
  if (plan.value.kind !== "plan") return;
  const { departure, arrival } = plan.value.plan;
  writePins(departure, arrival, togglePin(stored.value, chart.id, auto));
}

function openChart(chart: ChartEntry) {
  returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  selected.value = chart;
}

function closeViewer() {
  selected.value = null;
  const target = returnFocus;
  returnFocus = null;
  void nextTick(() => target?.focus());
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      selected.value = null;
      return;
    }
    if (!loaded || stale) void load();
    await nextTick();
    closeButton.value?.focus();
  },
);
watch(hideNaip, onSourceChange);

/** Esc 关弹出层。查看器开着时 Esc 是查看器的。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !props.open || selected.value) return;
  emit("close");
}

onMounted(() => {
  window.addEventListener(PLAN_CHANGED_EVENT, onSourceChange);
  window.addEventListener(PROCEDURES_CHANGED_EVENT, onSourceChange);
  window.addEventListener(CHART_PINS_CHANGED_EVENT, rereadLocal);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener(PLAN_CHANGED_EVENT, onSourceChange);
  window.removeEventListener(PROCEDURES_CHANGED_EVENT, onSourceChange);
  window.removeEventListener(CHART_PINS_CHANGED_EVENT, rereadLocal);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <section
    v-show="open"
    id="map-chart-pins"
    class="map-chart-pins glass"
    role="dialog"
    :aria-label="t('airports.charts.pins.title')"
  >
    <header class="map-chart-pins-bar">
      <h2 class="text-sm font-semibold text-ink">
        {{ t("airports.charts.pins.title") }}
      </h2>
      <button
        ref="closeButton"
        type="button"
        class="map-chart-pins-close"
        :aria-label="t('airports.charts.pins.close')"
        :title="t('airports.charts.pins.close')"
        @click="emit('close')"
      >
        <Icon name="xMark" class="size-4" />
      </button>
    </header>

    <div class="map-chart-pins-body">
      <StateCard
        v-if="plan.kind === 'loading'"
        kind="loading"
        :title="t('common.loading')"
        compact
      />
      <StateCard
        v-else-if="plan.kind === 'error'"
        kind="error"
        :title="t('airports.charts.pins.planFailed')"
        :retry-label="t('common.retry')"
        compact
        @retry="load"
      />
      <div
        v-else-if="plan.kind === 'none'"
        class="flex flex-col items-start gap-3"
      >
        <p class="text-sm text-muted">{{ t("airports.charts.pins.noPlan") }}</p>
        <a href="/flightplan" class="btn btn-secondary">
          {{ t("airports.charts.pins.noPlanAction") }}
        </a>
      </div>

      <template v-else>
        <section
          v-for="g in groups"
          :key="g.role"
          class="flex flex-col gap-2"
          :aria-label="`${ROLE_LABEL[g.role]} ${g.icao}`"
        >
          <h3 class="flex items-baseline gap-2 text-xs font-semibold text-muted">
            <span>{{ ROLE_LABEL[g.role] }}</span>
            <span class="font-mono text-ink">{{ g.icao }}</span>
          </h3>

          <StateCard
            v-if="g.state.kind === 'loading'"
            kind="loading"
            :title="t('common.loading')"
            compact
          />
          <StateCard
            v-else-if="g.state.kind === 'forbidden'"
            kind="forbidden"
            :title="t('airports.denied.title')"
            :body="t('airports.denied.body')"
            compact
          />
          <StateCard
            v-else-if="g.state.kind === 'unconfigured'"
            kind="error"
            :title="t('airports.charts.unconfigured.title')"
            :body="t('airports.charts.unconfigured.body')"
            :retry-label="t('common.retry')"
            compact
            @retry="retry(g)"
          />
          <StateCard
            v-else-if="g.state.kind === 'error'"
            kind="error"
            :title="t('airports.charts.failed')"
            :retry-label="t('common.retry')"
            compact
            @retry="retry(g)"
          />
          <StateCard
            v-else-if="g.state.kind === 'empty' && emptyReason === 'hidden'"
            kind="empty"
            :title="t('airports.charts.hidden.title')"
            :body="t('airports.charts.hidden.body')"
            compact
          >
            <template #action>
              <a href="/settings" class="btn btn-secondary">
                {{ t("airports.charts.hidden.action") }}
              </a>
            </template>
          </StateCard>
          <StateCard
            v-else-if="g.state.kind === 'empty'"
            kind="empty"
            :title="
              emptyBody === 'needsAccess'
                ? t('airports.charts.empty.needsAccessTitle')
                : t('airports.charts.empty.title')
            "
            :body="
              emptyBody === 'needsAccess'
                ? t('airports.charts.empty.needsAccess')
                : t('airports.charts.empty.noCharts')
            "
            compact
          />

          <template v-else>
            <p
              v-for="label in g.unmatched"
              :key="label"
              class="text-xs text-muted"
              role="status"
            >
              {{ t("airports.charts.pins.unmatched", { procedure: label }) }}
            </p>
            <p v-if="!g.pinned.length" class="text-xs text-faint">
              {{ t("airports.charts.pins.pinnedNone") }}
            </p>
            <ul v-else class="flex flex-col gap-1">
              <ChartPinRow
                v-for="c in g.pinned"
                :key="c.id"
                :chart="c"
                :pinned="true"
                :auto="g.auto.has(c.id)"
                :labels="ROW_LABELS"
                @open="openChart(c)"
                @toggle="toggle(c, g.auto)"
              />
            </ul>
            <details class="map-chart-pins-all">
              <summary class="cursor-pointer text-xs text-muted">
                {{ t("airports.charts.pins.all", { count: g.all.length }) }}
              </summary>
              <ul class="mt-1 flex flex-col gap-1">
                <ChartPinRow
                  v-for="c in g.all"
                  :key="c.id"
                  :chart="c"
                  :pinned="isPinned(c.id, g.auto, stored)"
                  :auto="g.auto.has(c.id)"
                  :labels="ROW_LABELS"
                  @open="openChart(c)"
                  @toggle="toggle(c, g.auto)"
                />
              </ul>
            </details>
          </template>
        </section>
      </template>
    </div>
  </section>

  <ChartViewer
    v-if="selected"
    :chart="selected"
    :messages="messages"
    @close="closeViewer"
  />
</template>
```

Note: the component renders two root nodes (popover and viewer). `ChartViewer` teleports to `body`, so it does not land inside `.map-overlay`.

- [ ] **Step 6: Styles**

In `src/styles/globals.css`, after the `.map-layer-failure { … }` block, add:

```css
/* 「航图」按钮：在「3D」下面，开着弹出层时和开着的图层同一种底色。 */
.map-charts-trigger {
  order: 4;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.3rem 0.6rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  color: var(--color-muted);
}
.map-charts-trigger.is-on {
  color: var(--color-ink);
  background: var(--surface-overlay);
}
/* 航图弹出层（`ChartPins.vue`）。从可见区左下角往上长，开着时盖住图层控件，
   自己带关闭按钮和 Esc。 */
.map-chart-pins {
  position: absolute;
  left: 0.5rem;
  bottom: 0.5rem;
  z-index: 3;
  display: flex;
  flex-direction: column;
  width: min(24rem, calc(100% - 1rem));
  max-height: calc(100% - 1rem);
  border-radius: var(--radius-card);
}
.map-chart-pins-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border-subtle);
}
.map-chart-pins-close {
  padding: 0.25rem;
  border-radius: var(--radius-control);
  color: var(--color-muted);
}
.map-chart-pins-close:hover {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
.map-chart-pins-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
}
.map-chart-pin-row {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: var(--radius-control);
  text-align: left;
}
.map-chart-pin-row:hover {
  background: var(--surface-overlay);
}
```

- [ ] **Step 7: Verify**

Run: `bunx prettier --write language src/components/chartTags.ts src/components/ChartPinButton.vue src/components/map/ChartPinRow.vue src/components/map/ChartPins.vue src/styles/globals.css && bun run typecheck && bun run check:i18n`
Expected: no errors. `ChartPins.vue` is not mounted anywhere yet; typecheck still covers it.

- [ ] **Step 8: Commit**

```bash
git add src/components/chartTags.ts src/components/ChartPinButton.vue src/components/map/ChartPinRow.vue src/components/map/ChartPins.vue
perl -e 'alarm 40; exec @ARGV' git commit -m "ChartPins: popover for the flight plan's charts, pin button, strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- language src/components/chartTags.ts src/components/ChartPinButton.vue src/components/map/ChartPinRow.vue src/components/map/ChartPins.vue src/styles/globals.css
```

---

### Task 3: Wire the popover into the map

**Files:**
- Modify: `src/components/map/MapControls.vue`
- Modify: `src/components/map/MapStage.vue`
- Modify: `src/layouts/AppLayout.astro`

**Interfaces:**
- Consumes: `ChartPins.vue` (Task 2), message key `airports.charts.pins.button`.
- Produces:
  - `MapControls.vue`: `text.charts: string`, prop `chartsOpen: boolean`, emit `charts`, `defineExpose({ focusCharts })`.
  - `MapStage.vue`: props `aipAccess: number`, `chartMessages: Record<string, unknown>`, `t.charts: string`.

- [ ] **Step 1: MapControls**

In `src/components/map/MapControls.vue`:

1. Add to the file header comment's list of things it holds: 「航图」按钮.
2. In the `text` prop type, after `chartLow: string;`, add:

```ts
    /** 「航图」按钮。 */
    charts: string;
```

3. After `profileShown: boolean;` in props, add:

```ts
  /** 航图弹出层开着。 */
  chartsOpen: boolean;
```

4. In `defineEmits`, add `charts: [];`.
5. After `const menu = ref<HTMLElement | null>(null);`, add:

```ts
const chartsTrigger = ref<HTMLButtonElement | null>(null);

/** 弹出层关掉后焦点回到按钮（MapStage 调）。 */
function focusCharts() {
  chartsTrigger.value?.focus();
}
defineExpose({ focusCharts });
```

6. In the template, right after the `map-3d-toggle` button, add:

```html
      <!-- 本次飞行的航图（`ChartPins.vue`，由 MapStage 挂）。 -->
      <button
        ref="chartsTrigger"
        type="button"
        class="map-charts-trigger glass"
        :class="chartsOpen ? 'is-on' : ''"
        :aria-expanded="chartsOpen"
        aria-controls="map-chart-pins"
        @click="emit('charts')"
      >
        <Icon name="documentText" class="size-4" />
        <span>{{ text.charts }}</span>
      </button>
```

- [ ] **Step 2: MapStage**

In `src/components/map/MapStage.vue`:

1. Add to the header list: `- ChartPins.vue      本次飞行的航图，地图上的「航图」按钮打开`.
2. Add import after the `MapControls` import:

```ts
import ChartPins from "@/components/map/ChartPins.vue";
```

3. In props, after `cid: string | null;`, add:

```ts
  /** 航行资料库级别。航图弹出层的空状态按它说话。 */
  aipAccess: number;
  /** 航图弹出层和查看器要的那几本词典（AppLayout 挑好）。 */
  chartMessages: Record<string, unknown>;
```

4. In the `t` prop type, after `chartLow: string;`, add:

```ts
    /** 地图上的「航图」按钮。 */
    charts: string;
```

5. After `const view3d = ref(false);` and its `profileShown` computed, add:

```ts
/** 航图弹出层。第一次打开才取数（见 ChartPins.vue）。 */
const chartsOpen = ref(false);
const controls = ref<InstanceType<typeof MapControls> | null>(null);

function closeCharts() {
  chartsOpen.value = false;
  controls.value?.focusCharts();
}
```

6. On `<MapControls`, add `ref="controls"`, add `charts: t.charts,` to the `:text` object after `chartLow: t.chartLow,`, add `:charts-open="chartsOpen"` and `@charts="chartsOpen = !chartsOpen"`.
7. In the second `<div class="map-overlay">`, after the `PilotDetails` element (the `v-if`/`v-else-if` chain must stay adjacent), add:

```html
      <ChartPins
        :open="chartsOpen"
        :aip-access="aipAccess"
        :messages="chartMessages"
        @close="closeCharts"
      />
```

- [ ] **Step 3: AppLayout**

In `src/layouts/AppLayout.astro`, on `<MapStage`:

1. After `cid={…}`, add:

```astro
    aipAccess={Astro.locals.user?.aipAccess ?? 0}
    chartMessages={{
      common: { loading: t("common.loading"), retry: t("common.retry") },
      airports: {
        denied: getMessages(locale, "efb.airports.denied"),
        charts: getMessages(locale, "efb.airports.charts"),
      },
    }}
```

2. In the `t={{ … }}` object, after `chartLow: t("map.chart.low"),`, add:

```astro
      charts: t("airports.charts.pins.button"),
```

- [ ] **Step 4: Verify**

Run: `bunx prettier --write src/components/map/MapControls.vue src/components/map/MapStage.vue src/layouts/AppLayout.astro && bun run lint && bun run build`
Expected: lint (format, typecheck, i18n, style, tests) passes; build succeeds.

- [ ] **Step 5: Commit**

```bash
perl -e 'alarm 40; exec @ARGV' git commit -m "Map: Charts button opens the chart pins popover

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/map/MapControls.vue src/components/map/MapStage.vue src/layouts/AppLayout.astro
```

---

### Task 4: Pin buttons in airport details

**Files:**
- Modify: `src/components/AirportCharts.vue`

**Interfaces:**
- Consumes: Task 1 (`readPlan`, `roleOf`, `autoPins`, `isPinned`, `togglePin`, `readPins`, `writePins`, `CHART_PINS_CHANGED_EVENT`, `EMPTY_PINS`, `PinPlan`, `StoredPins`); `ChartPinButton.vue`, `CHART_TAG_CLASS` (Task 2).
- Produces: nothing new for later tasks.

Rule: a pin button appears only when this airport is the departure, arrival or alternate of the member's current flight plan. Pins are scoped to the plan's departure-arrival pair, so there is nowhere to store a pin for any other airport.

- [ ] **Step 1: Script changes**

In `src/components/AirportCharts.vue`:

1. Extend the header comment with: `计划里的机场（起飞、落地、备降）每行多一颗钉住按钮，和地图的航图弹出层写同一份存储（lib/chartPins.ts）。别的机场没有：钉住按起降机场对存。`
2. Change the vue import to include `onBeforeUnmount`.
3. Add imports:

```ts
import ChartPinButton from "./ChartPinButton.vue";
import { CHART_TAG_CLASS } from "./chartTags";
import { PLAN_CHANGED_EVENT } from "@/lib/mapBus";
import { loadFlightPlan } from "@/lib/planStore";
import {
  EMPTY_SELECTION,
  PROCEDURES_CHANGED_EVENT,
  readSelection,
  type ProcedureSelection,
} from "@/lib/procedureSelection";
import {
  autoPins,
  CHART_PINS_CHANGED_EVENT,
  EMPTY_PINS,
  isPinned,
  readPins,
  readPlan,
  roleOf,
  togglePin,
  writePins,
  type PinPlan,
  type StoredPins,
} from "@/lib/chartPins";
```

4. Delete the local `TAG_CLASS` constant and its comment; replace `TAG_CLASS[c.category]` in the template with `CHART_TAG_CLASS[c.category]`.
5. After the `emptyBody` computed, add:

```ts
// ------------------------------------------------------------------ 钉住

const pinPlan = ref<PinPlan | null>(null);
const selection = ref<ProcedureSelection>({ ...EMPTY_SELECTION });
const stored = ref<StoredPins>(EMPTY_PINS);
let planSeq = 0;

/** 这个机场在计划里是哪一个。不在计划里就没有钉住按钮。 */
const role = computed(() =>
  pinPlan.value ? roleOf(pinPlan.value, props.icao) : null,
);
const auto = computed(() =>
  role.value && index.value
    ? autoPins(index.value.charts, role.value, selection.value)
    : new Set<number>(),
);

function rereadPins() {
  const p = pinPlan.value;
  if (!p) return;
  selection.value = readSelection(p.departure, p.arrival);
  stored.value = readPins(p.departure, p.arrival);
}

/** 读不到计划就当没有：钉住按钮不出现，航图照常能看。 */
async function loadPinPlan() {
  const mine = ++planSeq;
  const result = await loadFlightPlan<{
    departure?: string;
    arrival?: string;
    alternate?: string;
  }>().catch(() => null);
  if (mine !== planSeq) return;
  pinPlan.value = result?.ok ? readPlan(result.data) : null;
  rereadPins();
}

function togglePinned(chart: ChartEntry) {
  const p = pinPlan.value;
  if (!p) return;
  writePins(p.departure, p.arrival, togglePin(stored.value, chart.id, auto.value));
}

function pinLabel(chart: ChartEntry): string {
  const pinned = isPinned(chart.id, auto.value, stored.value);
  return `${t(pinned ? "airports.charts.pins.unpin" : "airports.charts.pins.pin")} ${chart.name}`;
}

onMounted(() => {
  void loadPinPlan();
  window.addEventListener(PLAN_CHANGED_EVENT, loadPinPlan);
  window.addEventListener(PROCEDURES_CHANGED_EVENT, rereadPins);
  window.addEventListener(CHART_PINS_CHANGED_EVENT, rereadPins);
});
onBeforeUnmount(() => {
  window.removeEventListener(PLAN_CHANGED_EVENT, loadPinPlan);
  window.removeEventListener(PROCEDURES_CHANGED_EVENT, rereadPins);
  window.removeEventListener(CHART_PINS_CHANGED_EVENT, rereadPins);
});
```

Note `pinLabel` builds the key with a ternary; `check:i18n` only verifies literal `t("…")` keys, and both keys exist from Task 2. If `check:i18n` reports the call, split it into `pinned ? t("airports.charts.pins.unpin") : t("airports.charts.pins.pin")`.

- [ ] **Step 2: Template changes**

Replace the `<li v-for="c in visible" …>` block with:

```html
      <li v-for="c in visible" :key="c.id" class="flex items-stretch gap-1.5">
        <button
          type="button"
          class="card flex min-w-0 flex-1 items-center gap-3 p-3 text-left"
          :aria-current="selected?.id === c.id ? 'true' : undefined"
          :ref="(el) => setRowRef(c.id, el as Element | null)"
          @click="openChart(c)"
        >
          <span
            v-if="searching"
            class="w-10 shrink-0 font-mono text-xs font-semibold"
            :class="CHART_TAG_CLASS[c.category]"
          >
            {{ c.category }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-ink">{{ c.name }}</span>
            <span
              v-if="c.page || c.isSup || auto.has(c.id)"
              class="mt-0.5 flex items-center gap-2 text-xs text-muted"
            >
              <span v-if="c.page" class="font-mono">{{ c.page }}</span>
              <span v-if="c.isSup" class="badge badge-warning">
                {{ t("airports.charts.sup") }}
              </span>
              <span v-if="auto.has(c.id)" class="badge">
                {{ t("airports.charts.pins.auto") }}
              </span>
            </span>
          </span>
          <Icon name="chevronRight" class="size-4 shrink-0 text-faint" />
        </button>
        <ChartPinButton
          v-if="role"
          class="card"
          :pinned="isPinned(c.id, auto, stored)"
          :label="pinLabel(c)"
          @toggle="togglePinned(c)"
        />
      </li>
```

- [ ] **Step 3: Verify**

Run: `bunx prettier --write src/components/AirportCharts.vue && bun run lint && bun run build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
perl -e 'alarm 40; exec @ARGV' git commit -m "Airport charts: pin button for the flight plan's airports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/AirportCharts.vue
```

---

### Task 5: Documentation

**Files:**
- Modify: `AGENTS.md` (the `## 机场航图（PDF）…` section, before `## 导航是一份数据`)

- [ ] **Step 1: Add the subsection**

Insert before `## 导航是一份数据`:

```markdown
### 航图钉住（`lib/chartPins.ts` + `map/ChartPins.vue`）

- 地图上的「航图」按钮打开弹出层：飞行计划的起飞、落地、备降三个机场，钉住的在前，
  后面是折起来的全部航图。没有备降就没有那一组。没有计划时一句话加去 `/flightplan` 的链接。
- 自动钉住：起飞、落地是 TAXI 里的 `机场图`、`停机位置图`，备降只有 `机场图`。选了程序
  （`lib/procedureSelection.ts`）时加上匹配的 SID、STAR、APP。
- SID / STAR：标签第一个数字前的字母是定位点，航图名括号里含它（子串）；选了跑道时跑道在
  `RWY` 后面那一串里。`AND` 会命中 `BKANDSASAN`，这是已知局限，自动钉住带「自动」标记，可取消。
- 进近：首字母定类型（I = ILS；R = RNP / RNAV 开头且不含 ILS；D、V = VOR；N = NDB；
  L = LOC），跑道完全一致，`-Y` / `-Z` 对 `RWY` 前的小写字母，标签不带变体时不查。
- 选了程序却没中：说「没有匹配 {procedure} 的航图」，不安静地少一张。
- 存储：localStorage `efb:chart-pins:{DEP}-{ARR}`，`{ pinned, unpinned }`，元素是航图 id。
  结果 = 自动 + `pinned` − `unpinned`。改了发 `efb:chart-pins-changed`。读不出来当空的。
  索引里没有的 id 不显示。
- 第一次打开才取数。开着时计划、程序选择、「不使用受限汇编」变了重取；钉住变了只重读存储。
  三个机场各自的状态和重试，互不影响。
- 机场详情的航图标签：这个机场在计划里时每行多一颗钉住按钮，写同一份存储；不在计划里没有。
- 查看器还是 `ChartViewer.vue`，位置照 `viewerPlacement`（贴面板右边或盖满），会盖住弹出层；
  关掉后焦点回到打开它的那一行。
```

- [ ] **Step 2: Commit**

```bash
perl -e 'alarm 40; exec @ARGV' git commit -m "AGENTS.md: chart pins section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- AGENTS.md
```

---

## Browser checks (by hand, needs a session with level 3 or higher)

- Popover with and without a flight plan.
- Auto pins after selecting SID, STAR and approach in the procedure picker.
- Manual pin from the popover and from airport details; each reflects the other.
- NAIP setting on and off: hidden state and reload.
- Phone width: popover fits, viewer goes full screen.
