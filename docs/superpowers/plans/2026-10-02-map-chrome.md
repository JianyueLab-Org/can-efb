# Map Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bottom-left layers menu with a top mode bar (Traffic, ATC, Weather, Pinboard), a left toolbar (HIGH/LOW IFR, layers flyout, 3D, locate me) and a bottom pinboard bar of pinned charts, with zoom and compass moved to the top right.

**Architecture:** Bar logic (grouping, per-airport chips, keyboard index, padding arithmetic) is pure in `src/lib/pinboard.ts` with bun tests. Chart pin state moves out of `ChartPins.vue` into `components/map/useChartPins.ts`; `MapStage` creates it once, provides it to `MapPinboard.vue` and `ChartPins.vue`, and renders the one `ChartViewer`. `MapControls.vue` is replaced by `MapModeBar.vue` and `MapToolbar.vue`. `mapPrefs` gains `pinboard`.

**Tech Stack:** Astro 7, Vue 3 (`<script setup lang="ts">`), Tailwind 4, MapLibre GL, `bun test`, can-ui `Icon` / `Spinner`.

**Spec:** `docs/superpowers/specs/2026-10-02-map-chrome-design.md`

## Global Constraints

- All controls sit inside the visible map area (`--map-pad-*`).
- Breakpoints live only in CSS. JS reads `--shell-mode` (`parseShellMode`), never `matchMedia`.
- The mapBus stays one-way, panel to map.
- All `/api/db/*` calls go through `dbFetch` (`@/lib/naip`).
- Failure is never drawn as empty. Each empty state says why.
- Islands receive only the message keys they use.
- Pure logic lives in `lib/*.ts` with tests.
- Chart pin rules and storage (`lib/chartPins.ts`) are unchanged. `lib/chartPins.test.ts` is unchanged.
- Out of scope: route and label styling, a night-mode button on the map, a measuring tool, background download of pinned PDFs, server-side storage of pins.
- Category strip colours: STAR green, APP orange, TAXI blue, SID pink, REF violet (same hues as `CHART_TAG_CLASS`).
- `mapPrefs.pinboard` defaults to `true`.
- New user-facing strings go into all four of `language/zh-cn.json`, `zh-tw.json`, `en-us.json`, `ja-jp.json` (`bun run check:i18n` fails otherwise). Code comments match the surrounding Chinese.
- Commit only the files a task names, with a pathspec commit: `git -c commit.gpgsign=false commit -m "…" -- <paths>`. New files need `git add <file>` first. Never `git add -A` or `git add .`.
- Commits are unsigned (`commit.gpgsign=false`): signing needs a hardware key touch.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run prettier on changed files only: `bunx prettier --write <files>`.
- Scratch files go in `can-efb/.temp/`, never `/tmp`.
- Branch `feat/map-chrome`. Do not switch branches.

---

### Task 1: `lib/pinboard.ts` and `mapPrefs.pinboard`

**Files:**
- Create: `src/lib/pinboard.ts`
- Test: `src/lib/pinboard.test.ts`
- Modify: `src/lib/mapPrefs.ts` (`LayerPrefs`, `DEFAULT_PREFS`, `readPrefs`)
- Test: `src/lib/mapPrefs.test.ts`

**Interfaces:**
- Consumes: `ChartEntry`, `ChartCategory`, `ChartsState` from `@/lib/charts`; `PinRole` from `@/lib/chartPins`; `MapPadding` from `@/lib/panelLayout`.
- Produces:
  - `type AirportChip = "loading" | "failed" | "unconfigured" | "denied" | "hidden" | "needsAccess" | "empty"`
  - `airportChip(state: ChartsState, emptyReason: "hidden" | "none", emptyBody: "needsAccess" | "noCharts"): AirportChip | null`
  - `chipRetries(chip: AirportChip | null): boolean`
  - `type StripColour = "green" | "orange" | "blue" | "pink" | "violet"`
  - `const STRIP_COLOUR: Record<ChartCategory, StripColour>`
  - `interface PinboardTab { chart: ChartEntry; auto: boolean; colour: StripColour }`
  - `interface PinSource { role: PinRole; icao: string; state: ChartsState; auto: ReadonlySet<number>; pinned: readonly ChartEntry[] }`
  - `interface PinboardGroup { role: PinRole; icao: string; chip: AirportChip | null; auto: ReadonlySet<number>; tabs: PinboardTab[] }`
  - `pinboardGroups(sources: readonly PinSource[], emptyReason: "hidden" | "none", emptyBody: "needsAccess" | "noCharts"): PinboardGroup[]`
  - `type PinboardView = { kind: "loading" } | { kind: "planFailed" } | { kind: "noPlan" } | { kind: "noPins" } | { kind: "groups"; groups: PinboardGroup[] }`
  - `pinboardView(plan: "loading" | "error" | "none" | "plan", groups: readonly PinboardGroup[]): PinboardView`
  - `toolbarIndex(key: string, current: number, count: number): number | null`
  - `const PINBOARD_GAP_PX = 8`
  - `pinboardReserve(barHeight: number): number`
  - `withPinboard(padding: MapPadding, reserve: number): MapPadding`
  - `viewerBottom(padding: MapPadding, reserve: number): number | null`
  - `LayerPrefs.pinboard: boolean`, `DEFAULT_PREFS.pinboard === true`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pinboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ChartEntry, ChartsState } from "@/lib/charts";
import {
  airportChip,
  chipRetries,
  PINBOARD_GAP_PX,
  pinboardGroups,
  pinboardReserve,
  pinboardView,
  STRIP_COLOUR,
  toolbarIndex,
  viewerBottom,
  withPinboard,
  type PinboardGroup,
  type PinSource,
} from "@/lib/pinboard";

function chart(
  id: number,
  category: ChartEntry["category"],
  name: string,
): ChartEntry {
  return { id, category, name, page: null, kind: "", isSup: false, bytes: 1 };
}

function data(charts: ChartEntry[]): ChartsState {
  return { kind: "data", data: { icao: "ZBTJ", airac: "2610", charts } };
}

const MAIN = chart(1, "TAXI", "机场图");
const SID = chart(2, "SID", "RNAVRWY16(PIKAS)");
const APP = chart(3, "APP", "ILSDMEyRWY16L");

describe("airportChip", () => {
  test("有数据不挂牌子", () => {
    expect(airportChip(data([MAIN]), "none", "noCharts")).toBeNull();
    expect(airportChip(data([]), "none", "noCharts")).toBeNull();
  });

  test("读取中", () => {
    expect(airportChip({ kind: "loading" }, "none", "noCharts")).toBe(
      "loading",
    );
  });

  test("没取到、存储没接上：两种都能重试", () => {
    expect(
      airportChip({ kind: "error", status: 500 }, "none", "noCharts"),
    ).toBe("failed");
    expect(airportChip({ kind: "unconfigured" }, "none", "noCharts")).toBe(
      "unconfigured",
    );
    expect(chipRetries("failed")).toBe(true);
    expect(chipRetries("unconfigured")).toBe(true);
  });

  test("没权限是权限，不是故障，也不重试", () => {
    expect(
      airportChip({ kind: "forbidden", status: 403 }, "none", "noCharts"),
    ).toBe("denied");
    expect(chipRetries("denied")).toBe(false);
  });

  test("空：「不使用受限汇编」藏起来的说已隐藏", () => {
    expect(airportChip({ kind: "empty" }, "hidden", "noCharts")).toBe(
      "hidden",
    );
  });

  test("空：3 级以下说要权限，3 级起说没有", () => {
    expect(airportChip({ kind: "empty" }, "none", "needsAccess")).toBe(
      "needsAccess",
    );
    expect(airportChip({ kind: "empty" }, "none", "noCharts")).toBe("empty");
  });

  test("其余牌子不带重试", () => {
    for (const chip of [
      "loading",
      "hidden",
      "needsAccess",
      "empty",
      null,
    ] as const) {
      expect(chipRetries(chip)).toBe(false);
    }
  });
});

describe("pinboardGroups", () => {
  const sources: PinSource[] = [
    {
      role: "departure",
      icao: "ZBTJ",
      state: data([MAIN, SID]),
      auto: new Set([1]),
      pinned: [MAIN, SID],
    },
    {
      role: "arrival",
      icao: "ZSNB",
      state: data([APP]),
      auto: new Set(),
      pinned: [APP],
    },
    {
      role: "alternate",
      icao: "ZSPD",
      state: { kind: "error", status: 0 },
      auto: new Set(),
      pinned: [],
    },
  ];

  test("计划顺序：起飞、落地、备降", () => {
    const groups = pinboardGroups(sources, "none", "noCharts");
    expect(groups.map((g) => [g.role, g.icao])).toEqual([
      ["departure", "ZBTJ"],
      ["arrival", "ZSNB"],
      ["alternate", "ZSPD"],
    ]);
  });

  test("每个机场只有钉住的那几张，带自动标记", () => {
    const [dep, arr] = pinboardGroups(sources, "none", "noCharts");
    expect(dep.tabs.map((t) => [t.chart.id, t.auto])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(arr.tabs.map((t) => t.chart.id)).toEqual([3]);
  });

  test("类别颜色：STAR 绿、APP 橙、TAXI 蓝、SID 粉、REF 紫", () => {
    expect(STRIP_COLOUR).toEqual({
      STAR: "green",
      APP: "orange",
      TAXI: "blue",
      SID: "pink",
      REF: "violet",
    });
    const [dep, arr] = pinboardGroups(sources, "none", "noCharts");
    expect(dep.tabs.map((t) => t.colour)).toEqual(["blue", "pink"]);
    expect(arr.tabs[0].colour).toBe("orange");
  });

  test("没取到的机场挂牌子、没有标签，别的机场照常", () => {
    const groups = pinboardGroups(sources, "none", "noCharts");
    expect(groups[2].chip).toBe("failed");
    expect(groups[2].tabs).toEqual([]);
    expect(groups[0].chip).toBeNull();
  });

  test("不是 data 的状态不出标签，哪怕传进来了钉住的", () => {
    const [g] = pinboardGroups(
      [
        {
          role: "departure",
          icao: "ZBTJ",
          state: { kind: "loading" },
          auto: new Set([1]),
          pinned: [MAIN],
        },
      ],
      "none",
      "noCharts",
    );
    expect(g.chip).toBe("loading");
    expect(g.tabs).toEqual([]);
  });

  test("auto 原样带出，取消钉住要用", () => {
    const [dep] = pinboardGroups(sources, "none", "noCharts");
    expect(dep.auto.has(1)).toBe(true);
  });
});

describe("pinboardView", () => {
  const quiet: PinboardGroup = {
    role: "departure",
    icao: "ZBTJ",
    chip: null,
    auto: new Set(),
    tabs: [],
  };

  test("计划的三种非正常状态", () => {
    expect(pinboardView("loading", [])).toEqual({ kind: "loading" });
    expect(pinboardView("error", [])).toEqual({ kind: "planFailed" });
    expect(pinboardView("none", [])).toEqual({ kind: "noPlan" });
  });

  test("每个机场都读到了、都没钉：说没有钉住的航图", () => {
    expect(
      pinboardView("plan", [quiet, { ...quiet, role: "arrival" }]),
    ).toEqual({ kind: "noPins" });
  });

  test("有一个机场挂着牌子，就按机场画，让牌子说话", () => {
    const failed = { ...quiet, role: "arrival" as const, chip: "failed" as const };
    expect(pinboardView("plan", [quiet, failed])).toEqual({
      kind: "groups",
      groups: [quiet, failed],
    });
  });

  test("有标签就按机场画", () => {
    const withTab: PinboardGroup = {
      ...quiet,
      tabs: [{ chart: MAIN, auto: true, colour: "blue" }],
    };
    expect(pinboardView("plan", [withTab]).kind).toBe("groups");
  });
});

describe("toolbarIndex", () => {
  test("左右方向键循环", () => {
    expect(toolbarIndex("ArrowRight", 0, 3)).toBe(1);
    expect(toolbarIndex("ArrowRight", 2, 3)).toBe(0);
    expect(toolbarIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(toolbarIndex("ArrowLeft", 2, 3)).toBe(1);
  });

  test("Home、End", () => {
    expect(toolbarIndex("Home", 2, 3)).toBe(0);
    expect(toolbarIndex("End", 0, 3)).toBe(2);
  });

  test("焦点不在栏里时从头或尾进", () => {
    expect(toolbarIndex("ArrowRight", -1, 3)).toBe(0);
    expect(toolbarIndex("ArrowLeft", -1, 3)).toBe(2);
  });

  test("别的键、空栏不管", () => {
    expect(toolbarIndex("Enter", 0, 3)).toBeNull();
    expect(toolbarIndex("ArrowDown", 0, 3)).toBeNull();
    expect(toolbarIndex("ArrowRight", -1, 0)).toBeNull();
  });
});

describe("钉板让出的高度", () => {
  const padding = { top: 12, right: 12, bottom: 12, left: 440 };

  test("栏高加一道间隙；没有栏是 0", () => {
    expect(pinboardReserve(52)).toBe(52 + PINBOARD_GAP_PX);
    expect(pinboardReserve(51.4)).toBe(52 + PINBOARD_GAP_PX);
    expect(pinboardReserve(0)).toBe(0);
  });

  test("地图底边内边距加上让出的高度，其余三边不动", () => {
    expect(withPinboard(padding, 60)).toEqual({ ...padding, bottom: 72 });
    expect(withPinboard(padding, 0)).toBe(padding);
  });

  test("查看器底边在栏上面再隔一道；没有栏时交回 CSS 默认值", () => {
    expect(viewerBottom(padding, 60)).toBe(12 + 60 + PINBOARD_GAP_PX);
    expect(viewerBottom(padding, 0)).toBeNull();
  });
});
```

Append to the `describe("readPrefs", …)` block in `src/lib/mapPrefs.test.ts`, right after the test `"没有 weather 键的旧偏好：补默认值（关），其余照旧"`:

```ts
  test("钉板默认开", () => {
    expect(DEFAULT_PREFS.pinboard).toBe(true);
  });

  test("没有 pinboard 键的旧偏好：补默认值（开），其余照旧", () => {
    const prefs = readPrefs(
      memoryStorage({
        [PREF_KEY]: JSON.stringify({
          airways: false,
          chart: "high",
          weather: true,
        }),
      }),
    );
    expect(prefs.pinboard).toBe(true);
    expect(prefs.airways).toBe(false);
    expect(prefs.chart).toBe("high");
    expect(prefs.weather).toBe(true);
  });

  test("旧的三选一偏好也补上钉板", () => {
    expect(
      readPrefs(
        memoryStorage({ [PREF_KEY]: JSON.stringify({ airway: "off" }) }),
      ).pinboard,
    ).toBe(true);
  });

  test("存坏了的 pinboard 回到默认值", () => {
    expect(
      readPrefs(
        memoryStorage({ [PREF_KEY]: JSON.stringify({ pinboard: "no" }) }),
      ).pinboard,
    ).toBe(true);
  });
```

In the `describe("writePrefs", …)` block, change the object in `"写进去再读出来是同一份"` to also carry `pinboard: false`:

```ts
    const prefs = {
      ...DEFAULT_PREFS,
      mora: true,
      traffic: false,
      weather: true,
      pinboard: false,
      chart: "high" as const,
    };
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/pinboard.test.ts src/lib/mapPrefs.test.ts`
Expected: FAIL — `Cannot find module '@/lib/pinboard'`, and `pinboard` is `undefined` in the mapPrefs tests.

- [ ] **Step 3: Write `src/lib/pinboard.ts`**

```ts
/**
 * 地图底部的钉板：钉住的航图按机场排成一行标签。纯逻辑，不碰 DOM。
 *
 * 状态在 `components/map/useChartPins.ts`，画它的是 `components/map/MapPinboard.vue`，
 * 让出高度的是 `components/map/MapStage.vue`。
 */
import type { ChartCategory, ChartEntry, ChartsState } from "@/lib/charts";
import type { PinRole } from "@/lib/chartPins";
import type { MapPadding } from "@/lib/panelLayout";

// ------------------------------------------------------------------ 机场牌子

/** 一个机场此刻没有标签可画时，分隔处那颗小牌子说什么。完整的话在全部航图列表里。 */
export type AirportChip =
  | "loading"
  | "failed"
  | "unconfigured"
  | "denied"
  | "hidden"
  | "needsAccess"
  | "empty";

/** 读到了就不挂牌子（钉住的为零也不挂：那是「没钉」，不是故障）。 */
export function airportChip(
  state: ChartsState,
  emptyReason: "hidden" | "none",
  emptyBody: "needsAccess" | "noCharts",
): AirportChip | null {
  switch (state.kind) {
    case "data":
      return null;
    case "loading":
      return "loading";
    case "error":
      return "failed";
    case "unconfigured":
      return "unconfigured";
    case "forbidden":
      return "denied";
    case "empty":
      if (emptyReason === "hidden") return "hidden";
      return emptyBody === "needsAccess" ? "needsAccess" : "empty";
  }
}

/** 带重试按钮的那两种。和全部航图列表里带重试的 StateCard 一致。 */
export function chipRetries(chip: AirportChip | null): boolean {
  return chip === "failed" || chip === "unconfigured";
}

// ------------------------------------------------------------------ 分组

/** 标签顶上那道色条。和 `CHART_TAG_CLASS` 同一组色相。 */
export type StripColour = "green" | "orange" | "blue" | "pink" | "violet";

export const STRIP_COLOUR: Record<ChartCategory, StripColour> = {
  STAR: "green",
  APP: "orange",
  TAXI: "blue",
  SID: "pink",
  REF: "violet",
};

export interface PinboardTab {
  chart: ChartEntry;
  /** 计划和程序选择自动挑中的。 */
  auto: boolean;
  colour: StripColour;
}

/** `useChartPins` 的一组里钉板要的那几样。 */
export interface PinSource {
  role: PinRole;
  icao: string;
  state: ChartsState;
  auto: ReadonlySet<number>;
  pinned: readonly ChartEntry[];
}

export interface PinboardGroup {
  role: PinRole;
  icao: string;
  chip: AirportChip | null;
  /** 原样带出：取消钉住（`togglePin`）要它。 */
  auto: ReadonlySet<number>;
  tabs: PinboardTab[];
}

/** 按计划顺序，一个机场一组。不是 data 的状态不出标签。 */
export function pinboardGroups(
  sources: readonly PinSource[],
  emptyReason: "hidden" | "none",
  emptyBody: "needsAccess" | "noCharts",
): PinboardGroup[] {
  return sources.map((s) => ({
    role: s.role,
    icao: s.icao,
    chip: airportChip(s.state, emptyReason, emptyBody),
    auto: s.auto,
    tabs:
      s.state.kind === "data"
        ? s.pinned.map((chart) => ({
            chart,
            auto: s.auto.has(chart.id),
            colour: STRIP_COLOUR[chart.category],
          }))
        : [],
  }));
}

export type PinboardView =
  | { kind: "loading" }
  | { kind: "planFailed" }
  | { kind: "noPlan" }
  | { kind: "noPins" }
  | { kind: "groups"; groups: PinboardGroup[] };

/**
 * 整条栏画什么。每个机场都读到了、都没钉，才说「没有钉住的航图」；有一个机场挂着
 * 牌子（读取中、没取到、没权限……），就按机场画，让那颗牌子说话。
 */
export function pinboardView(
  plan: "loading" | "error" | "none" | "plan",
  groups: readonly PinboardGroup[],
): PinboardView {
  if (plan === "loading") return { kind: "loading" };
  if (plan === "error") return { kind: "planFailed" };
  if (plan === "none") return { kind: "noPlan" };
  const quiet = groups.every((g) => g.chip === null && g.tabs.length === 0);
  return quiet ? { kind: "noPins" } : { kind: "groups", groups: [...groups] };
}

// ------------------------------------------------------------------ 键盘

/**
 * `role="toolbar"` 里方向键走到哪一个。左右循环，Home / End 到两头；焦点不在栏里
 * （`current` 为 -1）时从头或尾进。别的键回 null，交给浏览器。
 */
export function toolbarIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowLeft":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ 让出高度

/** 栏离可见区底边的距离，和 `globals.css` 里 `.map-pinboard` 的 `bottom` 同值。 */
export const PINBOARD_GAP_PX = 8;

/** 栏在可见区底部占掉多高：栏高加底下那道间隙。没有栏是 0。 */
export function pinboardReserve(barHeight: number): number {
  return barHeight > 0 ? Math.ceil(barHeight) + PINBOARD_GAP_PX : 0;
}

/** 地图的内边距：底边再让出栏的高度，「框住航路」「居中」都落在栏上面。 */
export function withPinboard(padding: MapPadding, reserve: number): MapPadding {
  return reserve > 0
    ? { ...padding, bottom: padding.bottom + reserve }
    : padding;
}

/**
 * 查看器贴在旁边时的底边（离视口底边的 px）：栏上面再隔一道。没有栏时回 null，
 * 交回 CSS 的默认值（`--shell-inset`）。
 */
export function viewerBottom(
  padding: MapPadding,
  reserve: number,
): number | null {
  return reserve > 0 ? padding.bottom + reserve + PINBOARD_GAP_PX : null;
}
```

- [ ] **Step 4: Add `pinboard` to `src/lib/mapPrefs.ts`**

In `interface LayerPrefs`, after the `weather: boolean;` member (and its comment), add:

```ts
  /**
   * 地图底部的钉板（`MapPinboard.vue`）露不露出来。只管平板和桌面：手机上没有那条
   * 栏。后来加的键，旧偏好里没有，`readPrefs` 按默认值补上。
   */
  pinboard: boolean;
```

In `DEFAULT_PREFS`, after `weather: false,`, add:

```ts
  // **默认开。** 钉住的航图是这次飞行要看的那几张，第一眼就该在。
  pinboard: true,
```

In `readPrefs`, after the line `if (!isIfrChart(saved.chart)) delete saved.chart;`, add:

```ts
    if (typeof saved.pinboard !== "boolean") delete saved.pinboard;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/lib/pinboard.test.ts src/lib/mapPrefs.test.ts`
Expected: PASS, all tests.

Run: `bunx prettier --write src/lib/pinboard.ts src/lib/pinboard.test.ts src/lib/mapPrefs.ts src/lib/mapPrefs.test.ts && bun run typecheck && bun run check:i18n`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pinboard.ts src/lib/pinboard.test.ts
git -c commit.gpgsign=false commit -m "lib/pinboard.ts: pinboard groups, chips, padding; mapPrefs.pinboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/lib/pinboard.ts src/lib/pinboard.test.ts src/lib/mapPrefs.ts src/lib/mapPrefs.test.ts
```

---

### Task 2: Extract `useChartPins`; `MapStage` renders the viewer

Behaviour does not change except one point: closing the chart popover no longer closes an open viewer (the viewer is shared now). Everything else in the current `ChartPins.vue` moves as is: lazy first load, plan and `hideNaip` refetch while active (stale flag while inactive), procedure and pin re-read without refetch, `seq` guards on the plan and on each airport, per-airport retry, focus fix after a toggle, Esc on the popover only.

**Files:**
- Create: `src/components/map/useChartPins.ts`
- Modify: `src/components/map/ChartPins.vue` (whole file)
- Modify: `src/components/map/MapStage.vue` (imports, chart pin store, template)

**Interfaces:**
- Consumes: everything `ChartPins.vue` imports today from `@/lib/chartPins`, `@/lib/charts`, `@/lib/naip`, `@/lib/requestState`, `@/lib/mapBus`, `@/lib/planStore`, `@/lib/procedureSelection`.
- Produces (in `src/components/map/useChartPins.ts`):
  - `type PlanState = { kind: "loading" } | { kind: "error" } | { kind: "none" } | { kind: "plan"; plan: PinPlan }`
  - `interface ChartPinGroup extends PlanAirport { state: ChartsState; auto: Set<number>; pinned: ChartEntry[]; all: ChartEntry[]; unmatched: string[] }`
  - `interface ChartPinsStore { plan: Ref<PlanState>; groups: ComputedRef<ChartPinGroup[]>; stored: Ref<StoredPins>; openChart: Ref<ChartEntry | null>; emptyReason: ComputedRef<"hidden" | "none">; emptyBody: ComputedRef<"needsAccess" | "noCharts">; load(): Promise<void>; retry(airport: PlanAirport): void; toggle(chart: ChartEntry, auto: ReadonlySet<number>): void; open(chart: ChartEntry): void; close(): void }`
  - `useChartPins(options: { aipAccess: number; active: Ref<boolean> }): ChartPinsStore`
  - `const CHART_PINS_KEY: InjectionKey<ChartPinsStore>`
  - `injectChartPins(): ChartPinsStore`
  - `ChartPins.vue` props: `{ open: boolean; messages: Record<string, unknown> }` (the `aipAccess` prop is gone); emits `close`. Root keeps `id="map-chart-pins"`.

- [ ] **Step 1: Create `src/components/map/useChartPins.ts`**

```ts
/**
 * 本次飞行的钉住航图：计划、三个机场各自的航图索引、程序选择、本机存储、查看器里
 * 打开的那一张。MapStage 建一份，经 provide 交给底部钉板（`MapPinboard.vue`）和全
 * 部航图列表（`ChartPins.vue`）；查看器由 MapStage 按 `openChart` 渲染。
 *
 * 规则在 `lib/chartPins.ts`，这里只管取数和事件：
 *
 * - `active` 第一次变真才取数：钉板第一次露出来，或列表第一次打开。
 * - `active` 时计划、「不使用受限汇编」一变就重取；不 active 时只记一笔，下次变真
 *   再取。
 * - 程序选择、钉住变了只重读本机存储，不重取。
 * - 三个机场各管各的状态和重试；回来晚了（`seq` 已经变了）的回应丢掉。
 */
import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
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

export type PlanState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "plan"; plan: PinPlan };

export interface ChartPinGroup extends PlanAirport {
  state: ChartsState;
  auto: Set<number>;
  pinned: ChartEntry[];
  all: ChartEntry[];
  unmatched: string[];
}

export interface ChartPinsStore {
  plan: Ref<PlanState>;
  groups: ComputedRef<ChartPinGroup[]>;
  stored: Ref<StoredPins>;
  /** 查看器里开着的那一张。MapStage 按它渲染唯一的 ChartViewer。 */
  openChart: Ref<ChartEntry | null>;
  emptyReason: ComputedRef<"hidden" | "none">;
  emptyBody: ComputedRef<"needsAccess" | "noCharts">;
  load(): Promise<void>;
  retry(airport: PlanAirport): void;
  toggle(chart: ChartEntry, auto: ReadonlySet<number>): void;
  open(chart: ChartEntry): void;
  close(): void;
}

export const CHART_PINS_KEY: InjectionKey<ChartPinsStore> =
  Symbol("chart-pins");

/** 钉板和列表拿 MapStage 那一份。拿不到是接线错了，直接抛。 */
export function injectChartPins(): ChartPinsStore {
  const store = inject(CHART_PINS_KEY, null);
  if (!store) {
    throw new Error("injectChartPins: MapStage 没有 provide useChartPins");
  }
  return store;
}

export function useChartPins(options: {
  /** 航行资料库级别。空状态按它说话。 */
  aipAccess: number;
  /** 钉板露着，或列表开着。见文件顶上。 */
  active: Ref<boolean>;
}): ChartPinsStore {
  const plan = ref<PlanState>({ kind: "loading" });
  const states = ref<Partial<Record<PinRole, ChartsState>>>({});
  const selection = ref<ProcedureSelection>({ ...EMPTY_SELECTION });
  const stored = ref<StoredPins>(EMPTY_PINS);
  const openChart = ref<ChartEntry | null>(null);
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
    openChart.value = null;
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

  /** 计划、「不使用受限汇编」变了。 */
  function onSourceChange() {
    if (options.active.value) void load();
    else if (loaded) stale = true;
  }

  const groups = computed<ChartPinGroup[]>(() => {
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
    chartsEmptyReason(hideNaip.value, options.aipAccess),
  );
  const emptyBody = computed(() => chartsEmptyBody(options.aipAccess));

  /** 写存储；`writePins` 发 `efb:chart-pins-changed`，`rereadLocal` 接住。 */
  function toggle(chart: ChartEntry, auto: ReadonlySet<number>) {
    if (plan.value.kind !== "plan") return;
    const { departure, arrival } = plan.value.plan;
    writePins(departure, arrival, togglePin(stored.value, chart.id, auto));
  }

  /** 查看器开着时换一张：同一个 ChartViewer，换 `chart`。 */
  function open(chart: ChartEntry) {
    openChart.value = chart;
  }

  function close() {
    openChart.value = null;
  }

  watch(options.active, (on) => {
    if (on && (!loaded || stale)) void load();
  });
  watch(hideNaip, onSourceChange);

  onMounted(() => {
    window.addEventListener(PLAN_CHANGED_EVENT, onSourceChange);
    window.addEventListener(PROCEDURES_CHANGED_EVENT, rereadLocal);
    window.addEventListener(CHART_PINS_CHANGED_EVENT, rereadLocal);
  });
  onBeforeUnmount(() => {
    window.removeEventListener(PLAN_CHANGED_EVENT, onSourceChange);
    window.removeEventListener(PROCEDURES_CHANGED_EVENT, rereadLocal);
    window.removeEventListener(CHART_PINS_CHANGED_EVENT, rereadLocal);
  });

  return {
    plan,
    groups,
    stored,
    openChart,
    emptyReason,
    emptyBody,
    load,
    retry,
    toggle,
    open,
    close,
  };
}
```

- [ ] **Step 2: Replace `src/components/map/ChartPins.vue`**

```vue
<script setup lang="ts">
/**
 * 全部航图列表：本次飞行的起飞、落地、备降三个机场，钉住的在前，后面是折起来的全
 * 部航图。点一行在查看器里打开（查看器由 MapStage 渲染）。
 *
 * 状态是 MapStage 建的那一份（`useChartPins`），这里不取数。取数、重取、重读的规
 * 矩写在 `useChartPins.ts` 顶上。
 *
 * 每个机场的状态各管各的：一个机场没取到不影响另外两个，重试也只重试它。
 */
import { nextTick, ref, watch } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import StateCard from "@/components/ui/StateCard.vue";
import ChartPinRow from "@/components/map/ChartPinRow.vue";
import { injectChartPins } from "@/components/map/useChartPins";
import { createTranslator } from "@/lib/i18n";
import { isPinned, type PinRole } from "@/lib/chartPins";
import type { ChartEntry } from "@/lib/charts";

const props = defineProps<{
  open: boolean;
  /** `common` 两句、`airports.denied`、`airports.charts`（含 `viewer` 和 `pins`）。 */
  messages: Record<string, unknown>;
}>();
const emit = defineEmits<{ close: [] }>();
const t = createTranslator(props.messages);

const {
  plan,
  groups,
  stored,
  emptyReason,
  emptyBody,
  load,
  retry,
  toggle: togglePin,
  open: openChart,
} = injectChartPins();

const ROLE_LABEL: Record<PinRole, string> = {
  departure: t("airports.charts.pins.departure"),
  arrival: t("airports.charts.pins.arrival"),
  alternate: t("airports.charts.pins.alternate"),
};
const ROW_LABELS = {
  auto: t("airports.charts.pins.auto"),
  pin: t("airports.charts.pins.pin"),
};

const closeButton = ref<HTMLButtonElement | null>(null);
const sectionRef = ref<HTMLElement | null>(null);

function toggle(chart: ChartEntry, auto: ReadonlySet<number>, role: PinRole) {
  togglePin(chart, auto);
  // 钉住列表里的那一行被取消后会消失，焦点落到 body：挪到「全部航图」里同一张的按钮，
  // 没展开就挪到该机场的标题
  void nextTick(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const group = sectionRef.value?.querySelector(`[data-role="${role}"]`);
    const own = group?.querySelector<HTMLElement>(
      `details[open] [data-chart="${chart.id}"] button[aria-pressed]`,
    );
    (own ?? group?.querySelector<HTMLElement>("h3"))?.focus();
  });
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    closeButton.value?.focus();
  },
);

/** Esc 关列表，只管焦点在列表里时的按键。查看器在 body 下，它的 Esc 不经过这里。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !props.open) return;
  emit("close");
}
</script>

<template>
  <section
    v-show="open"
    id="map-chart-pins"
    ref="sectionRef"
    class="map-chart-pins glass"
    role="dialog"
    :aria-label="t('airports.charts.pins.title')"
    @keydown="onKeydown"
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
          :data-role="g.role"
          class="flex flex-col gap-2"
          :aria-label="`${ROLE_LABEL[g.role]} ${g.icao}`"
        >
          <h3
            tabindex="-1"
            class="flex items-baseline gap-2 text-xs font-semibold text-muted"
          >
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
                @toggle="toggle(c, g.auto, g.role)"
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
                  @toggle="toggle(c, g.auto, g.role)"
                />
              </ul>
            </details>
          </template>
        </section>
      </template>
    </div>
  </section>
</template>
```

- [ ] **Step 3: Create the store in `src/components/map/MapStage.vue` and render the viewer there**

1. In the `vue` import, add `provide`:

```ts
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";
```

2. After `import ChartPins from "@/components/map/ChartPins.vue";` add:

```ts
import ChartViewer from "@/components/ChartViewer.vue";
import { CHART_PINS_KEY, useChartPins } from "@/components/map/useChartPins";
```

3. Replace the block

```ts
/** 航图弹出层。第一次打开才取数（见 ChartPins.vue）。 */
const chartsOpen = ref(false);
const controls = ref<InstanceType<typeof MapControls> | null>(null);
```

with

```ts
/** 航图弹出层。第一次打开才取数（见 useChartPins.ts）。 */
const chartsOpen = ref(false);
const controls = ref<InstanceType<typeof MapControls> | null>(null);

/** 本次飞行的钉住航图。只建这一份，provide 给列表；查看器按 `openChart` 渲染。 */
const pins = useChartPins({ aipAccess: props.aipAccess, active: chartsOpen });
provide(CHART_PINS_KEY, pins);
const { openChart } = pins;
```

4. In the template, replace

```vue
      <ChartPins
        :open="chartsOpen"
        :aip-access="aipAccess"
        :messages="chartMessages"
        @close="closeCharts"
      />
    </div>
  </section>
```

with

```vue
      <ChartPins
        :open="chartsOpen"
        :messages="chartMessages"
        @close="closeCharts"
      />
    </div>

    <!-- 唯一的查看器。换一张时是同一个实例换 `chart`（它 watch `chart.id` 重载）。 -->
    <ChartViewer
      v-if="openChart"
      :chart="openChart"
      :messages="chartMessages"
      @close="pins.close()"
    />
  </section>
```

5. In the header comment list, replace the line ` * - ChartPins.vue      本次飞行的航图，地图上的「航图」按钮打开` with:

```ts
 * - `useChartPins`    本次飞行的钉住航图，这里建一份，provide 给列表
 * - ChartPins.vue      本次飞行的航图，地图上的「航图」按钮打开
 * - ChartViewer.vue    唯一的航图查看器，按 `openChart` 渲染
```

- [ ] **Step 4: Verify**

Run: `bun test src/lib/chartPins.test.ts`
Expected: PASS (unchanged file).

Run: `bunx prettier --write src/components/map/useChartPins.ts src/components/map/ChartPins.vue src/components/map/MapStage.vue && bun run typecheck && bun run check:i18n && bun run lint && bun run build`
Expected: all pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/map/useChartPins.ts
git -c commit.gpgsign=false commit -m "Map: chart pin state in useChartPins; MapStage renders the viewer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/map/useChartPins.ts src/components/map/ChartPins.vue src/components/map/MapStage.vue
```

---

### Task 3: Strings in four languages

**Files:**
- Modify: `language/zh-cn.json`, `language/zh-tw.json`, `language/en-us.json`, `language/ja-jp.json` (inside `efb.map`)

**Interfaces:**
- Produces keys (all under `efb.map`): `mode.label`, `mode.weather`, `mode.pinboard`, `toolbar.label`, `toolbar.high`, `toolbar.low`, `toolbar.chartSwitch` (placeholders `{current}`, `{next}`), `pinboard.label`, `pinboard.list`, `pinboard.noPlan`, `pinboard.planFailed`, `pinboard.noPins`, `pinboard.unpin`, `pinboard.chip.loading`, `pinboard.chip.failed`, `pinboard.chip.unconfigured`, `pinboard.chip.denied`, `pinboard.chip.needsAccess`, `pinboard.chip.hidden`, `pinboard.chip.empty`.
- Reused, not added: `map.layers.traffic`, `map.layers.atcLive` (mode bar Traffic and ATC), `map.layersMenu`, `map.view3d`, `map.locate`, `map.layerFailed`, `map.chart.high`, `map.chart.low`, `map.weather.light`, `map.weather.heavy`, `airports.charts.pins.noPlanAction`, `airports.charts.pins.auto`, `common.retry`, `common.loading`.

In each file, `efb.map` ends with `…"weather": { … }, "atc": { … }, "pilot": { … }`. Insert the block for that language immediately before the line `"atc": {` inside `efb.map` (that is, after the `"weather"` object's closing `},`).

- [ ] **Step 1: `language/zh-cn.json`**

```json
      "mode": {
        "label": "地图显示",
        "weather": "天气",
        "pinboard": "钉板"
      },
      "toolbar": {
        "label": "地图工具",
        "high": "HIGH",
        "low": "LOW",
        "chartSwitch": "{current}，点按切换到{next}"
      },
      "pinboard": {
        "label": "钉住的航图",
        "list": "全部航图",
        "noPlan": "没有提交飞行计划",
        "planFailed": "没能读取飞行计划",
        "noPins": "没有钉住的航图",
        "unpin": "取消钉住",
        "chip": {
          "loading": "读取中",
          "failed": "没取到",
          "unconfigured": "存储未接上",
          "denied": "无权限",
          "needsAccess": "需 3 级权限",
          "hidden": "已隐藏",
          "empty": "无航图"
        }
      },
```

- [ ] **Step 2: `language/zh-tw.json`**

```json
      "mode": {
        "label": "地圖顯示",
        "weather": "天氣",
        "pinboard": "釘選板"
      },
      "toolbar": {
        "label": "地圖工具",
        "high": "HIGH",
        "low": "LOW",
        "chartSwitch": "{current}，點按切換到{next}"
      },
      "pinboard": {
        "label": "釘選的航圖",
        "list": "全部航圖",
        "noPlan": "沒有提交飛行計畫",
        "planFailed": "沒能讀取飛行計畫",
        "noPins": "沒有釘選的航圖",
        "unpin": "取消釘選",
        "chip": {
          "loading": "讀取中",
          "failed": "沒取到",
          "unconfigured": "儲存未接上",
          "denied": "無權限",
          "needsAccess": "需 3 級權限",
          "hidden": "已隱藏",
          "empty": "無航圖"
        }
      },
```

- [ ] **Step 3: `language/en-us.json`**

```json
      "mode": {
        "label": "Map modes",
        "weather": "Weather",
        "pinboard": "Pinboard"
      },
      "toolbar": {
        "label": "Map tools",
        "high": "HIGH",
        "low": "LOW",
        "chartSwitch": "{current}; switch to {next}"
      },
      "pinboard": {
        "label": "Pinned charts",
        "list": "All charts",
        "noPlan": "No flight plan filed",
        "planFailed": "Couldn't read the flight plan",
        "noPins": "No pinned charts",
        "unpin": "Unpin",
        "chip": {
          "loading": "Loading",
          "failed": "Failed",
          "unconfigured": "No storage",
          "denied": "No access",
          "needsAccess": "Needs tier 3",
          "hidden": "Hidden",
          "empty": "No charts"
        }
      },
```

- [ ] **Step 4: `language/ja-jp.json`**

```json
      "mode": {
        "label": "地図の表示",
        "weather": "気象",
        "pinboard": "ピンボード"
      },
      "toolbar": {
        "label": "地図ツール",
        "high": "HIGH",
        "low": "LOW",
        "chartSwitch": "{current}（{next} に切り替え）"
      },
      "pinboard": {
        "label": "ピン留めしたチャート",
        "list": "すべてのチャート",
        "noPlan": "フライトプランが提出されていません",
        "planFailed": "フライトプランを読み込めませんでした",
        "noPins": "ピン留めしたチャートはありません",
        "unpin": "ピン留めを外す",
        "chip": {
          "loading": "読み込み中",
          "failed": "取得失敗",
          "unconfigured": "保存先未接続",
          "denied": "権限なし",
          "needsAccess": "レベル 3 が必要",
          "hidden": "非表示",
          "empty": "チャートなし"
        }
      },
```

- [ ] **Step 5: Verify**

Run: `for f in zh-cn zh-tw en-us ja-jp; do jq -e '.efb.map.pinboard.chip.empty and .efb.map.toolbar.chartSwitch and .efb.map.mode.pinboard' language/$f.json; done`
Expected: `true` four times.

Run: `bunx prettier --write language/zh-cn.json language/zh-tw.json language/en-us.json language/ja-jp.json && bun run check:i18n && bun test src/lib/i18n.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git -c commit.gpgsign=false commit -m "i18n: map mode bar, toolbar and pinboard strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- language/zh-cn.json language/zh-tw.json language/en-us.json language/ja-jp.json
```

---

### Task 4: `MapModeBar.vue` and `MapToolbar.vue`

The two components and their CSS land here, not yet mounted. `MapControls.vue` keeps working until Task 6.

**Files:**
- Create: `src/components/map/MapModeBar.vue`
- Create: `src/components/map/MapToolbar.vue`
- Modify: `src/styles/globals.css` (new rules, inserted immediately before the comment line `/* 表单两列排布（FieldGrid.vue）。按面板宽度判：standard 面板 26rem 恒为一列，wide`)

**Interfaces:**
- Consumes: `LayerId` from `@/components/map/useLayerNotice`; `ChartLayerToggle` from `@/components/map/useChartLayers`; `IfrChart` from `@/lib/ifrChart`; `IconName` from `@jianyuelab-org/can-ui/icons`.
- Produces:
  - `MapModeBar.vue`: `export type ModeToggle = "traffic" | "atcLive" | "weather" | "pinboard"`; `export interface MapModeBarText { label; traffic; atc; weather; pinboard; weatherLight; weatherHeavy; layerFailed; retry: string }`. Props `{ on: Record<ModeToggle, boolean>; atcCount: number; phone: boolean; listOpen: boolean; failure: "live" | "weather" | null; text: MapModeBarText }`. Emits `toggle: [ModeToggle]`, `retry: [LayerId]`. Root class `map-modebar`.
  - `MapToolbar.vue`: `export interface MapToolbarText { label; layers; layerFailed; retry; view3d; locate; high; low; chartHigh; chartLow; chartSwitch: string }`. Props `{ labels: Record<ChartLayerToggle, string>; on: Record<ChartLayerToggle, boolean>; chart: IfrChart; busy: { airways: boolean; other: boolean }; failure: LayerId | null; view3d: boolean; own: { callsign: string } | null; phone: boolean; text: MapToolbarText }`. Emits `toggle: [ChartLayerToggle]`, `chart: [IfrChart]`, `retry: [LayerId]`, `view3d: []`, `locate: []`. Root class `map-toolbar`. Flyout id `map-layer-flyout`.
  - CSS classes: `.map-chrome`, `.map-modebar`, `.map-modebar-strip`, `.map-mode-btn`, `.map-toolbar`, `.map-tool-wrap`, `.map-tool-btn`, `.map-tool-chart`, `.map-tool-alert`, `.map-layer-flyout`.

- [ ] **Step 1: Create `src/components/map/MapModeBar.vue`**

```vue
<script setup lang="ts">
/**
 * 地图可见区左上的模式条：机组、管制、天气、钉板。一条玻璃，四个带字的开关；手机
 * 上只剩图标，字留在 aria-label 和 title 里。
 *
 * 机组、管制是实时那两层（useTrafficLayer），天气是降水（useWeatherLayer），钉板管
 * 底部那条钉住航图的栏。手机上没有那条栏，钉板按钮打开全部航图列表，所以它报的是
 * `aria-expanded` 而不是 `aria-pressed`。
 *
 * 实时和降水没取到时的那句话和重试挂在这里：它们不在工具栏的图层菜单里。
 *
 * 只收已经翻好的字符串、只往外发事件。
 */
import { Icon } from "@jianyuelab-org/can-ui";
import type { IconName } from "@jianyuelab-org/can-ui/icons";
import type { LayerId } from "@/components/map/useLayerNotice";

export type ModeToggle = "traffic" | "atcLive" | "weather" | "pinboard";

export interface MapModeBarText {
  /** 整条的名字（`role="group"`）。 */
  label: string;
  traffic: string;
  atc: string;
  weather: string;
  pinboard: string;
  /** 降水图例两端。 */
  weatherLight: string;
  weatherHeavy: string;
  /** 带 `{layer}`。 */
  layerFailed: string;
  retry: string;
}

const props = defineProps<{
  on: Record<ModeToggle, boolean>;
  /** 在线管制席位数，挂在管制按钮上。 */
  atcCount: number;
  phone: boolean;
  /** 全部航图列表开着。手机上钉板按钮开的是它。 */
  listOpen: boolean;
  /** 实时或降水没取到。别的层的失败在工具栏的图层菜单里。 */
  failure: "live" | "weather" | null;
  text: MapModeBarText;
}>();

const emit = defineEmits<{
  toggle: [ModeToggle];
  retry: [LayerId];
}>();

const MODES: { id: ModeToggle; icon: IconName }[] = [
  { id: "traffic", icon: "paperAirplane" },
  { id: "atcLive", icon: "signal" },
  { id: "weather", icon: "cloud" },
  { id: "pinboard", icon: "star" },
];

function label(id: ModeToggle): string {
  if (id === "traffic") return props.text.traffic;
  if (id === "atcLive") return props.text.atc;
  if (id === "weather") return props.text.weather;
  return props.text.pinboard;
}

/** 手机上的钉板按钮开列表，不是开关。 */
function opensList(id: ModeToggle): boolean {
  return props.phone && id === "pinboard";
}

function isOn(id: ModeToggle): boolean {
  return opensList(id) ? props.listOpen : props.on[id];
}

/** 没取到的是哪一层。`live` 是机组和管制共用的那一次取数，两个名字都报。 */
function failureText(): string {
  const layer =
    props.failure === "live"
      ? `${props.text.traffic} · ${props.text.atc}`
      : props.text.weather;
  return props.text.layerFailed.replace("{layer}", layer);
}
</script>

<template>
  <div class="map-modebar">
    <div class="map-modebar-strip glass" role="group" :aria-label="text.label">
      <button
        v-for="m in MODES"
        :key="m.id"
        type="button"
        class="map-mode-btn"
        :class="isOn(m.id) ? 'is-on' : ''"
        :aria-pressed="opensList(m.id) ? undefined : on[m.id]"
        :aria-expanded="opensList(m.id) ? listOpen : undefined"
        :aria-controls="opensList(m.id) ? 'map-chart-pins' : undefined"
        :aria-label="phone ? label(m.id) : undefined"
        :title="label(m.id)"
        @click="emit('toggle', m.id)"
      >
        <Icon :name="m.icon" class="size-4" />
        <span v-if="!phone">{{ label(m.id) }}</span>
        <span
          v-if="m.id === 'atcLive' && on.atcLive && atcCount"
          class="map-layer-count"
          >{{ atcCount }}</span
        >
      </button>
    </div>

    <!-- 降水图例：开着才有。颜色是 can-api 重新着色后的那条绿 → 黄 → 红。 -->
    <div v-if="on.weather" class="map-weather-legend glass" aria-hidden="true">
      <span>{{ text.weatherLight }}</span>
      <span class="map-weather-ramp"></span>
      <span>{{ text.weatherHeavy }}</span>
    </div>

    <!--
      没取到的那一层。它已经退回关了 —— 没有这一句，它就是安静地从图上消失，和
      「这一带没有数据」长得一模一样。
    -->
    <div v-if="failure" class="map-layer-failure glass" role="status">
      <span>{{ failureText() }}</span>
      <button type="button" class="link shrink-0" @click="emit('retry', failure)">
        {{ text.retry }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Create `src/components/map/MapToolbar.vue`**

```vue
<script setup lang="ts">
/**
 * 模式条下面那一列图标按钮：IFR 高 / 低空、图层、3D、定位到我。
 *
 * 图层按钮向右弹出静态那几层（航路、情报区、导航台、MORA、区域、进近、限制区）。
 * 哪一层没取到，就在那一层下面说，带重试；菜单关着时图层按钮挂一个警示点，失败不
 * 安静地藏在菜单里。实时和降水的失败在模式条上。
 *
 * 手机上 3D 收进图层菜单。「定位到我」只在自己连着线时出现。
 *
 * 只收已经翻好的字符串、只往外发事件。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { LayerId } from "@/components/map/useLayerNotice";
import type { ChartLayerToggle } from "@/components/map/useChartLayers";
import type { IfrChart } from "@/lib/ifrChart";

export interface MapToolbarText {
  /** 整列的名字（`role="group"`）。 */
  label: string;
  /** 图层按钮和菜单的名字。 */
  layers: string;
  /** 带 `{layer}`。 */
  layerFailed: string;
  retry: string;
  view3d: string;
  locate: string;
  /** 按钮上那两行的第一行。 */
  high: string;
  low: string;
  /** 两张航图的全名，读屏和 title 用。 */
  chartHigh: string;
  chartLow: string;
  /** 带 `{current}`、`{next}`。 */
  chartSwitch: string;
}

const props = defineProps<{
  labels: Record<ChartLayerToggle, string>;
  on: Record<ChartLayerToggle, boolean>;
  /** 当前航图：管航路、航路点和禁区一族画哪些。 */
  chart: IfrChart;
  busy: { airways: boolean; other: boolean };
  failure: LayerId | null;
  /** 地图此刻倾斜着。 */
  view3d: boolean;
  /** 自己连着线时才有。 */
  own: { callsign: string } | null;
  phone: boolean;
  text: MapToolbarText;
}>();

const emit = defineEmits<{
  toggle: [ChartLayerToggle];
  chart: [IfrChart];
  retry: [LayerId];
  view3d: [];
  locate: [];
}>();

/** 菜单里的顺序，和原来图层菜单里静态那几层一致。 */
const LAYERS: ChartLayerToggle[] = [
  "airways",
  "firs",
  "navaids",
  "mora",
  "ctr",
  "app",
  "restricted",
];

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const flyout = ref<HTMLElement | null>(null);

/** 静态那几层里没取到的那一层。 */
const staticFailure = computed<ChartLayerToggle | null>(() => {
  const f = props.failure;
  return f && f !== "live" && f !== "weather" ? f : null;
});

/** 图层按钮的名字。有一层没取到时把那句话接在后面，菜单关着也读得到。 */
const layersName = computed(() =>
  staticFailure.value
    ? `${props.text.layers} · ${props.text.layerFailed.replace(
        "{layer}",
        props.labels[staticFailure.value],
      )}`
    : props.text.layers,
);

const nextChart = computed<IfrChart>(() =>
  props.chart === "high" ? "low" : "high",
);

function chartTitle(c: IfrChart): string {
  return c === "high" ? props.text.chartHigh : props.text.chartLow;
}

const chartName = computed(() =>
  props.text.chartSwitch
    .replace("{current}", chartTitle(props.chart))
    .replace("{next}", chartTitle(nextChart.value)),
);

const locateName = computed(() =>
  props.own ? `${props.text.locate} ${props.own.callsign}` : props.text.locate,
);

function isBusy(id: ChartLayerToggle): boolean {
  return id === "airways" ? props.busy.airways : props.busy.other;
}

/** 打开时焦点落到第一个能按的开关上；Esc 关掉时回到按钮（见 onKeydown）。 */
async function toggleFlyout() {
  open.value = !open.value;
  if (!open.value) return;
  await nextTick();
  flyout.value
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !open.value) return;
  open.value = false;
  trigger.value?.focus();
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div
    ref="root"
    class="map-toolbar glass"
    role="group"
    :aria-label="text.label"
  >
    <!-- IFR 高空 / 低空：按一下换到另一张。航路关着也管禁区一族，所以一直在。 -->
    <button
      type="button"
      class="map-tool-btn map-tool-chart"
      :aria-label="chartName"
      :title="chartName"
      @click="emit('chart', nextChart)"
    >
      <span>{{ chart === "high" ? text.high : text.low }}</span>
      <span>IFR</span>
    </button>

    <div class="map-tool-wrap">
      <button
        ref="trigger"
        type="button"
        class="map-tool-btn"
        :class="open ? 'is-on' : ''"
        :aria-expanded="open"
        aria-controls="map-layer-flyout"
        :aria-label="layersName"
        :title="layersName"
        @click="toggleFlyout"
      >
        <Icon name="squaresPlus" class="size-5" />
        <span v-if="staticFailure" class="map-tool-alert" aria-hidden="true" />
      </button>
      <!-- v-show 而不是 v-if：aria-controls 要指得到一个真实的元素。 -->
      <div
        v-show="open"
        id="map-layer-flyout"
        ref="flyout"
        class="map-layer-flyout glass"
        role="group"
        :aria-label="text.layers"
      >
        <template v-for="id in LAYERS" :key="id">
          <button
            type="button"
            class="map-layer-btn"
            :class="on[id] ? 'is-on' : ''"
            :aria-pressed="on[id]"
            :disabled="isBusy(id)"
            @click="emit('toggle', id)"
          >
            {{ labels[id] }}
          </button>
          <div
            v-if="staticFailure === id"
            class="map-layer-failure"
            role="status"
          >
            <span>{{ text.layerFailed.replace("{layer}", labels[id]) }}</span>
            <button
              type="button"
              class="link shrink-0"
              @click="emit('retry', id)"
            >
              {{ text.retry }}
            </button>
          </div>
        </template>
        <!-- 手机上 3D 在这里，不占工具栏的一格。 -->
        <button
          v-if="phone"
          type="button"
          class="map-layer-btn"
          :class="view3d ? 'is-on' : ''"
          :aria-pressed="view3d"
          @click="emit('view3d')"
        >
          {{ text.view3d }}
        </button>
      </div>
    </div>

    <!-- 倾斜视角：空域立体块、航线高度剖面、机组高度柱。手势倾斜也会让它亮起来。 -->
    <button
      v-if="!phone"
      type="button"
      class="map-tool-btn"
      :class="view3d ? 'is-on' : ''"
      :aria-pressed="view3d"
      :title="text.view3d"
      @click="emit('view3d')"
    >
      <span class="text-xs font-semibold">{{ text.view3d }}</span>
    </button>

    <!-- 只在自己真的连着线时出现；按下去没反应的按钮比没有更让人怀疑。 -->
    <button
      v-if="own"
      type="button"
      class="map-tool-btn"
      :aria-label="locateName"
      :title="locateName"
      @click="emit('locate')"
    >
      <span aria-hidden="true">✈</span>
    </button>
  </div>
</template>
```

- [ ] **Step 3: Add the CSS**

Insert into `src/styles/globals.css`, immediately before the comment line that starts `/* 表单两列排布（FieldGrid.vue）`:

```css
/* 地图左上：模式条在上，工具栏在下，一列。容器本身不接指针 —— 两者之间的空白
   挡住拖动就是一个看不出原因的死角。 */
.map-overlay > .map-chrome {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
  max-width: calc(100% - 1rem);
  pointer-events: none;
}
.map-chrome > * {
  pointer-events: auto;
}
.map-chrome > .map-modebar {
  pointer-events: none;
}
.map-modebar > * {
  pointer-events: auto;
}

/* 模式条：一条玻璃里四个开关，旁边是降水图例，没取到的提示另起一行。 */
.map-modebar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
}
.map-modebar-strip {
  display: inline-flex;
  gap: 0.125rem;
  padding: 0.25rem;
  border-radius: var(--radius-card);
}
.map-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.3rem 0.6rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  color: var(--color-muted);
}
.map-mode-btn:hover {
  background: var(--surface-overlay);
}
.map-mode-btn.is-on {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
.map-modebar > .map-layer-failure {
  flex-basis: 100%;
}

/* 工具栏：一列方形图标按钮。 */
.map-toolbar {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding: 0.25rem;
  border-radius: var(--radius-card);
}
.map-tool-wrap {
  position: relative;
}
.map-tool-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  min-height: 2.5rem;
  border-radius: 0.25rem;
  color: var(--color-muted);
}
.map-tool-btn:hover {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
.map-tool-btn.is-on {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
/* HIGH / LOW 在上，IFR 在下。 */
.map-tool-chart {
  font-size: 0.625rem;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: 0.02em;
}
/* 图层按钮上的警示点：有一层没取到，菜单关着也看得见。 */
.map-tool-alert {
  position: absolute;
  top: 0.3rem;
  right: 0.3rem;
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 9999px;
  background: var(--color-danger);
}
/* 图层菜单：从图层按钮向右弹出。 */
.map-layer-flyout {
  position: absolute;
  z-index: 1;
  top: 0;
  left: calc(100% + 0.5rem);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.125rem;
  width: 13rem;
  padding: 0.25rem;
  border-radius: var(--radius-card);
}
.map-layer-flyout .map-layer-btn {
  text-align: left;
}
.map-layer-flyout .map-layer-failure {
  max-width: none;
  padding: 0.25rem 0.6rem;
  font-size: 0.7rem;
}
```

- [ ] **Step 4: Verify**

Run: `bunx prettier --write src/components/map/MapModeBar.vue src/components/map/MapToolbar.vue src/styles/globals.css && bun run typecheck && bun run check:i18n && bun run lint && bun run build`
Expected: all pass; build succeeds (components unused for now).

- [ ] **Step 5: Commit**

```bash
git add src/components/map/MapModeBar.vue src/components/map/MapToolbar.vue
git -c commit.gpgsign=false commit -m "Map: MapModeBar and MapToolbar components

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/map/MapModeBar.vue src/components/map/MapToolbar.vue src/styles/globals.css
```

---

### Task 5: `MapPinboard.vue`

The bar lands here, not yet mounted.

**Files:**
- Create: `src/components/map/MapPinboard.vue`
- Modify: `src/components/chartTags.ts` (add `CHART_STRIP_CLASS`)
- Modify: `src/styles/globals.css` (new rules, inserted immediately before the comment line `/* 表单两列排布（FieldGrid.vue）`)

**Interfaces:**
- Consumes: `injectChartPins()` (Task 2); `pinboardGroups`, `pinboardView`, `chipRetries`, `toolbarIndex`, `AirportChip`, `StripColour` from `@/lib/pinboard` (Task 1).
- Produces:
  - `CHART_STRIP_CLASS: Record<StripColour, string>` in `src/components/chartTags.ts`.
  - `MapPinboard.vue`: `export interface MapPinboardText { label; list; noPlan; noPlanAction; planFailed; noPins; unpin; auto; retry; loading: string; chip: Record<AirportChip, string> }`. Props `{ text: MapPinboardText; listOpen: boolean }`. Emits `list: []`, `height: [number]` (the bar's `offsetHeight`, on mount and on every resize). Root class `map-pinboard`, `role="toolbar"`.

- [ ] **Step 1: Add strip classes to `src/components/chartTags.ts`**

Replace the file with:

```ts
/** 航图类别的颜色。机场详情的航图标签、地图的航图列表和底部钉板共用。 */
import type { ChartCategory } from "@/lib/charts";
import type { StripColour } from "@/lib/pinboard";

export const CHART_TAG_CLASS: Record<ChartCategory, string> = {
  STAR: "text-emerald-700 dark:text-emerald-300",
  APP: "text-orange-700 dark:text-orange-300",
  TAXI: "text-blue-700 dark:text-blue-300",
  SID: "text-pink-700 dark:text-pink-300",
  REF: "text-violet-700 dark:text-violet-300",
};

/** 钉板标签顶上那道色条（`lib/pinboard.ts` 的 `STRIP_COLOUR`）。和上面同一组色相。 */
export const CHART_STRIP_CLASS: Record<StripColour, string> = {
  green: "border-t-emerald-500",
  orange: "border-t-orange-500",
  blue: "border-t-blue-500",
  pink: "border-t-pink-500",
  violet: "border-t-violet-500",
};
```

- [ ] **Step 2: Create `src/components/map/MapPinboard.vue`**

```vue
<script setup lang="ts">
/**
 * 地图底部的钉板（平板和桌面）：钉住的航图按机场排成一行标签。点一个在查看器里
 * 打开；查看器开着时点另一个直接换。最左是「全部航图」按钮。
 *
 * 状态是 MapStage 建的那一份（`useChartPins`），这里不取数。分组和每个机场那颗小牌
 * 子在 `lib/pinboard.ts`。
 *
 * 键盘：整条是一个 toolbar，只有一个 Tab 停点；左右方向键、Home、End 在按钮之间
 * 走，Enter 打开。右键、长按或菜单键弹出「取消钉住」。
 *
 * 自己的高度经 `height` 报给 MapStage：地图内边距和查看器底边按它让。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, shallowRef } from "vue";
import { Icon, Spinner } from "@jianyuelab-org/can-ui";
import { CHART_STRIP_CLASS } from "@/components/chartTags";
import { injectChartPins } from "@/components/map/useChartPins";
import type { ChartEntry } from "@/lib/charts";
import {
  chipRetries,
  pinboardGroups,
  pinboardView,
  toolbarIndex,
  type AirportChip,
} from "@/lib/pinboard";

export interface MapPinboardText {
  /** 整条的名字（`role="toolbar"`）。 */
  label: string;
  list: string;
  noPlan: string;
  noPlanAction: string;
  planFailed: string;
  noPins: string;
  unpin: string;
  auto: string;
  retry: string;
  loading: string;
  chip: Record<AirportChip, string>;
}

defineProps<{
  text: MapPinboardText;
  /** 全部航图列表开着。 */
  listOpen: boolean;
}>();
const emit = defineEmits<{ list: []; height: [number] }>();

const { plan, groups, emptyReason, emptyBody, openChart, load, retry, toggle, open } =
  injectChartPins();

const view = computed(() =>
  pinboardView(
    plan.value.kind,
    pinboardGroups(groups.value, emptyReason.value, emptyBody.value),
  ),
);

const bar = ref<HTMLElement | null>(null);
const listButton = ref<HTMLButtonElement | null>(null);
const menuItem = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

/* ------------------------------------------------------------ 一个 Tab 停点 */

/** 栏里能按的东西，按 DOM 顺序。菜单项不算：它有自己的焦点。 */
function stops(): HTMLElement[] {
  return bar.value
    ? [
        ...bar.value.querySelectorAll<HTMLElement>(
          "button:not([role='menuitem']), a[href]",
        ),
      ]
    : [];
}

/** 上次停在哪一个。重画后它还在就还是它，不在就是打开着的那张，再不然是第一个。 */
let current: HTMLElement | null = null;

function syncStops() {
  const items = stops();
  if (!items.length) return;
  const active =
    (current && items.includes(current) ? current : null) ??
    items.find((el) => el.getAttribute("aria-current") === "true") ??
    items[0];
  for (const el of items) el.tabIndex = el === active ? 0 : -1;
}

function onFocusin(event: FocusEvent) {
  const target = event.target as HTMLElement;
  if (!stops().includes(target)) return;
  current = target;
  syncStops();
}

function onKeydown(event: KeyboardEvent) {
  if (menu.value) return;
  const items = stops();
  const next = toolbarIndex(
    event.key,
    items.indexOf(document.activeElement as HTMLElement),
    items.length,
  );
  if (next === null) return;
  event.preventDefault();
  items[next].focus();
  items[next].scrollIntoView({ block: "nearest", inline: "nearest" });
}

/* ------------------------------------------------------------ 取消钉住 */

interface PinMenu {
  chart: ChartEntry;
  auto: ReadonlySet<number>;
  /** 菜单左边缘，相对栏。 */
  x: number;
  /** 弹出它的标签，Esc 时焦点回去。 */
  tab: HTMLElement;
}

const menu = shallowRef<PinMenu | null>(null);

async function openMenu(
  tab: HTMLElement,
  chart: ChartEntry,
  auto: ReadonlySet<number>,
) {
  const barLeft = bar.value?.getBoundingClientRect().left ?? 0;
  const x = Math.max(0, tab.getBoundingClientRect().left - barLeft);
  menu.value = { chart, auto, x, tab };
  await nextTick();
  menuItem.value?.focus();
}

function closeMenu(returnFocus: boolean) {
  const m = menu.value;
  menu.value = null;
  if (returnFocus) m?.tab.focus();
}

function unpin() {
  const m = menu.value;
  if (!m) return;
  closeMenu(false);
  toggle(m.chart, m.auto);
  // 那个标签没了，焦点落到 body：交给列表按钮。
  void nextTick(() => {
    const active = document.activeElement;
    if (!active || active === document.body) listButton.value?.focus();
  });
}

/* 长按（触屏）。iOS Safari 长按不发 contextmenu，所以自己计时。 */
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 8;
let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null =
  null;
/** 长按弹出菜单后，松手那一下的 click 不算打开。 */
let suppressClick = false;

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function startPress(
  event: PointerEvent,
  chart: ChartEntry,
  auto: ReadonlySet<number>,
) {
  suppressClick = false;
  if (event.pointerType !== "touch") return;
  cancelPress();
  const tab = event.currentTarget as HTMLElement;
  press = {
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      press = null;
      suppressClick = true;
      void openMenu(tab, chart, auto);
    }, LONG_PRESS_MS),
  };
}

function movePress(event: PointerEvent) {
  if (
    press &&
    Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP_PX
  ) {
    cancelPress();
  }
}

function onTabClick(chart: ChartEntry) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  open(chart);
}

function onDocumentPointerdown(event: PointerEvent) {
  if (menu.value && !menuEl.value?.contains(event.target as Node)) {
    closeMenu(false);
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !menu.value) return;
  event.preventDefault();
  closeMenu(true);
}

/* ------------------------------------------------------------ 高度 */

let resizeObserver: ResizeObserver | null = null;

function reportHeight() {
  emit("height", bar.value?.offsetHeight ?? 0);
}

onMounted(() => {
  syncStops();
  document.addEventListener("pointerdown", onDocumentPointerdown);
  document.addEventListener("keydown", onDocumentKeydown);
  if (bar.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(reportHeight);
    resizeObserver.observe(bar.value);
  }
  reportHeight();
});
onUpdated(syncStops);
onBeforeUnmount(() => {
  cancelPress();
  resizeObserver?.disconnect();
  document.removeEventListener("pointerdown", onDocumentPointerdown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div
    ref="bar"
    class="map-pinboard glass"
    role="toolbar"
    :aria-label="text.label"
    @keydown="onKeydown"
    @focusin="onFocusin"
  >
    <button
      ref="listButton"
      type="button"
      class="map-pin-list"
      :class="listOpen ? 'is-on' : ''"
      :aria-expanded="listOpen"
      aria-controls="map-chart-pins"
      :aria-label="text.list"
      :title="text.list"
      @click="emit('list')"
    >
      <Icon name="documentText" class="size-4" />
    </button>

    <p v-if="view.kind === 'loading'" class="map-pin-state">
      <Spinner size="sm" :label="text.loading" />
    </p>
    <p v-else-if="view.kind === 'planFailed'" class="map-pin-state" role="status">
      <span>{{ text.planFailed }}</span>
      <button type="button" class="link" @click="load()">
        {{ text.retry }}
      </button>
    </p>
    <p v-else-if="view.kind === 'noPlan'" class="map-pin-state">
      <span>{{ text.noPlan }}</span>
      <a href="/flightplan" class="link">{{ text.noPlanAction }}</a>
    </p>
    <p v-else-if="view.kind === 'noPins'" class="map-pin-state">
      {{ text.noPins }}
    </p>

    <div v-else class="map-pin-scroll">
      <template v-for="g in view.groups" :key="g.role">
        <!-- 机场分隔，不是按钮。没有标签可画时它就是那颗牌子，完整的话在列表里。 -->
        <span
          class="map-pin-sep"
          :class="g.chip && g.chip !== 'loading' ? 'is-warn' : ''"
          :role="g.chip ? 'status' : undefined"
          :title="g.chip ? `${g.icao} · ${text.chip[g.chip]}` : undefined"
        >
          <Spinner
            v-if="g.chip === 'loading'"
            size="sm"
            :label="text.chip.loading"
          />
          <Icon
            v-else-if="g.chip"
            name="exclamationTriangle"
            class="size-3.5"
          />
          <span class="font-mono">{{ g.icao }}</span>
          <span v-if="g.chip && g.chip !== 'loading'">{{
            text.chip[g.chip]
          }}</span>
        </span>
        <button
          v-if="chipRetries(g.chip)"
          type="button"
          class="link map-pin-retry"
          @click="retry(g)"
        >
          {{ text.retry }}
        </button>
        <button
          v-for="tab in g.tabs"
          :key="tab.chart.id"
          type="button"
          class="map-pin-tab"
          :class="[
            CHART_STRIP_CLASS[tab.colour],
            openChart?.id === tab.chart.id ? 'is-open' : '',
          ]"
          :aria-current="openChart?.id === tab.chart.id ? 'true' : undefined"
          :title="tab.chart.name"
          :data-chart="tab.chart.id"
          @click="onTabClick(tab.chart)"
          @contextmenu.prevent="
            openMenu($event.currentTarget as HTMLElement, tab.chart, g.auto)
          "
          @pointerdown="startPress($event, tab.chart, g.auto)"
          @pointermove="movePress"
          @pointerup="cancelPress"
          @pointercancel="cancelPress"
        >
          <span class="map-pin-name">{{ tab.chart.name }}</span>
          <span v-if="tab.auto" class="map-pin-auto" aria-hidden="true" />
          <span v-if="tab.auto" class="sr-only">{{ text.auto }}</span>
        </button>
      </template>
    </div>

    <div
      v-if="menu"
      ref="menuEl"
      class="map-pin-menu glass"
      role="menu"
      :style="{ left: `${menu.x}px` }"
    >
      <button ref="menuItem" type="button" role="menuitem" @click="unpin">
        {{ text.unpin }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 3: Add the CSS**

Insert into `src/styles/globals.css`, immediately before the comment line that starts `/* 表单两列排布（FieldGrid.vue）`:

```css
/* 底部钉板（MapPinboard.vue）。贴在可见区底边，`bottom` 和 lib/pinboard.ts 的
   PINBOARD_GAP_PX 同值。右端让给比例尺（ScaleControl 宽 90px 加 10px 外边距）。 */
.map-pinboard {
  position: absolute;
  left: 0.5rem;
  right: 7.5rem;
  bottom: 0.5rem;
  display: flex;
  align-items: stretch;
  gap: 0.25rem;
  min-height: 3rem;
  padding: 0.25rem;
  border-radius: var(--radius-card);
}
.map-pin-list {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  border-radius: 0.25rem;
  color: var(--color-muted);
}
.map-pin-list:hover,
.map-pin-list.is-on {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
.map-pin-state {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.5rem;
  font-size: 0.75rem;
  color: var(--color-muted);
}
/* 标签多了横向滚。 */
.map-pin-scroll {
  display: flex;
  flex: 1 1 auto;
  align-items: stretch;
  gap: 0.25rem;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
.map-pin-sep {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0.3rem;
  padding: 0 0.4rem;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-muted);
}
.map-pin-sep.is-warn {
  align-self: center;
  padding: 0.15rem 0.5rem;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-warning) 18%, transparent);
  color: var(--color-ink);
}
.map-pin-retry {
  flex-shrink: 0;
  align-self: center;
  font-size: 0.7rem;
}
/* 一张钉住的航图。顶上色条的颜色来自 CHART_STRIP_CLASS，这里只给宽度。 */
.map-pin-tab {
  position: relative;
  flex-shrink: 0;
  width: 8rem;
  padding: 0.3rem 0.5rem;
  border-top-width: 3px;
  border-top-style: solid;
  border-radius: 0.25rem;
  text-align: left;
  font-size: 0.7rem;
  line-height: 1.25;
  color: var(--color-muted);
  -webkit-touch-callout: none;
  user-select: none;
}
.map-pin-tab:hover {
  background: var(--surface-overlay);
}
.map-pin-tab.is-open {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
/* 名称至多两行。 */
.map-pin-name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  word-break: break-all;
}
/* 自动钉住的小点。 */
.map-pin-auto {
  position: absolute;
  top: 0.35rem;
  right: 0.3rem;
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 9999px;
  background: var(--color-muted);
}
.map-pin-menu {
  position: absolute;
  z-index: 1;
  bottom: calc(100% + 0.25rem);
  padding: 0.25rem;
  border-radius: var(--radius-control);
}
.map-pin-menu button {
  padding: 0.3rem 0.6rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  white-space: nowrap;
  color: var(--color-ink);
}
.map-pin-menu button:hover {
  background: var(--surface-overlay);
}
```

- [ ] **Step 4: Verify**

Run: `bunx prettier --write src/components/map/MapPinboard.vue src/components/chartTags.ts src/styles/globals.css && bun run typecheck && bun run check:i18n && bun run lint && bun run build`
Expected: all pass; build succeeds (component unused for now).

- [ ] **Step 5: Commit**

```bash
git add src/components/map/MapPinboard.vue
git -c commit.gpgsign=false commit -m "Map: MapPinboard component and chart strip colours

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/map/MapPinboard.vue src/components/chartTags.ts src/styles/globals.css
```

---

### Task 6: Swap in the new chrome; delete `MapControls.vue`

**Files:**
- Modify: `src/components/map/MapStage.vue` (whole file)
- Delete: `src/components/map/MapControls.vue`
- Modify: `src/layouts/AppLayout.astro` (the `t={{ … }}` object)
- Modify: `src/components/map/RouteMap.vue:701-704` (`NavigationControl` position)
- Modify: `src/components/map/attribution.ts` (`apply`)
- Modify: `src/styles/globals.css` (remove old rules, move notice, details card and NW corner)

**Interfaces:**
- Consumes: `MapModeBar` / `ModeToggle` / `MapModeBarText` and `MapToolbar` / `MapToolbarText` (Task 4); `MapPinboard` / `MapPinboardText` (Task 5); `useChartPins`, `CHART_PINS_KEY` (Task 2); `parseShellMode`, `ShellMode` from `@/lib/panelLayout`; `writePrefs` from `@/lib/mapPrefs`; `ChartLayerToggle` from `@/components/map/useChartLayers`.
- Produces: `MapStage` prop `t` drops `chart` and `charts`, gains `mode: { label; weather; pinboard }`, `toolbar: { label; high; low; chartSwitch }`, `pinboard: MapPinboardText`. `barVisible`, `listOpen`, `phone` in `MapStage` (Task 7 reads `barVisible`). `MapPinboard` mounted with `@list` only (Task 7 adds `@height`).

- [ ] **Step 1: Replace `src/components/map/MapStage.vue`**

```vue
<script setup lang="ts">
/**
 * 常驻的显示面。
 *
 * 从前的 MapSurface.vue（1,525 行）按它本来就有的几条缝拆开，这个文件只负责把
 * 它们接起来：
 *
 * - `useLayerNotice`  这一层为什么没东西、被拒过没有、哪一层没取到
 * - `useChartLayers`  图层登记处：航路、导航台、情报区、MORA、空域、机场与跑道
 * - `useGroundLayer`  机场地面，没有开关，由缩放决定
 * - `useTrafficLayer` 实时：在线机组、在线管制、自己那架和它的航迹
 * - `useRouteLayer`   航路：面板推来的点、已提交的计划、航路网上点亮的那几段
 * - `useWeatherLayer` 降水瓦片：开关、偏好、刷新、失败
 * - `useChartPins`    本次飞行的钉住航图，这里建一份，provide 给钉板和列表
 * - `MapModeBar.vue`  左上的模式条：机组、管制、天气、钉板
 * - `MapToolbar.vue`  模式条下面一列：IFR 高 / 低空、图层、3D、定位到我
 * - `MapPinboard.vue` 底部的钉板，平板和桌面上、钉板开着时
 * - `ChartPins.vue`   全部航图列表：钉板的列表按钮、手机上的钉板按钮打开
 * - `ChartViewer.vue` 唯一的航图查看器，按 `openChart` 渲染
 *
 * 缩放和指北针在右上，署名下面（RouteMap）。
 *
 * 横向依赖有两条。一条是航路网：登记处开关它，航路层要在它变了之后重算高亮。所以这
 * 份 ref 由这里持有，两边都拿到它，登记处在原来调 `refreshHighlight()` 的地方调
 * `onAirwaysChange`。
 *
 * 另一条是「不使用受限汇编」（`lib/naip.ts`）。它一变，图上每一层 can-db 数据都是
 * 按旧值取的，得一起作废、一起重取 —— 只重取一部分，图上就同时画着两个级别的资
 * 料，看起来完全正常。所以代号 `aip.gen` 和唯一那个 `watch(hideNaip)` 都在这里：
 * 登记处、地面、计划三处各管自己那一半，号只有一个。
 *
 * 外壳排布读 `--shell-mode`：挂载时读一次，之后跟着 panel:layout 的 `mode` 走（面
 * 板跨断点时会报一次）。不写 `matchMedia`。
 *
 * 仍然不能松的那一条：**绝不服务端渲染 MapLibre。** 它在模块顶层就摸 `window`。
 * 所以 RouteMap 用 `defineAsyncComponent` 引，并且用 `mounted` 守住 —— 改成静态
 * import、或者去掉那个 `v-if`，每一个页面都会 500。
 *
 * 代价照旧：MapLibre 那个 chunk 每一页都要加载，这是为「地图是主体」付的钱。
 */
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";
import type { FeatureCollection } from "geojson";
import MapModeBar, {
  type MapModeBarText,
  type ModeToggle,
} from "@/components/map/MapModeBar.vue";
import MapToolbar, {
  type MapToolbarText,
} from "@/components/map/MapToolbar.vue";
import MapPinboard, {
  type MapPinboardText,
} from "@/components/map/MapPinboard.vue";
import ChartPins from "@/components/map/ChartPins.vue";
import ChartViewer from "@/components/ChartViewer.vue";
import AtcDetails, {
  type AtcDetailsText,
} from "@/components/map/AtcDetails.vue";
import PilotDetails, {
  type PilotDetailsText,
} from "@/components/map/PilotDetails.vue";
import { useLayerNotice, type LayerId } from "@/components/map/useLayerNotice";
import {
  useChartLayers,
  type AipGeneration,
  type ChartLayerToggle,
  type LayerToggle,
  type Viewport,
} from "@/components/map/useChartLayers";
import { useGroundLayer } from "@/components/map/useGroundLayer";
import {
  useTrafficLayer,
  type MapSelection,
} from "@/components/map/useTrafficLayer";
import { hasPosition } from "@/lib/datafeed";
import { useRouteLayer } from "@/components/map/useRouteLayer";
import { useWeatherLayer } from "@/components/map/useWeatherLayer";
import { CHART_PINS_KEY, useChartPins } from "@/components/map/useChartPins";
import {
  DEFAULT_PREFS,
  readPrefs,
  writePrefs,
  type LayerPrefs,
} from "@/lib/mapPrefs";
import { hideNaip } from "@/lib/naip";
import { subscribePanelLayout } from "@/lib/mapBus";
import {
  mapPaddingFor,
  parseShellMode,
  type MapPadding,
  type ShellMode,
} from "@/lib/panelLayout";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
  /** 自己的 CAN ID。没登录是 null。见 useTrafficLayer：按 CID 认自己。 */
  cid: string | null;
  /** 航行资料库级别。航图列表和钉板的空状态按它说话。 */
  aipAccess: number;
  /** 航图列表和查看器要的那几本词典（AppLayout 挑好）。 */
  chartMessages: Record<string, unknown>;
  /** 十个图层开关的文案，已翻译。 */
  layerLabels: Record<LayerToggle, string>;
  /** 图层相关的几句话，已翻译。`planOnMap` 带 `{from}` / `{to}`，`layerFailed` 带 `{layer}`。 */
  t: {
    denied: string;
    emptyNavaids: string;
    emptyGeneric: string;
    planOnMap: string;
    layersMenu: string;
    layerFailed: string;
    retry: string;
    locate: string;
    /** 「3D」按钮，和倾斜时航线剖面的那句说明。 */
    view3d: string;
    view3dHint: string;
    /** IFR 高空 / 低空两张航图的全名。 */
    chartHigh: string;
    chartLow: string;
    /** 降水图例两端：小雨、大雨。 */
    weatherLight: string;
    weatherHeavy: string;
    /** 模式条：整条的名字、天气、钉板（机组、管制用 layerLabels）。 */
    mode: { label: string; weather: string; pinboard: string };
    /** 工具栏：整列的名字、HIGH / LOW、切换那句（带 `{current}`、`{next}`）。 */
    toolbar: { label: string; high: string; low: string; chartSwitch: string };
    /** 底部钉板。 */
    pinboard: MapPinboardText;
    /** 管制席位详情卡的文案。 */
    atc: AtcDetailsText;
    /** 飞机详情卡的文案。 */
    pilot: PilotDetailsText;
  };
  /** 地图整个起不来时那两句，转交给 RouteMap。 */
  failureText: { init: string; webgl: string };
}>();

/** 见文件顶上。`mounted` 之前一律不渲染 RouteMap。 */
const mounted = ref(false);

const RouteMap = defineAsyncComponent({
  loader: () => import("@/components/map/RouteMap.vue"),
  // chunk 拉不下来时说话。默认行为是安静地什么都不渲染 —— 那和「地图是空的」在
  // 屏幕上长得一模一样。
  onError(error) {
    console.error("[efb] 地图组件加载失败:", error);
  },
});

const prefs: LayerPrefs = { ...DEFAULT_PREFS };
const notice = useLayerNotice(props.t.denied);
/* `shallowRef`：航路网是几万条航段的要素集合，一律整份换掉（高亮不改它，改的是样式，
   见 `useRouteLayer` 的 `refreshHighlight`），深层代理只是白白包一遍。 */
const airways = shallowRef<FeatureCollection | null>(null);
/** 见文件顶上：「不使用受限汇编」每变一次加一，各层取数回来时对号。 */
const aip: AipGeneration = { gen: 0 };
/** 最近一次视野。换级别时地面要按它重取，而地面层自己不记视野。 */
let lastViewport: Viewport | null = null;

const route = useRouteLayer({
  airways,
  text: { label: props.label, planOnMap: props.t.planOnMap },
});
const chart = useChartLayers({
  airways,
  notice,
  prefs,
  aip,
  text: {
    emptyNavaids: props.t.emptyNavaids,
    emptyGeneric: props.t.emptyGeneric,
  },
  onAirwaysChange: route.refreshHighlight,
});
const groundLayer = useGroundLayer({ aip });
const live = useTrafficLayer({
  cid: props.cid,
  prefs,
  notice,
});

const weather = useWeatherLayer({ prefs, notice });
const { showWeather, weatherBucket } = weather;

/* 模板里只有顶层的 ref 会自动解包，所以把要用的拆出来。 */
const { points, markers, focus, label, cruiseFt, highlightedLegs, litLegs } =
  route;

/**
 * 倾斜视角。按钮改它，地图倾斜过门槛时（手势也算）经 `view3d` 事件写回来 —— 地图
 * 的 pitch 是真相，这个 ref 只是它的镜像加一个请求。不存偏好：打开 EFB 默认俯视。
 */
const view3d = ref(false);
const profileShown = computed(
  () => cruiseFt.value != null && points.value.length > 1,
);

/* ------------------------------------------------------------ 外壳排布 */

/** 挂载前是 null：服务端不知道排布，钉板也就不渲染、不取数。 */
const shellMode = ref<ShellMode | null>(null);
const phone = computed(() => shellMode.value === "phone");

function readShellMode(): ShellMode {
  return parseShellMode(
    getComputedStyle(document.documentElement).getPropertyValue("--shell-mode"),
  );
}

/* ------------------------------------------------------------ 钉板与航图列表 */

/** 钉板开关（偏好）。只管平板和桌面；手机上钉板按钮开列表。 */
const pinboardOn = ref(DEFAULT_PREFS.pinboard);
const barVisible = computed(
  () =>
    mounted.value &&
    pinboardOn.value &&
    shellMode.value !== null &&
    shellMode.value !== "phone",
);

/** 全部航图列表。 */
const listOpen = ref(false);
/** 打开列表的那个按钮（钉板的列表按钮，或手机上的钉板按钮）。关掉时焦点回去。 */
let listOpener: HTMLElement | null = null;

/** 本次飞行的钉住航图。钉板露着或列表开着才取数（见 useChartPins.ts）。 */
const pins = useChartPins({
  aipAccess: props.aipAccess,
  active: computed(() => barVisible.value || listOpen.value),
});
provide(CHART_PINS_KEY, pins);
const { openChart } = pins;

function openList() {
  listOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  listOpen.value = true;
}

function closeList() {
  listOpen.value = false;
  const target = listOpener;
  listOpener = null;
  if (target?.isConnected) target.focus();
}

function toggleList() {
  if (listOpen.value) closeList();
  else openList();
}

const { shownFixes, airports, runways, navaids, firs, mora, airspaces } = chart;
const ifrChart = chart.chart;
const { ground, groundAttribution } = groundLayer;
const {
  traffic,
  atc,
  atcAreas,
  atcLabels,
  selected,
  selectedPilot,
  own,
  ownTrack,
  atcCount,
  ownAt,
} = live;

/** 点地图：点中席位或飞机就换成它，点在空处就收起详情卡。 */
function onSelect(next: MapSelection | null) {
  live.selection.value = next;
}

/** 飞机详情卡上的「在地图上居中」。每次造新对象，理由见 `locateTarget`。 */
function locatePilot() {
  const p = selectedPilot.value;
  if (p && hasPosition(p)) {
    focus.value = { kind: "point", lat: p.latitude!, lon: p.longitude! };
  }
}
const noticeLine = notice.notice;
const failedLayer = notice.failure;

/** 实时和降水的失败挂在模式条上，其余的在工具栏的图层菜单里。 */
const modeFailure = computed<"live" | "weather" | null>(() =>
  failedLayer.value === "live" || failedLayer.value === "weather"
    ? failedLayer.value
    : null,
);

const modeState = computed<Record<ModeToggle, boolean>>(() => ({
  traffic: live.showTraffic.value,
  atcLive: live.showAtc.value,
  weather: showWeather.value,
  pinboard: pinboardOn.value,
}));

const staticState = computed<Record<ChartLayerToggle, boolean>>(() => ({
  airways: chart.showAirways.value,
  firs: chart.showFirs.value,
  navaids: chart.showNavaids.value,
  mora: chart.showMora.value,
  ctr: chart.showCtr.value,
  app: chart.showApp.value,
  restricted: chart.showRestricted.value,
}));

const busy = computed(() => ({
  airways: chart.airwayBusy.value,
  other: chart.layerBusy.value,
}));

const ownButton = computed(() =>
  ownAt.value ? { callsign: ownAt.value.callsign } : null,
);

const modeText: MapModeBarText = {
  label: props.t.mode.label,
  traffic: props.layerLabels.traffic,
  atc: props.layerLabels.atcLive,
  weather: props.t.mode.weather,
  pinboard: props.t.mode.pinboard,
  weatherLight: props.t.weatherLight,
  weatherHeavy: props.t.weatherHeavy,
  layerFailed: props.t.layerFailed,
  retry: props.t.retry,
};

const toolbarText: MapToolbarText = {
  label: props.t.toolbar.label,
  layers: props.t.layersMenu,
  layerFailed: props.t.layerFailed,
  retry: props.t.retry,
  view3d: props.t.view3d,
  locate: props.t.locate,
  high: props.t.toolbar.high,
  low: props.t.toolbar.low,
  chartHigh: props.t.chartHigh,
  chartLow: props.t.chartLow,
  chartSwitch: props.t.toolbar.chartSwitch,
};

/**
 * 面板盖住了哪一块。两处用：交给 RouteMap 做 `setPadding`，以及写成 CSS 变量，
 * 让压在地图上的控件（`.map-overlay`、MapLibre 的四个控件角）跟着可见区走。
 */
const padding = ref<MapPadding>({ top: 0, right: 0, bottom: 0, left: 0 });
const padStyle = computed(() => ({
  "--map-pad-top": `${padding.value.top}px`,
  "--map-pad-right": `${padding.value.right}px`,
  "--map-pad-bottom": `${padding.value.bottom}px`,
  "--map-pad-left": `${padding.value.left}px`,
}));
let unsubscribeLayout: (() => void) | null = null;

/** 视野变了：静态层按缩放补数据，地面层按视野补机场。两者互不相干。 */
function onViewport(v: Viewport) {
  lastViewport = v;
  chart.onViewport(v);
  void groundLayer.loadGroundFor(v);
}

function onToggle(id: LayerToggle) {
  switch (id) {
    case "airways":
      void chart.toggleAirways();
      return;
    case "firs":
      void chart.toggleFirs();
      return;
    case "navaids":
      void chart.toggleNavaids();
      return;
    case "mora":
      void chart.toggleMora();
      return;
    case "traffic":
      void live.toggleLive("traffic");
      return;
    case "atcLive":
      void live.toggleLive("atc");
      return;
    case "weather":
      weather.toggleWeather();
      return;
    default:
      void chart.toggleAirspace(id);
  }
}

/** 模式条。钉板在手机上开列表，在平板和桌面上开关底部那条栏（存偏好）。 */
function onMode(id: ModeToggle) {
  if (id !== "pinboard") {
    onToggle(id);
    return;
  }
  if (phone.value) {
    toggleList();
    return;
  }
  pinboardOn.value = !pinboardOn.value;
  prefs.pinboard = pinboardOn.value;
  writePrefs(prefs);
  // 列表是从栏上开的；栏收起来，列表一起收。
  if (!pinboardOn.value) listOpen.value = false;
}

function onRetry(id: LayerId) {
  if (id === "live") void live.refreshLive();
  else if (id === "weather") weather.retry();
  else chart.retry(id);
}

/**
 * 「定位到我」。**每次都是一个新对象**：RouteMap 按引用判断焦点变没变（否则实时数
 * 据每 30 秒会把镜头拽回来一次），连点两次要都生效。
 */
function locateOwn() {
  const target = live.locateTarget();
  if (target) focus.value = target;
}

/**
 * 「不使用受限汇编」变了（设置页，或另一个标签页）。先加号，路上那些按旧值取的请
 * 求回来时就不会再进缓存或上图；再让三处各自作废、重取开着的那几层。情报区边界不
 * 来自 can-db，不动。
 */
watch(hideNaip, () => {
  aip.gen++;
  chart.reloadAip();
  groundLayer.reloadAip(lastViewport);
  route.reloadPlan();
});

onMounted(() => {
  mounted.value = true;
  shellMode.value = readShellMode();
  unsubscribeLayout = subscribePanelLayout((layout) => {
    shellMode.value = layout.mode;
    padding.value = mapPaddingFor(layout, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  });
  // 按偏好把图层打开 —— 这是「打开就看到航图」的那一步。不 await：地图不该等航路网
  // 下载完才出现。
  const saved = readPrefs();
  Object.assign(prefs, saved);
  pinboardOn.value = saved.pinboard;
  chart.restore(saved);
  live.start(saved);
  weather.restore(saved);
  route.start();
});

onBeforeUnmount(() => {
  // 这块地图是 `transition:persist` 的，一般走不到这里；真走到了而定时器和监听器
  // 还活着，就是一个谁也看不见的泄漏。
  route.stop();
  live.stop();
  unsubscribeLayout?.();
});
</script>

<template>
  <section class="map-stage" :style="padStyle" :aria-label="label">
    <!-- `points` 为空也照样渲染：空点集只画底图，不会抛。 -->
    <RouteMap
      v-if="mounted"
      :points="points"
      :markers="markers"
      :focus="focus"
      :padding="padding"
      :airways="airways"
      :airway-fixes="shownFixes"
      :airports="airports"
      :runways="runways"
      :highlighted-legs="highlightedLegs"
      :lit-legs="litLegs"
      :ground="ground"
      :extra-attribution="groundAttribution"
      :navaids="navaids"
      :firs="firs"
      :mora="mora"
      :traffic="traffic"
      :atc="atc"
      :atc-areas="atcAreas"
      :atc-labels="atcLabels"
      :own="own"
      :own-track="ownTrack"
      :airspaces="airspaces"
      :cruise-ft="cruiseFt"
      :view3d="view3d"
      :weather="showWeather"
      :weather-bucket="weatherBucket"
      :label="label"
      :failure-text="failureText"
      :firs-label="layerLabels.firs"
      class="h-full"
      @viewport="onViewport"
      @select="onSelect"
      @view3d="view3d = $event"
      @weather-tile="weather.noteTile($event)"
    />
    <!-- 水合之前的占位：没有它，首屏这一整块是空的，等 JS 到了才突然出现地图。 -->
    <div v-else class="surface-grid h-full"></div>

    <div class="map-overlay">
      <!-- 「这一层没有数据」/「你没有航行资料库权限」。模式条下面居中。 -->
      <p
        v-if="noticeLine"
        class="map-notice glass"
        :data-notice="noticeLine.layer"
      >
        {{ noticeLine.text }}
      </p>
      <!-- 剖面是按巡航高度估算的，不是性能计算，也不含程序高度限制。画出来就要说。 -->
      <p v-else-if="view3d && profileShown" class="map-notice glass">
        {{ t.view3dHint }}
      </p>

      <div class="map-chrome">
        <MapModeBar
          :on="modeState"
          :atc-count="atcCount"
          :phone="phone"
          :list-open="listOpen"
          :failure="modeFailure"
          :text="modeText"
          @toggle="onMode"
          @retry="onRetry"
        />
        <MapToolbar
          :labels="layerLabels"
          :on="staticState"
          :chart="ifrChart"
          :busy="busy"
          :failure="failedLayer"
          :view3d="view3d"
          :own="ownButton"
          :phone="phone"
          :text="toolbarText"
          @toggle="onToggle"
          @chart="chart.setChart"
          @retry="onRetry"
          @view3d="view3d = !view3d"
          @locate="locateOwn"
        />
      </div>

      <MapPinboard
        v-if="barVisible"
        :text="t.pinboard"
        :list-open="listOpen"
        @list="toggleList"
      />

      <AtcDetails
        v-if="selected"
        :station="selected.station"
        :is-atis="selected.isAtis"
        :text="t.atc"
        @close="onSelect(null)"
      />
      <PilotDetails
        v-else-if="selectedPilot"
        :pilot="selectedPilot"
        :text="t.pilot"
        @close="onSelect(null)"
        @locate="locatePilot"
      />
      <ChartPins
        :open="listOpen"
        :messages="chartMessages"
        @close="closeList"
      />
    </div>

    <!-- 唯一的查看器。换一张时是同一个实例换 `chart`（它 watch `chart.id` 重载）。 -->
    <ChartViewer
      v-if="openChart"
      :chart="openChart"
      :messages="chartMessages"
      @close="pins.close()"
    />
  </section>
</template>
```

- [ ] **Step 2: Delete `MapControls.vue`**

Run: `git rm src/components/map/MapControls.vue`
Then: `grep -rn "MapControls" src` — Expected: no output.

- [ ] **Step 3: Pass the new strings in `src/layouts/AppLayout.astro`**

In the `t={{ … }}` object of `<MapStage>`:

1. Delete these two lines:

```astro
      chart: t("map.chart.label"),
```

```astro
      charts: t("airports.charts.pins.button"),
```

2. After `weatherHeavy: t("map.weather.heavy"),` insert:

```astro
      mode: {
        label: t("map.mode.label"),
        weather: t("map.mode.weather"),
        pinboard: t("map.mode.pinboard"),
      },
      toolbar: {
        label: t("map.toolbar.label"),
        high: t("map.toolbar.high"),
        low: t("map.toolbar.low"),
        chartSwitch: t("map.toolbar.chartSwitch"),
      },
      pinboard: {
        label: t("map.pinboard.label"),
        list: t("map.pinboard.list"),
        noPlan: t("map.pinboard.noPlan"),
        noPlanAction: t("airports.charts.pins.noPlanAction"),
        planFailed: t("map.pinboard.planFailed"),
        noPins: t("map.pinboard.noPins"),
        unpin: t("map.pinboard.unpin"),
        auto: t("airports.charts.pins.auto"),
        retry: t("common.retry"),
        loading: t("common.loading"),
        chip: {
          loading: t("map.pinboard.chip.loading"),
          failed: t("map.pinboard.chip.failed"),
          unconfigured: t("map.pinboard.chip.unconfigured"),
          denied: t("map.pinboard.chip.denied"),
          needsAccess: t("map.pinboard.chip.needsAccess"),
          hidden: t("map.pinboard.chip.hidden"),
          empty: t("map.pinboard.chip.empty"),
        },
      },
```

- [ ] **Step 4: Zoom and compass to the top right**

In `src/components/map/RouteMap.vue`, replace

```ts
    // 指北针带倾斜示意：地图转过或倾斜过之后，点它回到正北俯视。
    map.addControl(
      new NavigationControl({ showCompass: true, visualizePitch: true }),
      "top-left",
    );
```

with

```ts
    // 指北针带倾斜示意：地图转过或倾斜过之后，点它回到正北俯视。右上角、署名下面：
    // 左上是模式条和工具栏（MapStage）。
    map.addControl(
      new NavigationControl({ showCompass: true, visualizePitch: true }),
      "top-right",
    );
```

In `src/components/map/attribution.ts`, replace

```ts
    map.addControl(control, "top-right");
  }
```

with

```ts
    map.addControl(control, "top-right");
    // 右上角是署名在上、缩放和指北针在下。MapLibre 把上方两个角的新控件接在末尾，
    // 署名每次重挂都会掉到缩放下面，所以挂完挪回第一个。
    const corner = map
      .getContainer()
      .querySelector(".maplibregl-ctrl-top-right");
    const attrib = corner?.querySelector(".maplibregl-ctrl-attrib");
    if (corner && attrib && corner.firstElementChild !== attrib) {
      corner.prepend(attrib);
    }
  }
```

- [ ] **Step 5: CSS clean-up in `src/styles/globals.css`**

1. Delete these rule blocks, each with the comment directly above it where there is one:
   - `.map-locate` and `.map-locate:hover` (comment `/* 「定位到我」。放在缩放控件下面…`)
   - `.map-layers` (comment `/* 图层菜单和失败提示，从可见区左下角往上长。 */`)
   - `.map-layer-trigger` (comment `/* DOM 里菜单在按钮后面（键盘顺序）…`)
   - `.map-layer-menu`
   - `.map-chart-seg` (comment `/* IFR 高空 / 低空：航路开关后面的一对单选…`), `.map-chart-opt`, `.map-chart-opt:hover:not(:disabled)`, `.map-chart-opt.is-on`
   - `.map-3d-toggle` (comment `/* 「3D」：在图层按钮下面…`), `.map-3d-toggle.is-on`
   - `.map-charts-trigger` (comment `/* 「航图」按钮：在「3D」下面…`), `.map-charts-trigger.is-on`

   Keep `.map-layer-btn` (and its `:hover`, `.is-on`, `:disabled`), `.map-layer-count`, `.map-weather-legend`, `.map-weather-ramp`, `.map-layer-failure`.

2. Replace the `.map-notice` comment and `top`:

```css
/* 「这一层没有数据」/「没有航行资料库权限」。模式条下面，可见区居中。 */
.map-notice {
  position: absolute;
  top: 3.25rem;
```

(rest of the rule unchanged).

3. Replace the `.map-atc-details` comment and rule head so the card clears the zoom column:

```css
/* 管制席位详情（`AtcDetails.vue`）。贴在可见区右上，让开右上角的署名和缩放那一列。 */
.map-atc-details {
  position: absolute;
  top: 2.75rem;
  right: 3rem;
  width: min(20rem, calc(100% - 3.5rem));
```

(rest of the rule unchanged).

4. Replace the `.map-corner-nw` rule:

```css
.map-corner-nw {
  /* 左上角让给模式条和工具栏：放在模式条下面、工具栏右边。 */
  top: calc(var(--map-pad-top, 0px) + 3.25rem);
  left: calc(var(--map-pad-left, 0px) + 4rem);
}
```

5. Replace the comment above `.map-chart-pins`:

```css
/* 全部航图列表（`ChartPins.vue`）。从可见区左下角往上长，开着时盖住左边的控件，
   自己带关闭按钮和 Esc。 */
```

Then: `grep -nE "map-locate|map-layers\b|map-layer-trigger|map-layer-menu|map-chart-seg|map-chart-opt|map-3d-toggle|map-charts-trigger" src -r` — Expected: no output.

- [ ] **Step 6: Verify**

Run: `bunx prettier --write src/components/map/MapStage.vue src/layouts/AppLayout.astro src/components/map/RouteMap.vue src/components/map/attribution.ts src/styles/globals.css && bun run typecheck && bun run check:i18n && bun run lint && bun run build`
Expected: all pass; build succeeds.

- [ ] **Step 7: Commit**

```bash
git -c commit.gpgsign=false commit -m "Map: mode bar, toolbar and pinboard replace MapControls; zoom to top right

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/map/MapStage.vue src/components/map/MapControls.vue src/layouts/AppLayout.astro src/components/map/RouteMap.vue src/components/map/attribution.ts src/styles/globals.css
```

---

### Task 7: The bar's height — map padding, viewer bottom, list and corner

**Files:**
- Modify: `src/components/map/MapStage.vue` (bar height, padding, CSS variables)
- Modify: `src/components/ChartViewer.vue` (header comment only)
- Modify: `src/styles/globals.css` (`.chart-viewer-beside`, `.map-chart-pins`, `.map-corner-se`)

**Interfaces:**
- Consumes: `pinboardReserve`, `withPinboard`, `viewerBottom` (Task 1); `MapPinboard` `height` emit (Task 5); `barVisible`, `padding` in `MapStage` (Task 6).
- Produces: CSS variable `--map-pinboard-reserve` on `.map-stage` (px, `0px` without the bar); CSS variable `--chart-viewer-bottom` on `document.documentElement` while the bar is visible, removed otherwise. `ChartViewer` keeps reloading on `chart.id` change through its existing `watch(() => props.chart.id, …)`; no code change there.

- [ ] **Step 1: `MapStage.vue` — reserve, padding and viewer bottom**

1. Add the import after the `@/lib/panelLayout` import:

```ts
import { pinboardReserve, viewerBottom, withPinboard } from "@/lib/pinboard";
```

2. Replace the `padding` / `padStyle` block

```ts
const padding = ref<MapPadding>({ top: 0, right: 0, bottom: 0, left: 0 });
const padStyle = computed(() => ({
  "--map-pad-top": `${padding.value.top}px`,
  "--map-pad-right": `${padding.value.right}px`,
  "--map-pad-bottom": `${padding.value.bottom}px`,
  "--map-pad-left": `${padding.value.left}px`,
}));
```

with

```ts
const padding = ref<MapPadding>({ top: 0, right: 0, bottom: 0, left: 0 });

/**
 * 钉板占掉的高度（`MapPinboard` 经 `height` 报）。三处用：地图内边距的底边再让一
 * 截（框住航路、居中都落在栏上面）；`--map-pinboard-reserve` 给列表和右下角坐标让
 * 位；`--chart-viewer-bottom` 让贴在旁边的查看器停在栏上面。`--map-pad-*` 不含它：
 * 栏自己就贴在 `--map-pad-bottom` 上。
 */
const pinboardHeight = ref(0);
const reserve = computed(() =>
  barVisible.value ? pinboardReserve(pinboardHeight.value) : 0,
);
const mapPadding = computed(() => withPinboard(padding.value, reserve.value));

const padStyle = computed(() => ({
  "--map-pad-top": `${padding.value.top}px`,
  "--map-pad-right": `${padding.value.right}px`,
  "--map-pad-bottom": `${padding.value.bottom}px`,
  "--map-pad-left": `${padding.value.left}px`,
  "--map-pinboard-reserve": `${reserve.value}px`,
}));

/** 查看器 Teleport 到 body 下，读不到 `.map-stage` 上的变量，所以写在根元素上。 */
function applyViewerBottom(bottom: number | null) {
  const root = document.documentElement.style;
  if (bottom === null) root.removeProperty("--chart-viewer-bottom");
  else root.setProperty("--chart-viewer-bottom", `${bottom}px`);
}
watch(() => viewerBottom(padding.value, reserve.value), applyViewerBottom);
```

3. In `onBeforeUnmount`, after `unsubscribeLayout?.();` add:

```ts
  applyViewerBottom(null);
```

4. In the template, change the `RouteMap` binding `:padding="padding"` to:

```vue
      :padding="mapPadding"
```

5. Replace the `MapPinboard` element with:

```vue
      <MapPinboard
        v-if="barVisible"
        :text="t.pinboard"
        :list-open="listOpen"
        @list="toggleList"
        @height="pinboardHeight = $event"
      />
```

- [ ] **Step 2: `ChartViewer.vue` — document the two behaviours it already has or gets from CSS**

In the header comment of `src/components/ChartViewer.vue`, replace the paragraph

```ts
 * 平板和桌面上贴在面板右边，盖住地图；手机上盖满全屏。位置由 `viewerPlacement`
 * 按面板此刻的矩形算（mapBus 的 panel:layout）。盖满时是对话框，贴在旁边时只是
 * 一块区域 —— 面板还能继续选别的航图。
```

with

```ts
 * 平板和桌面上贴在面板右边，盖住地图；手机上盖满全屏。位置由 `viewerPlacement`
 * 按面板此刻的矩形算（mapBus 的 panel:layout）。盖满时是对话框，贴在旁边时只是
 * 一块区域 —— 面板还能继续选别的航图。贴在旁边时底边是 `--chart-viewer-bottom`
 * （MapStage 在底部钉板露着时写在根元素上），没有就是 `--shell-inset`。
 *
 * `chart` 换了就重载（`watch(() => props.chart.id)`）：地图上只有一个查看器，钉板
 * 上点另一张是换 `chart`，不是重开。
```

- [ ] **Step 3: CSS**

In `src/styles/globals.css`:

1. In `.chart-viewer-beside`, replace `bottom: var(--shell-inset);` with:

```css
  bottom: var(--chart-viewer-bottom, var(--shell-inset));
```

2. In `.map-chart-pins`, replace

```css
  bottom: 0.5rem;
```

and

```css
  max-height: calc(100% - 1rem);
```

with

```css
  bottom: calc(0.5rem + var(--map-pinboard-reserve, 0px));
```

and

```css
  max-height: calc(100% - 1rem - var(--map-pinboard-reserve, 0px));
```

3. Replace the `.map-corner-se` rule with:

```css
.map-corner-se {
  right: calc(var(--map-pad-right, 0px) + 0.5rem);
  /* 让开右下角的比例尺（约 1.5rem 高加 10px 内边距），钉板露着时再让到栏上面。 */
  bottom: calc(
    var(--map-pad-bottom, 0px) +
      max(2.5rem, var(--map-pinboard-reserve, 0px) + 0.25rem)
  );
}
```

- [ ] **Step 4: Verify**

Run: `bun test src/lib/pinboard.test.ts`
Expected: PASS.

Run: `bunx prettier --write src/components/map/MapStage.vue src/components/ChartViewer.vue src/styles/globals.css && bun run typecheck && bun run check:i18n && bun run lint && bun run build`
Expected: all pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false commit -m "Map: pinboard height in map padding, viewer bottom and list offset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- src/components/map/MapStage.vue src/components/ChartViewer.vue src/styles/globals.css
```

---

### Task 8: AGENTS.md

**Files:**
- Modify: `AGENTS.md` (`CLAUDE.md` is a symlink to it; edit `AGENTS.md`)

- [ ] **Step 1: Add a map controls subsection**

Insert immediately before the heading `### 面板里的多列排布按容器判，不按视口判`:

```markdown
### 地图上的控件（`MapModeBar` + `MapToolbar` + `MapPinboard`）

全部压在可见区里（`--map-pad-*`），由 `MapStage` 摆放，只收翻好的字符串、只往外发事件。

- 模式条，可见区左上：机组、管制、天气、钉板四个带字的开关（`aria-pressed`）。管制带
  在线席位数。天气开着时旁边是小雨 → 大雨图例。实时和降水没取到时，提示和重试挂在模式
  条下面。
- 工具栏，模式条下面一列：HIGH / LOW IFR（换 `chart`）、图层、3D、定位到我（自己连着
  线时才有）。图层向右弹出静态那几层：航路、情报区、导航台、MORA、区域、进近、限制区。
  哪一层没取到，提示和重试在菜单里那一层下面，菜单关着时图层按钮挂警示点。菜单：
  `aria-expanded` / `aria-controls`，打开时焦点到第一项，Esc 关并回到按钮，点外面关。
- 手机上模式条只有图标，文字在 `aria-label` 和 `title`；3D 收进图层菜单；没有钉板，
  钉板按钮打开全部航图列表。手机判断读 `--shell-mode`：挂载时读一次，之后跟着
  panel:layout 的 `mode`。
- 提示（`useLayerNotice`）在模式条下面，可见区居中。
- 缩放和指北针（MapLibre `NavigationControl`）在右上，署名下面。署名每次重挂后
  `attribution.ts` 把它挪回右上角第一个。
- 钉板，可见区底部整宽（平板和桌面，钉板开着时，偏好 `pinboard`，默认开）。右端让给
  比例尺。它的高度加进地图底边内边距（`withPinboard`），框住航路和居中都在栏上面；
  `--map-pinboard-reserve` 给列表和右下角坐标让位；`--chart-viewer-bottom`（写在根元
  素上，查看器在 body 下）让贴在旁边的查看器停在栏上面。
```

- [ ] **Step 2: Replace the chart pins section**

Replace the whole subsection from the heading `### 航图钉住（\`lib/chartPins.ts\` + \`map/ChartPins.vue\`）` up to (not including) `## 导航是一份数据` with:

```markdown
### 航图钉住（`lib/chartPins.ts` + `map/useChartPins.ts` + `lib/pinboard.ts`）

- 状态在 `useChartPins`：计划、三个机场各自的索引、程序选择、本机存储、查看器里开着的
  那一张。`MapStage` 建一份，provide 给钉板（`MapPinboard.vue`）和全部航图列表
  （`ChartPins.vue`）。
- 钉板：最左是列表按钮；然后按计划顺序（起飞、落地、备降）一个机场一组，ICAO 分隔加
  钉住的航图标签。标签名至多两行，顶上一道类别色条（STAR 绿、APP 橙、TAXI 蓝、SID 粉、
  REF 紫），自动钉住的带小点。点标签在查看器里打开；查看器开着时点另一个直接换，开着
  的那个高亮、`aria-current="true"`。右键、长按或菜单键弹出「取消钉住」。标签多了横向滚。
- 钉板是 `role="toolbar"`：一个 Tab 停点，左右方向键、Home、End 走，Enter 打开。
- 钉板上的状态：没有计划说一句加去 `/flightplan` 的链接；计划读不到说一句加重试；都没
  钉说「没有钉住的航图」。一个机场读取中，分隔处转圈；没取到或存储没接上，分隔变成警示
  牌加重试，别的机场照常；没权限、被「不使用受限汇编」藏起来、没有航图，牌子说一个词，
  完整的话在列表里。牌子是 `role="status"`。分组和牌子是 `lib/pinboard.ts` 的纯函数。
- 全部航图列表：每个机场钉住的在前，后面是折起来的全部航图。平板和桌面从钉板的列表按钮
  打开，在栏上面；手机上从模式条的钉板按钮打开。Esc 只在焦点在列表里时关它，关掉后焦点
  回到打开它的按钮。
- 取数：钉板第一次露出来、或列表第一次打开才取。钉板开着的平板和桌面上就是地图挂载时；
  手机上、钉板关着时，列表打开之前什么都不取。取过之后计划（`efb:plan-changed`）、
  「不使用受限汇编」变了重取（不在显示时只记一笔，下次显示再取）；程序选择、钉住变了只
  重读存储并重新合并。回来晚了的回应丢掉。三个机场各自的状态和重试，互不影响。
- 自动钉住：起飞、落地是 TAXI 里的 `机场图`、`停机位置图`，备降只有 `机场图`。选了程序
  （`lib/procedureSelection.ts`）时加上匹配的 SID、STAR、APP。
- SID / STAR：标签第一个数字前的字母是定位点，航图名括号里含它（子串）；选了跑道时跑道在
  `RWY` 后面那一串里。`AND` 会命中 `BKANDSASAN`，这是已知局限，自动钉住带「自动」标记，可取消。
- 进近：首字母定类型（I = ILS；R = RNP / RNAV 开头且不含 ILS；D、V = VOR；N = NDB；
  L = LOC），跑道完全一致，`-Y` / `-Z` 对 `RWY` 前的小写字母，标签不带变体时不查。
- 选了程序却没中：列表里说「没有匹配 {procedure} 的航图」，不安静地少一张。
- 存储：localStorage `efb:chart-pins:{DEP}-{ARR}`，`{ pinned, unpinned }`，元素是航图 id。
  结果 = 自动 + `pinned` − `unpinned`。改了发 `efb:chart-pins-changed`。读不出来当空的。
  索引里没有的 id 不显示。
- 机场详情的航图标签：这个机场在计划里时每行多一颗钉住按钮，写同一份存储；不在计划里没有。
- 同一个机场在计划里出现两次（起飞 = 落地，或备降重复其一）时，机场详情按第一个角色（起飞）算；
  列表和钉板每个角色一组。
- 钉住按钮的标签固定为「钉住 {航图名}」，状态由 `aria-pressed` 表达。
- 查看器只有一个，`MapStage` 按 `openChart` 渲染，换 `chart` 就重载。位置照 `viewerPlacement`
  （贴面板右边或盖满）。关掉后焦点回到打开它的那个控件。计划重取时它关上。
```

- [ ] **Step 3: Replace the remaining `MapControls.vue` references and old positions**

1. In `## 图层没有数据的时候必须说出来`, replace

```markdown
   的 `failure`，`MapControls.vue` 画它）。退回关的规矩不变 —— 开关要说真话；提示
```

with

```markdown
   的 `failure`：实时和降水由 `MapModeBar.vue` 画在模式条下面，其余由 `MapToolbar.vue`
   画在图层菜单里那一层下面）。退回关的规矩不变 —— 开关要说真话；提示
```

2. In the same section, replace

```markdown
`map.emptyLayer.*` 和 `map.denied`），由 `MapControls.vue` 渲染。两条规矩：
```

with

```markdown
`map.emptyLayer.*` 和 `map.denied`），由 `MapStage.vue` 画在模式条下面居中。两条规矩：
```

3. In `### 降水图层（\`useWeatherLayer\`）`, replace

```markdown
- 开着时署名加一行「Weather © OpenWeather」，图层菜单下出一条小雨 → 大雨图例。
```

with

```markdown
- 开着时署名加一行「Weather © OpenWeather」，模式条的天气按钮旁出一条小雨 → 大雨图例。
```

4. In `## 航图样式`, replace

```markdown
默认 `low`，`lib/ifrChart.ts`），在图层菜单航路开关后面。只取当前航图那一层
```

with

```markdown
默认 `low`，`lib/ifrChart.ts`），是工具栏第一颗 HIGH / LOW IFR 按钮。只取当前航图那一层
```

5. In `### 倾斜视角`, replace

```markdown
地图能倾斜，最大 70°：右键拖、Ctrl 拖、双指上下推，或者图层按钮下面的「3D」（倾到
```

with

```markdown
地图能倾斜，最大 70°：右键拖、Ctrl 拖、双指上下推，或者工具栏的「3D」（手机上在图层菜单里；倾到
```

Then: `grep -n "MapControls" AGENTS.md` — Expected: no output.

- [ ] **Step 4: Verify**

Run: `bunx prettier --check AGENTS.md || bunx prettier --write AGENTS.md`
Expected: formatted.

Run: `bun run lint`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git -c commit.gpgsign=false commit -m "AGENTS.md: map controls, pinboard and chart pins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- AGENTS.md
```

---

## Browser checks (by hand, needs a session with level 3 or higher)

- Desktop, tablet and phone layouts: mode bar, toolbar, zoom and compass under the attribution, notices below the mode bar.
- Switching charts from the bar with the viewer open: same viewer, new chart, open tab highlighted.
- Bar clear of the scale bar; fit-to-route and centring land above the bar; the beside viewer stops above the bar.
- Unpin from the bar by right click, long press and the context-menu key.
- Layers flyout and toolbar by keyboard: focus to first item, Esc back to the button, click outside closes. Bar arrow keys, Home, End, Enter.
- Pinboard off: no chart index request until the list is opened (phone too).
- One airport failing (block its index request): warning chip with retry, other airports keep tabs.
- Dark mode.

---

## Self-review

**Spec coverage**

| Spec item | Task |
|---|---|
| Top mode bar: Traffic, ATC (count badge), Weather (legend), Pinboard | 4 (component), 6 (mounted) |
| Left toolbar: HIGH/LOW IFR, layers flyout with static layers and per-layer failure/retry, 3D, locate me while connected | 4, 6 |
| Zoom and compass to top right, below attribution | 6 (RouteMap, attribution.ts) |
| Notices top centre below the mode bar | 6 (MapStage template, `.map-notice` top) |
| Pinboard bar: list button, ICAO separators in plan order, tabs, horizontal scroll | 5 |
| Tab: two-line name, category strip colour, auto dot, click opens, open tab highlighted, swap in open viewer, context menu / long press Unpin | 5 (`MapPinboard`, `CHART_STRIP_CLASS`), 1 (`STRIP_COLOUR`), 2 (`open` swaps `openChart`) |
| Bar states table (no plan, plan failed, no pins, airport loading, airport failed + retry, no access / hidden / no charts chips) | 1 (`airportChip`, `pinboardView`), 5 |
| Bar visible only when Pinboard on and shell not `phone` | 6 (`barVisible`) |
| Phone: icon-only mode bar with accessible names; 3D in flyout; Pinboard opens list | 4, 6 |
| Loading: first load when bar first visible or list first opened; plan/hideNaip refetch; procedures/pins re-read; late responses dropped | 2 (`useChartPins`), 6 (`active = barVisible \|\| listOpen`) |
| Chart viewer: one instance in MapStage from shared open chart; reloads on `chart` change; bottom edge `var(--chart-viewer-bottom, …)` | 2 (rendered in MapStage), 7 (CSS var, existing `watch(chart.id)` documented) |
| Map padding adds bar height | 7 (`withPinboard`, `mapPadding`) |
| `useChartPins.ts` new, created once by MapStage | 2 |
| `MapModeBar.vue`, `MapToolbar.vue`, `MapPinboard.vue` new | 4, 5 |
| `ChartPins.vue` becomes the full list reading `useChartPins` | 2, 6 (opened from bar / phone button) |
| `MapControls.vue` deleted | 6 |
| `RouteMap.vue` NavigationControl `top-right` | 6 |
| `lib/pinboard.ts` pure logic with tests | 1 |
| `lib/mapPrefs.ts` `pinboard: boolean` default true, old prefs | 1 |
| `AppLayout.astro` passes the new strings | 6 |
| `globals.css`: new rules; `.map-layers`, `.map-layer-*`, `.map-3d-toggle`, `.map-charts-trigger`, `.map-chart-pins` updated or removed | 4, 5 (new), 6 (removed), 7 (`.map-chart-pins`, viewer, corner) |
| Accessibility: mode bar `aria-pressed`; toolbar names and tooltips; flyout `aria-expanded`/`aria-controls`, focus, Esc, click outside; bar `role="toolbar"`, arrows, Enter, `aria-current`, chips `role="status"`; list Esc only inside and focus return | 4, 5, 2, 6 (`listOpener`) |
| Strings in four languages | 3 |
| Tests: `pinboard.test.ts` groups and chips; `mapPrefs.test.ts` default and old prefs; `chartPins.test.ts` unchanged | 1, 2 (run unchanged) |
| Gate: `bun run lint`, `bun run build` | every UI task (2, 4, 5, 6, 7), 8 |
| Browser checks | section above |
| AGENTS.md: map controls, chart pins section, MapControls references, zoom and compass position | 8 |

**Placeholder scan:** no TBD, TODO or "similar to" references; every code step carries the code.

**Type consistency:** `ChartPinsStore` members (`plan`, `groups`, `stored`, `openChart`, `emptyReason`, `emptyBody`, `load`, `retry`, `toggle`, `open`, `close`) match their uses in `ChartPins.vue`, `MapPinboard.vue` and `MapStage.vue`. `ChartPinGroup` is structurally a `PinSource`. `ModeToggle`, `MapModeBarText`, `MapToolbarText`, `MapPinboardText` are exported from their components and imported by `MapStage`. `AirportChip` keys match `t.pinboard.chip` in `AppLayout.astro` and the `pinboard.chip.*` JSON keys. `PINBOARD_GAP_PX` (8) matches `.map-pinboard { bottom: 0.5rem }`.
