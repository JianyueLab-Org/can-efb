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
  const taxi = role === "alternate" ? [TAXI_MAIN] : [TAXI_MAIN, TAXI_STANDS];
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
    (v): v is number =>
      typeof v === "number" && Number.isSafeInteger(v) && v > 0,
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
  storage: Pick<
    Storage,
    "setItem" | "removeItem"
  > | null = localStorageOrNull(),
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
      unpinned: auto.has(id)
        ? [...without(pins.unpinned), id]
        : without(pins.unpinned),
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
