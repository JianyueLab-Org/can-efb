# can-efb Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move can-efb onto a full-bleed map with a floating glass panel, move all six pages onto it, and clean up oversized files, empty/error states, accessibility, hydration, dead code and stale docs.

**Architecture:** `MapStage` (MapLibre, `transition:persist`) fills the viewport. `AppRail` floats on the left (a bottom tab bar under 768px). `FloatingPanel.astro` is static HTML holding each page's island; a small DOM controller (`lib/panelController.ts`) handles collapse, the phone bottom sheet, and announces the panel rectangle on `mapBus` (`panel:layout`). The map turns that rectangle into `map.setPadding` and CSS variables for its overlays. Every island request resolves to one `RequestState` and renders through `StateCard`.

**Tech Stack:** Astro 7 SSR (`@astrojs/node`), Vue 3.5 islands, Tailwind v4 (container queries), MapLibre GL 6, `@jianyuelab-org/can-ui` 0.3.5 (tokens, `Icon`, `EmptyState`, `Spinner`, `ThemeLangControls`, `can-ui/motion`), Bun (`bun test`).

**Spec:** docs/superpowers/specs/2026-09-25-efb-redesign-design.md

---

## Global Constraints

From the spec ("Constraints that stay"):

- No top header. Brand, ⌘K, nav, theme, language and account live in the rail.
- No Secret, no database credential. The browser calls only same-origin `/api/v1/*` (can-api) and `/api/db/*` (can-db). The session cookie is forwarded, never read for authority.
- The map persists across pages via `transition:persist`.
- Rail collapse state lives in `html[data-rail]`, set by `RailScript` before first paint.
- Files copied from can-web / can-radar (`i18n.ts`, icons, the upper part of `globals.css`, `geo.ts`, `atc.ts`, `traffic.ts`) are not edited here.
- Islands receive only the `efb` messages namespace.
- Honest states: no fake data; empty and failed are distinct; can-db 401/403 gets its own message.
- can-ui is not modified.

Added for this plan:

- Gate for every commit: `bun run lint && bun run build`. `lint` already runs `format:check`, `astro check`, vue-tsc, `check:i18n`, `check:style` and `bun test`. Run `bunx prettier --write <changed files>` before the gate.
- `bun` / `bunx` only. No npm, npx, yarn, pnpm.
- Commit with:
  ```bash
  perl -e 'alarm 40; exec @ARGV' git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```
  YubiKey signing may hang. If the command exits 142 (alarm), retry once with `git -c commit.gpgsign=false commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"` and say in the task report that the commit is unsigned.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Subjects are short Chinese sentences stating what changed, matching the existing history.
- New user-facing strings go into all four dictionaries (`language/zh-cn.json`, `zh-tw.json`, `en-us.json`, `ja-jp.json`) under `efb`. `check:i18n` fails if the four disagree.
- Code comments are Chinese and follow the surrounding style: explain why, name the failure mode.
- Breakpoints (768px, 1152px) are written only in `src/styles/globals.css`. JS reads `--shell-mode` / `--rail-auto`; Vue templates use CSS classes, not `md:` / `lg:` prefixes, for anything that changes with the shell.
- Scratch files go in `can-efb/.temp/` (already in `.gitignore`). Never `/tmp`. Delete them when the task ends.
- Work on branch `feat/efb-redesign`. Before Task 1: `git -C can-efb switch feat/efb-redesign`. The spec commit `29b690d` is its tip.
- Bun module cache: after editing a source file, if a test result looks stale, run `bun test` a second time before trusting a pass (AGENTS.md 〈命令〉).
- Dev server: `bun run dev` serves on :4324. Every page needs a can-api session cookie (AGENTS.md 〈命令〉, last section). The browser checks assume the instance is reachable under a `*.ceruleanavi.net` name with a valid session. Do not add a fake-login switch.

Line numbers in this plan refer to the files as they are at `29b690d` unless a task says otherwise. When a task edits several ranges in one file, apply the edits from the bottom of the file upwards so the numbers stay valid.

---

## File Structure

### Created

| Path | Responsibility |
| --- | --- |
| `src/lib/panelLayout.ts` | Shell mode parsing, effective rail state, panel rectangle → map padding. Pure. |
| `src/lib/panelLayout.test.ts` | Tests for the above. |
| `src/lib/sheet.ts` | Bottom-sheet snap offsets, release → snap, initial snap per panel width. Pure. |
| `src/lib/sheet.test.ts` | Tests for the above. |
| `src/lib/mapBus.test.ts` | Tests for the new `panel:layout`, `map:focus` and `map:plan` messages. |
| `src/lib/panelController.ts` | DOM behaviour of the floating panel: collapse, sheet drag, `panel:layout` announcements. |
| `src/lib/mapPrefs.ts` | Layer preference shape, defaults, localStorage read/write with legacy `airway` migration. Moved out of `MapSurface.vue` 162–248. |
| `src/lib/mapPrefs.test.ts` | Tests for the above. |
| `src/lib/routeGeometry.ts` | `RoutePoint`, `routeLines`, `pointFeatures`. Moved out of `RouteMap.vue` 121–135 and 345–431. |
| `src/lib/routeGeometry.test.ts` | Tests for the above. |
| `src/lib/requestState.ts` | `RequestState<T>`: request result → `data | empty | error | forbidden | loading`. |
| `src/lib/requestState.test.ts` | Tests for the above. |
| `src/lib/flightPlan.ts` | Flight plan types, `blankPlan`, `formatUtc`, `fillPlan`. Moved out of `FlightPlan.vue` 30–88 and 132–137. |
| `src/lib/flightPlan.test.ts` | Tests for the above. |
| `src/lib/routePreview.ts` | `shouldPreview`, `previewKey`, `resolveRoute` (can-db `/aip/resolve` → `RequestState<MapPoint[]>`). |
| `src/lib/routePreview.test.ts` | Tests for the above. |
| `src/lib/nav.test.ts` | Tests for `isCurrentPath` (moved from `SidebarNav.vue` 25–35 into `lib/nav.ts`). |
| `src/components/map/MapStage.vue` | Replaces `MapSurface.vue`. Wires the four layer composables, `MapControls` and `RouteMap`; turns `panel:layout` into padding. |
| `src/components/map/MapControls.vue` | Map overlay: layer menu, partial/notice lines, failed-layer notice with retry, locate button. |
| `src/components/map/useLayerNotice.ts` | Per-layer notice, session-level denial, failed-layer state. From `MapSurface.vue` 250–298. |
| `src/components/map/useChartLayers.ts` | Layer registry: airways, navaids, FIRs, MORA, three airspace layers, zoom-driven airports and runways. From `MapSurface.vue` 158–472 and 700–1124 minus live, ground and plan. |
| `src/components/map/useGroundLayer.ts` | Zoom-driven airport ground layer. From `MapSurface.vue` 428–437, 459–461, 853–965. |
| `src/components/map/useTrafficLayer.ts` | Traffic layer: online pilots, controllers, own aircraft, own track, 30s polling. From `MapSurface.vue` 473–698, 1026–1039. |
| `src/components/map/useRouteLayer.ts` | Route layer: panel-published points, filed plan, airway highlight, map focus. From `MapSurface.vue` 302–305, 444–451, 1125–1290. |
| `src/components/map/RouteMap.vue` | `src/components/RouteMap.vue` moved here; keeps map construction, sources, theme. |
| `src/components/map/basemap.ts` | Land and detail basemap loading. From `RouteMap.vue` 263–290, 689–747. |
| `src/components/map/attribution.ts` | Attribution control. From `RouteMap.vue` 472–517. |
| `src/components/map/camera.ts` | Focus, fit-to-points, padding. From `RouteMap.vue` 543–546, 644–687, plus `setPadding`. |
| `src/components/FloatingPanel.astro` | The glass panel: header, collapse button, sheet handle, page slot, Beian line. |
| `src/components/ui/StateCard.vue` | `empty | error | forbidden | loading` card; `error` carries retry. |
| `src/components/ui/PanelSection.vue` | Heading plus content. |
| `src/components/ui/Field.vue` | Label, hint, error, `aria-describedby` wiring for one input. |
| `src/components/ui/FieldGrid.vue` | One column, two columns when the panel is wide (container query). |
| `src/components/flightplan/FlightPlan.vue` | `src/components/FlightPlan.vue` moved here; now only state, requests, notice banner and live route preview. |
| `src/components/flightplan/PlanForm.vue` | The flight plan fieldset on `Field` / `FieldGrid`. |
| `src/components/flightplan/SimbriefImport.vue` | SimBrief import button and its request. |
| `src/components/flightplan/PlanStatusBar.vue` | Current filed-plan status line, reload and delete. |
| `src/components/RouteTabs.vue` | `/route` island: Generate / Expand tabs. |
| `src/components/AirportDetail.vue` | Airport detail view with runways from can-db. |

### Modified

| Path | Change |
| --- | --- |
| `src/lib/mapBus.ts` | Adds `panel:layout` (with replay), `map:focus`, `map:plan`; drops `MapPayload.focus`. |
| `src/lib/nav.ts` | Exports `isCurrentPath`. |
| `src/lib/chartStyle.ts`, `src/lib/chartStyle.test.ts` | Route line colour → avionics magenta, pinned by a hue test. |
| `src/styles/globals.css` | `can-efb only` section: `.glass`, shell/panel/sheet/tab bar CSS, map overlay CSS, `.field-grid`, `.phone-only`, `.phone-hidden`. Upper `@import` untouched. |
| `src/layouts/AppLayout.astro` | New layer order; `panel` prop; renders `FloatingPanel`; `MapStage` instead of `MapSurface`. |
| `src/components/RailScript.astro` | Writes `auto` when nothing is stored. |
| `src/components/AppRail.vue` | Glass rail, CSS-driven breakpoints, tablet auto-collapse, bottom tab bar instead of FAB + drawer. |
| `src/components/SidebarNav.vue` | Uses `isCurrentPath` from `lib/nav.ts`. |
| `src/components/Dashboard.vue` | User summary, plan card, METAR cards, ATC/ATIS on `StateCard`; asks the map for the filed plan. |
| `src/components/RoutePlanner.vue`, `RouteGenerator.vue`, `ProcedurePicker.vue` | `StateCard` states, `PanelSection`, can-db 401/403 → forbidden. |
| `src/components/Airports.vue` | Owns its forbidden/error/empty states; list and detail; `map:focus`. |
| `src/lib/airports.ts` | Adds `AirportRow`, the island-side copy of can-db's `AirportSummary`. |
| `src/pages/api/db/[...path].ts` | `who` comments name the new callers. No entry added or removed. |
| `src/components/Settings.vue` | Three groups (account, preferences, SimBrief) on `PanelSection` / `StateCard`; theme/language control; phone-only links and sign-out. |
| `src/pages/index.astro`, `flightplan.astro`, `route.astro`, `airports.astro`, `settings.astro`, `404.astro` | Pass `panel`, drop `PageHeader`, new islands/props. |
| `language/zh-cn.json`, `zh-tw.json`, `en-us.json`, `ja-jp.json` | New keys per task; `placeholder.*` removed. |
| `AGENTS.md` | Stale paths fixed, `/charts` line dropped, shell section rewritten. |

### Deleted

| Path | Why |
| --- | --- |
| `src/components/MapSurface.vue` | Split into `components/map/*`. |
| `src/components/RouteMap.vue` | Moved to `components/map/RouteMap.vue`. |
| `src/components/FlightPlan.vue` | Moved to `components/flightplan/FlightPlan.vue`. |
| `src/components/Placeholder.astro` | No page uses it. |

### Seams used for the three large splits

`MapSurface.vue` (1,525 lines) splits along the five state owners that already exist in it and share nothing but the `prefs` object, the notice line and the airway collection:

1. **Layer notice** (250–298): `notice`, `deniedThisSession`, `isDenied`. Every layer writes to it.
2. **Layer registry** (static can-db / static-file layers): airways 307–373, navaids 375–400 + 728–762, FIRs 402–416 + 764–792, MORA 418–427 + 462–471 + 967–1024, airspaces 700–726 + 1041–1123, zoom-driven airports/runways 438–443 + 453–458 + 815–851.
3. **Ground layer** (zoom only, own sequence gate): 428–437, 459–461, 853–965.
4. **Traffic layer** (datafeed polling, own timer): 473–698, 1026–1039.
5. **Route layer** (bus subscription, filed plan, highlight): 302–305, 444–451, 1125–1290.
6. **Controls** (template 1395–1523): buttons and notices only.

The one cross-edge: the registry changes the airway collection, and the route layer must recompute the highlight (`refreshHighlight`, 1237–1274) and writes a new collection object back. The collection ref is therefore owned by `MapStage` and passed to both; the registry calls an `onAirwaysChange` callback where the original called `refreshHighlight()`.

`RouteMap.vue` (953 lines) splits along what touches the MapLibre instance and what does not:

- Pure geometry (121–135, 345–431) → `lib/routeGeometry.ts`.
- Basemap fetches (263–290, 689–747) → `map/basemap.ts`.
- Attribution control (472–517) → `map/attribution.ts`.
- Camera (543–546, 644–687) → `map/camera.ts`, plus `setPadding`.
- Scroll-zoom-follows-shell (88–119) is deleted: the map is full-bleed and the page never scrolls.
- What stays: worker URL, props, construction, `setSource` / memos / `render`, theme, observers.

`FlightPlan.vue` (715 lines) splits along its three UI regions and the pure helpers:

- Pure (30–88, 132–137) → `lib/flightPlan.ts`.
- SimBrief import (299–321 + button 407–415) → `SimbriefImport.vue`.
- Status line + delete (371–426 without the import button) → `PlanStatusBar.vue`.
- Form (428–713) → `PlanForm.vue`.
- What stays: `load`, `recheck`, `applyDraft`, `file`, `remove`, the notice banner (335–369) and the new route preview.

---

## Task order

| # | Spec step | Task |
| --- | --- | --- |
| 1 | 1 Shell | `lib/panelLayout.ts` |
| 2 | 1 Shell | `lib/sheet.ts` |
| 3 | 1 Shell | `mapBus`: `panel:layout`, `map:focus`, `map:plan` |
| 4 | 1 Shell | Split `MapSurface.vue` → `MapStage` + layer composables + `MapControls`; `.glass`; failed-layer notice |
| 5 | 1 Shell | Split `RouteMap.vue`; padding and `map:focus` in the map |
| 6 | 1 Shell | Route lines in avionics magenta |
| 7 | 1 Shell | `FloatingPanel`, panel controller, full-bleed shell CSS, `AppLayout`, pages pass `panel` |
| 8 | 1 Shell | Glass rail, tablet auto-collapse, phone tab bar |
| 9 | 2 Shared | `lib/requestState.ts` |
| 10 | 2 Shared | `StateCard`, `PanelSection`, `Field`, `FieldGrid` |
| 11 | 3 Dashboard | Dashboard |
| 12 | 4 Flight plan | `lib/flightPlan.ts`, `lib/routePreview.ts` |
| 13 | 4 Flight plan | Split `FlightPlan.vue`, live route preview, lock banner |
| 14 | 5 Route | `RouteTabs`, states in `RoutePlanner` / `RouteGenerator` / `ProcedurePicker` |
| 15 | 6 Airports, 404 | Airports list + detail, island-owned states, 404 |
| 16 | 7 Settings | Settings |
| 17 | 8 Cleanup | Hydration audit, dead code |
| 18 | 8 Cleanup | AGENTS.md |

After merge to `main`: push can-efb, then bump the `can-efb` pointer in the monorepo root (not part of this plan's tasks).

---

## Task 1: `lib/panelLayout.ts` — panel rectangle → map padding

**Files:**
- Create: `src/lib/panelLayout.ts`
- Create: `src/lib/panelLayout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type ShellMode = "desktop" | "tablet" | "phone";
  export type PanelWidth = "standard" | "wide";
  export type RailState = "collapsed" | "expanded";
  export interface PanelRect { left: number; top: number; right: number; bottom: number }
  export interface PanelLayout { mode: ShellMode; collapsed: boolean; rect: PanelRect }
  export interface MapPadding { top: number; right: number; bottom: number; left: number }
  export const PANEL_GAP_PX: 12;
  export const MIN_VISIBLE_PX: 160;
  export function parseShellMode(raw: string): ShellMode;
  export function effectiveRail(dataRail: string | undefined, autoValue: string): RailState;
  export function mapPaddingFor(layout: PanelLayout, viewport: { width: number; height: number }): MapPadding;
  ```

- [ ] **Step 1: Write the failing test**

`src/lib/panelLayout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  effectiveRail,
  mapPaddingFor,
  MIN_VISIBLE_PX,
  PANEL_GAP_PX,
  parseShellMode,
} from "@/lib/panelLayout";

/**
 * 地图铺满视口、面板压在上面。内边距算错不会报错：镜头照样居中，只是中心落在面
 * 板底下 —— 屏幕上看起来像「航路没框进来」，不像一个 bug。
 */
describe("mapPaddingFor", () => {
  test("桌面：左边让出轨和面板，再加一道留白", () => {
    expect(
      mapPaddingFor(
        {
          mode: "desktop",
          collapsed: false,
          rect: { left: 284, top: 12, right: 700, bottom: 788 },
        },
        { width: 1440, height: 800 },
      ),
    ).toEqual({ top: 12, right: 12, bottom: 12, left: 712 });
  });

  test("折叠成一条之后按那一条算，不按原来的宽度", () => {
    expect(
      mapPaddingFor(
        {
          mode: "tablet",
          collapsed: true,
          rect: { left: 88, top: 12, right: 140, bottom: 788 },
        },
        { width: 1024, height: 800 },
      ).left,
    ).toBe(140 + PANEL_GAP_PX);
  });

  test("可见区至少留 160px，窗口再窄也不给负宽度", () => {
    expect(
      mapPaddingFor(
        {
          mode: "desktop",
          collapsed: false,
          rect: { left: 284, top: 12, right: 760, bottom: 788 },
        },
        { width: 800, height: 800 },
      ).left,
    ).toBe(800 - PANEL_GAP_PX - MIN_VISIBLE_PX);
  });

  test("手机：底部让出抽屉盖住的那一截", () => {
    expect(
      mapPaddingFor(
        {
          mode: "phone",
          collapsed: false,
          rect: { left: 0, top: 400, right: 390, bottom: 780 },
        },
        { width: 390, height: 844 },
      ),
    ).toEqual({ top: 12, right: 12, bottom: 456, left: 12 });
  });

  test("手机抽屉拉满时，底部内边距同样夹住", () => {
    expect(
      mapPaddingFor(
        {
          mode: "phone",
          collapsed: false,
          rect: { left: 0, top: 8, right: 390, bottom: 780 },
        },
        { width: 390, height: 844 },
      ).bottom,
    ).toBe(844 - MIN_VISIBLE_PX);
  });
});

/** `--shell-mode` 读出来带空格，CSS 还没到时是空串。 */
describe("parseShellMode", () => {
  test("认得三个值，两头的空白不算", () => {
    expect(parseShellMode(" desktop ")).toBe("desktop");
    expect(parseShellMode("tablet")).toBe("tablet");
    expect(parseShellMode("phone")).toBe("phone");
  });

  test("认不得的一律当手机 —— 那是样式表里的起点", () => {
    expect(parseShellMode("")).toBe("phone");
    expect(parseShellMode("columns")).toBe("phone");
  });
});

/**
 * `data-rail` 有三个值。`auto` 表示成员从没选过，由 CSS 按宽度决定：平板上收起，
 * 桌面上展开。判错的后果是轨的箭头朝向和实际宽度对不上。
 */
describe("effectiveRail", () => {
  test("成员选过的值原样生效", () => {
    expect(effectiveRail("collapsed", "expanded")).toBe("collapsed");
    expect(effectiveRail("expanded", "collapsed")).toBe("expanded");
  });

  test("auto 跟着 CSS 给的 --rail-auto 走", () => {
    expect(effectiveRail("auto", " collapsed")).toBe("collapsed");
    expect(effectiveRail("auto", "expanded")).toBe("expanded");
    expect(effectiveRail(undefined, "")).toBe("expanded");
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/panelLayout.test.ts`
Expected: FAIL — `Cannot find module '@/lib/panelLayout'`.

- [ ] **Step 3: Implement**

`src/lib/panelLayout.ts`:

```ts
/**
 * 浮动面板和地图之间的几何换算。
 *
 * 地图铺满整个视口，面板浮在它上面。于是「地图的可见区」不再是地图容器本身，而是
 * 容器减去面板盖住的那一块 —— MapLibre 的 `setPadding` 正是为这件事存在的：给了
 * 内边距之后，`fitBounds`、`easeTo` 的中心落在露出来的那一块中间，而不是落在被面
 * 板压住的视口中心。
 *
 * 这里只做换算、不碰 DOM，所以能测。量面板的是 `lib/panelController.ts`，用结果
 * 的是 `components/map/MapStage.vue`。
 */

/** 外壳的三种排布。断点只在 `globals.css` 里定义，JS 读 `--shell-mode`。 */
export type ShellMode = "desktop" | "tablet" | "phone";

/** 页面声明的面板宽度。平板上 `wide` 由 CSS 退回 `standard`，这里不管。 */
export type PanelWidth = "standard" | "wide";

export type RailState = "collapsed" | "expanded";

/** 面板在视口里的位置，就是 `getBoundingClientRect()` 的那四个数。 */
export interface PanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PanelLayout {
  mode: ShellMode;
  /** 桌面 / 平板上收成一条，或手机上抽屉收到只剩把手。 */
  collapsed: boolean;
  rect: PanelRect;
}

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 面板离视口边缘的留白，和 `globals.css` 的 `--shell-inset` 同值。 */
export const PANEL_GAP_PX = 12;

/**
 * 地图可见区至少留这么宽（手机上是这么高）。
 *
 * 窗口窄到面板几乎占满时照算，内边距会大过视口，MapLibre 对负的可见区的反应是镜
 * 头乱跳 —— 看起来像地图坏了，而不是像窗口太窄。
 */
export const MIN_VISIBLE_PX = 160;

export function parseShellMode(raw: string): ShellMode {
  const value = raw.trim();
  return value === "desktop" || value === "tablet" ? value : "phone";
}

/**
 * 轨此刻到底是收着还是展开。
 *
 * `data-rail="auto"` 是「成员没选过」：RailScript 找不到存下来的值时写它，由 CSS
 * 按宽度给出 `--rail-auto`。成员一旦点过折叠钮，写进去的就是确定值，auto 不再参与。
 */
export function effectiveRail(
  dataRail: string | undefined,
  autoValue: string,
): RailState {
  if (dataRail === "collapsed" || dataRail === "expanded") return dataRail;
  return autoValue.trim() === "collapsed" ? "collapsed" : "expanded";
}

/**
 * 面板盖住了哪一块，换成地图的内边距。
 *
 * 桌面和平板上面板在左边，让出 `rect.right`；手机上它是底部的抽屉，让出视口底边
 * 到 `rect.top` 那一截。其余三边只留一道留白，让控件不贴边。
 *
 * 用的是**面板此刻的矩形**而不是它声明的宽度：折叠、抽屉拖到一半、平板上 wide 退
 * 回 standard，都已经反映在矩形里了，这里不必再知道一遍规则。
 */
export function mapPaddingFor(
  layout: PanelLayout,
  viewport: { width: number; height: number },
): MapPadding {
  const gap = PANEL_GAP_PX;
  if (layout.mode === "phone") {
    const covered = Math.max(0, viewport.height - layout.rect.top);
    const bottom = Math.min(
      covered + gap,
      Math.max(0, viewport.height - MIN_VISIBLE_PX),
    );
    return { top: gap, right: gap, bottom, left: gap };
  }
  const left = Math.min(
    Math.max(0, layout.rect.right) + gap,
    Math.max(0, viewport.width - gap - MIN_VISIBLE_PX),
  );
  return { top: gap, right: gap, bottom: gap, left };
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/panelLayout.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Gate**

Run: `bunx prettier --write src/lib/panelLayout.ts src/lib/panelLayout.test.ts && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/panelLayout.ts src/lib/panelLayout.test.ts
perl -e 'alarm 40; exec @ARGV' git commit -m "面板矩形换算成地图内边距" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: `lib/sheet.ts` — bottom-sheet snap points

**Files:**
- Create: `src/lib/sheet.ts`
- Create: `src/lib/sheet.test.ts`

**Interfaces:**
- Consumes: `projectToDetent(position, velocity, detents)` from `@jianyuelab-org/can-ui/motion`; `PanelWidth` from Task 1.
- Produces:
  ```ts
  export type SheetSnap = "collapsed" | "half" | "full";
  export interface SheetGeometry { height: number; peek: number }
  export const SHEET_PEEK_PX: 72;
  export function sheetOffsets(geometry: SheetGeometry): Record<SheetSnap, number>;
  export function snapAfterDrag(offset: number, velocity: number, geometry: SheetGeometry): SheetSnap;
  export function initialSnap(width: PanelWidth): SheetSnap;
  ```

- [ ] **Step 1: Write the failing test**

`src/lib/sheet.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  initialSnap,
  SHEET_PEEK_PX,
  sheetOffsets,
  snapAfterDrag,
} from "@/lib/sheet";

const geometry = { height: 800, peek: SHEET_PEEK_PX };

/**
 * 偏移量是抽屉向下平移的像素：0 是拉满，越大露出来越少。算错了抽屉会停在两个档
 * 位之间，或者收起后连把手都看不见 —— 那时它就再也拉不回来了。
 */
describe("sheetOffsets", () => {
  test("三档：拉满、一半、只剩把手", () => {
    expect(sheetOffsets(geometry)).toEqual({
      full: 0,
      half: 400,
      collapsed: 800 - SHEET_PEEK_PX,
    });
  });

  test("抽屉比把手还矮时三档重合在 0，不给负数", () => {
    expect(sheetOffsets({ height: 60, peek: SHEET_PEEK_PX })).toEqual({
      full: 0,
      half: 0,
      collapsed: 0,
    });
  });
});

/**
 * 松手后停在哪一档由**动量**决定，不是由松手的位置决定：同一个像素上的慢拖和快
 * 甩应该落到不同的地方（can-ui 的 `projectToDetent` 讲了为什么）。
 */
describe("snapAfterDrag", () => {
  test("慢慢松手，停在最近的一档", () => {
    expect(snapAfterDrag(390, 0, geometry)).toBe("half");
    expect(snapAfterDrag(100, 0, geometry)).toBe("full");
    expect(snapAfterDrag(700, 0, geometry)).toBe("collapsed");
    expect(snapAfterDrag(420, 100, geometry)).toBe("half");
  });

  test("往下快甩，从拉满直接收起", () => {
    expect(snapAfterDrag(100, 2500, geometry)).toBe("collapsed");
  });

  test("往上快甩，从收起直接拉满", () => {
    expect(snapAfterDrag(700, -2500, geometry)).toBe("full");
  });
});

/** 表单页（wide）要打字，一打开就该拉满；地图页只占一半，把图让出来。 */
describe("initialSnap", () => {
  test("wide 页拉满，standard 页一半", () => {
    expect(initialSnap("wide")).toBe("full");
    expect(initialSnap("standard")).toBe("half");
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/sheet.test.ts`
Expected: FAIL — `Cannot find module '@/lib/sheet'`.

- [ ] **Step 3: Implement**

`src/lib/sheet.ts`:

```ts
/**
 * 手机上面板变成底部抽屉，三档：收起（只剩把手）、一半、拉满。
 *
 * 这里只算数：每一档对应多少像素的向下平移、松手之后该落到哪一档。拖动本身在
 * `lib/panelController.ts`，那一半碰 DOM，这一半能测。
 *
 * 松手的判定借 can-ui 的 `projectToDetent`：先按速度把手势往前推一段，再挑最近
 * 的一档。只按松手位置挑的话，一次干脆的快甩和一次慢拖在同一个像素松手结果一
 * 样，快甩等于白甩。
 */
import { projectToDetent } from "@jianyuelab-org/can-ui/motion";
import type { PanelWidth } from "@/lib/panelLayout";

export type SheetSnap = "collapsed" | "half" | "full";

export interface SheetGeometry {
  /** 抽屉拉满时的高度，px。 */
  height: number;
  /** 收起时还露在外面的那一截，px —— 把手加标题行。 */
  peek: number;
}

/** 收起时露出来的高度。够放把手和一行标题，少了就没地方下手把它拉回来。 */
export const SHEET_PEEK_PX = 72;

/** 每一档对应的向下平移量。拉满是 0。 */
export function sheetOffsets({
  height,
  peek,
}: SheetGeometry): Record<SheetSnap, number> {
  const h = Math.max(0, height);
  const collapsed = Math.max(0, h - Math.max(0, peek));
  return {
    full: 0,
    half: Math.min(Math.round(h / 2), collapsed),
    collapsed,
  };
}

/**
 * 松手之后落到哪一档。
 *
 * @param offset 松手那一刻的平移量，px
 * @param velocity 松手那一刻的竖直速度，px/s，向下为正
 */
export function snapAfterDrag(
  offset: number,
  velocity: number,
  geometry: SheetGeometry,
): SheetSnap {
  const o = sheetOffsets(geometry);
  const target = projectToDetent(offset, velocity, [o.full, o.half, o.collapsed]);
  if (target === o.full) return "full";
  if (target === o.half) return "half";
  return "collapsed";
}

/**
 * 打开一页时抽屉停在哪一档。
 *
 * 表单页（`wide`：飞行计划、设置）要打字，一半高度放不下键盘上方的输入框；地图页
 * 停在一半，把图让出来。宽度本来就是按「是不是表单页」声明的，所以直接从它推。
 */
export function initialSnap(width: PanelWidth): SheetSnap {
  return width === "wide" ? "full" : "half";
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/sheet.test.ts`
Expected: PASS, 7 tests. If the import of `@jianyuelab-org/can-ui/motion` fails under Bun, stop and report — do not copy `projectToDetent` into this repo (can-ui is the only owner).

- [ ] **Step 5: Gate**

Run: `bunx prettier --write src/lib/sheet.ts src/lib/sheet.test.ts && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sheet.ts src/lib/sheet.test.ts
perl -e 'alarm 40; exec @ARGV' git commit -m "手机抽屉的三档偏移和松手判定" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: `mapBus` — `panel:layout`, `map:focus`, `map:plan`

**Files:**
- Modify: `src/lib/mapBus.ts` (append after line 101; `MapPayload.focus` at lines 47–53 stays until Task 5)
- Create: `src/lib/mapBus.test.ts`

**Interfaces:**
- Consumes: `PanelLayout` from Task 1.
- Produces:
  ```ts
  export const PANEL_LAYOUT_EVENT: "efb:panel-layout";
  export function announcePanelLayout(layout: PanelLayout): void;
  export function subscribePanelLayout(handler: (layout: PanelLayout) => void): () => void; // replays the last layout
  export type MapFocus =
    | { kind: "point"; lat: number; lon: number; zoom?: number }
    | { kind: "bounds"; south: number; west: number; north: number; east: number };
  export const MAP_FOCUS_EVENT: "efb:map-focus";
  export function isMapFocus(value: unknown): value is MapFocus;
  export function focusMap(target: MapFocus): void; // drops invalid targets
  export function subscribeMapFocus(handler: (target: MapFocus) => void): () => void;
  export const MAP_PLAN_EVENT: "efb:map-plan";
  export function showPlanOnMap(): void;
  export function subscribePlanRequest(handler: () => void): () => void;
  ```

`map:plan` is not in the spec's message list. It exists because the spec requires the Dashboard map to show the filed plan, and today the map stops drawing the plan for the rest of the session once any page has published (`MapSurface.vue` 1125–1128, `panelPublished`). See the self-review.

- [ ] **Step 1: Write the failing test**

`src/lib/mapBus.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  announcePanelLayout,
  focusMap,
  isMapFocus,
  showPlanOnMap,
  subscribeMapFocus,
  subscribePanelLayout,
  subscribePlanRequest,
  type MapFocus,
} from "@/lib/mapBus";
import type { PanelLayout } from "@/lib/panelLayout";

/*
 * mapBus 挂在 window 上。Bun 没有 DOM，这里给它一个 EventTarget 顶着 —— 用完删
 * 掉，别的测试文件里 `typeof window` 仍然是 undefined。
 */
const globals = globalThis as { window?: unknown };
beforeAll(() => {
  globals.window = new EventTarget();
});
afterAll(() => {
  delete globals.window;
});

const layout = (right: number): PanelLayout => ({
  mode: "desktop",
  collapsed: false,
  rect: { left: 100, top: 12, right, bottom: 788 },
});

/**
 * 地图是 `client:load` 的岛屿，面板脚本在 `astro:page-load` 上跑，谁先谁后不一定。
 * 地图晚到一步就收不到面板第一次的位置，内边距一直是 0 —— 航路被面板压住，没有
 * 任何报错。所以订阅时要把最后一次的位置补发一遍。
 */
describe("panel:layout", () => {
  test("订阅之后收得到", () => {
    const seen: number[] = [];
    const stop = subscribePanelLayout((l) => seen.push(l.rect.right));
    announcePanelLayout(layout(500));
    stop();
    announcePanelLayout(layout(600));
    expect(seen).toEqual([500]);
  });

  test("晚到的订阅者先拿到最后一次的位置", () => {
    announcePanelLayout(layout(700));
    const seen: number[] = [];
    const stop = subscribePanelLayout((l) => seen.push(l.rect.right));
    stop();
    expect(seen).toEqual([700]);
  });
});

/**
 * 飞过去的目标必须是个真坐标。datafeed 里刚连上的飞机没有经纬度，从前那种点被传
 * 下去，地图飞去 NaN，整张图不动，看起来像按钮坏了（MapSurface.vue 576–587）。
 */
describe("map:focus", () => {
  test("合法的点和框都认", () => {
    expect(isMapFocus({ kind: "point", lat: 31.2, lon: 121.3 })).toBe(true);
    expect(
      isMapFocus({ kind: "point", lat: 31.2, lon: 121.3, zoom: 10 }),
    ).toBe(true);
    expect(
      isMapFocus({ kind: "bounds", south: 30, west: 120, north: 32, east: 122 }),
    ).toBe(true);
  });

  test("NaN、缺字段、南北颠倒一律不认", () => {
    expect(isMapFocus({ kind: "point", lat: Number.NaN, lon: 121 })).toBe(false);
    expect(isMapFocus({ kind: "point", lat: 31 })).toBe(false);
    expect(
      isMapFocus({ kind: "bounds", south: 32, west: 120, north: 30, east: 122 }),
    ).toBe(false);
    expect(isMapFocus(null)).toBe(false);
  });

  test("发出去的合法目标原样收到，不合法的根本不发", () => {
    const seen: MapFocus[] = [];
    const stop = subscribeMapFocus((f) => seen.push(f));
    focusMap({ kind: "point", lat: 31.2, lon: 121.3 });
    focusMap({ kind: "point", lat: Number.NaN, lon: 121.3 });
    stop();
    expect(seen).toEqual([{ kind: "point", lat: 31.2, lon: 121.3 }]);
  });
});

describe("map:plan", () => {
  test("请求地图回到已提交的计划", () => {
    let count = 0;
    const stop = subscribePlanRequest(() => count++);
    showPlanOnMap();
    stop();
    showPlanOnMap();
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/mapBus.test.ts`
Expected: FAIL — `SyntaxError: Export named 'announcePanelLayout' not found in module`.

- [ ] **Step 3: Implement**

Add `import type { PanelLayout } from "@/lib/panelLayout";` directly below the header comment of `src/lib/mapBus.ts` (after line 17). Append after line 101:

```ts

/* --------------------------------------------------------------------------
   panel:layout —— 面板此刻盖住了哪一块。
-------------------------------------------------------------------------- */

/**
 * 地图铺满视口之后，它得知道面板压住了哪一块，才能把内容对到露出来的那一块中间
 * （`map.setPadding`，换算在 `lib/panelLayout.ts`）。
 *
 * **记住最后一次，订阅时补发。** 地图是 `client:load` 的岛屿，面板脚本跑在
 * `astro:page-load` 上，两者谁先谁后不一定；地图晚到的话，没有这一下它就一直以
 * 为面板不存在，航路被压在面板底下 —— 不报错，只是看起来没框进来。
 */
export const PANEL_LAYOUT_EVENT = "efb:panel-layout";

let lastPanelLayout: PanelLayout | null = null;

export function announcePanelLayout(layout: PanelLayout): void {
  lastPanelLayout = layout;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PanelLayout>(PANEL_LAYOUT_EVENT, { detail: layout }),
  );
}

export function subscribePanelLayout(
  handler: (layout: PanelLayout) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  if (lastPanelLayout) handler(lastPanelLayout);
  const listener = (event: Event) => {
    handler((event as CustomEvent<PanelLayout>).detail);
  };
  window.addEventListener(PANEL_LAYOUT_EVENT, listener);
  return () => window.removeEventListener(PANEL_LAYOUT_EVENT, listener);
}

/* --------------------------------------------------------------------------
   map:focus —— 把镜头对到一个点或一个框。
-------------------------------------------------------------------------- */

/**
 * 「在一堆东西里挑一个看」：机场列表点一行、「定位到我」。
 *
 * 和 `MapPayload.points` 分开是因为它不改图上画什么，只改镜头；混在一起就只能靠
 * 重推整层来挪镜头。点的 `zoom` 是下限：已经放得更大时不缩回去。
 */
export type MapFocus =
  | { kind: "point"; lat: number; lon: number; zoom?: number }
  | {
      kind: "bounds";
      south: number;
      west: number;
      north: number;
      east: number;
    };

export const MAP_FOCUS_EVENT = "efb:map-focus";

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * 是不是一个飞得过去的目标。**NaN 必须挡在这里**：MapLibre 收到 NaN 不报错，整
 * 张图原地不动，按钮看起来坏了。
 */
export function isMapFocus(value: unknown): value is MapFocus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "point") {
    return (
      finite(v.lat) &&
      finite(v.lon) &&
      (v.zoom === undefined || finite(v.zoom))
    );
  }
  if (v.kind === "bounds") {
    return (
      finite(v.south) &&
      finite(v.west) &&
      finite(v.north) &&
      finite(v.east) &&
      v.south <= v.north
    );
  }
  return false;
}

export function focusMap(target: MapFocus): void {
  if (typeof window === "undefined" || !isMapFocus(target)) return;
  window.dispatchEvent(
    new CustomEvent<MapFocus>(MAP_FOCUS_EVENT, { detail: target }),
  );
}

export function subscribeMapFocus(
  handler: (target: MapFocus) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    handler((event as CustomEvent<MapFocus>).detail);
  };
  window.addEventListener(MAP_FOCUS_EVENT, listener);
  return () => window.removeEventListener(MAP_FOCUS_EVENT, listener);
}

/* --------------------------------------------------------------------------
   map:plan —— 「地图，回到我已提交的那份计划」。
-------------------------------------------------------------------------- */

/**
 * 面板推过一次东西之后，地图这次会话里就不再画计划（不然面板刚画好的航路会被异
 * 步回来的计划顶掉，见 useRouteLayer 的 `panelPublished`）。概览页要的正好是计划，
 * 所以它得明说一声。不带内容：计划以 can-api 为准，地图收到后自己读。
 */
export const MAP_PLAN_EVENT = "efb:map-plan";

export function showPlanOnMap(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MAP_PLAN_EVENT));
}

export function subscribePlanRequest(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MAP_PLAN_EVENT, handler);
  return () => window.removeEventListener(MAP_PLAN_EVENT, handler);
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/mapBus.test.ts`
Expected: PASS, 6 tests. Then `bun test` for the whole suite — every other file must still pass (confirms the `window` stub is removed after this file).

- [ ] **Step 5: Gate**

Run: `bunx prettier --write src/lib/mapBus.ts src/lib/mapBus.test.ts && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mapBus.ts src/lib/mapBus.test.ts
perl -e 'alarm 40; exec @ARGV' git commit -m "mapBus 加上 panel:layout、map:focus、map:plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Split `MapSurface.vue` into `MapStage` + layer composables + `MapControls`

This is a structural move with two behaviour additions the spec asks for: a failed layer shows a small corner notice with a retry, and the nine layer buttons collapse into one layer menu (the old row does not fit on a phone). Layout stays as today (`.app-map` column) until Task 7.

**Files:**
- Create: `src/lib/mapPrefs.ts`, `src/lib/mapPrefs.test.ts`
- Create: `src/components/map/useLayerNotice.ts`, `useChartLayers.ts`, `useGroundLayer.ts`, `useTrafficLayer.ts`, `useRouteLayer.ts`, `MapControls.vue`, `MapStage.vue`
- Delete: `src/components/MapSurface.vue`
- Modify: `src/layouts/AppLayout.astro` lines 27, 104–133
- Modify: `src/styles/globals.css` lines 282–384 (replaced), append `.glass`
- Modify: `language/*.json` (`efb.map.layersMenu`, `efb.map.layerFailed`, `efb.map.locate`)

**Interfaces:**
- Consumes: `LayerId` etc. defined here; `MapPoint`, `subscribeToMap`, `PLAN_CHANGED_EVENT` from `lib/mapBus.ts`.
- Produces:
  ```ts
  // lib/mapPrefs.ts
  export const PREF_KEY: "efb.map.layers";
  export interface LayerPrefs { airways; firs; mora; traffic; atcLive; navaids; ctr; app; restricted: boolean }
  export const DEFAULT_PREFS: LayerPrefs;
  export function readPrefs(storage?: Pick<Storage, "getItem"> | null): LayerPrefs;
  export function writePrefs(prefs: LayerPrefs, storage?: Pick<Storage, "setItem"> | null): void;

  // map/useLayerNotice.ts
  export type LayerId = "airways" | "firs" | "navaids" | "mora" | "ctr" | "app" | "restricted" | "live";
  export interface LayerNotice {
    notice: Ref<{ layer: string; text: string } | null>;
    failure: Ref<LayerId | null>;
    setNotice(layer: string, text: string): void;
    clearNotice(layer: string): void;
    noteDenied(): void;
    isDeniedThisSession(): boolean;
    noteFailure(layer: LayerId): void;
    clearFailure(layer: LayerId): void;
  }
  export function isDenied(error: unknown): boolean;
  export function useLayerNotice(deniedText: string): LayerNotice;

  // map/useChartLayers.ts
  export interface Viewport { south: number; west: number; north: number; east: number; zoom: number }
  export type ChartLayerToggle = Exclude<LayerId, "live">;
  export type LayerToggle = ChartLayerToggle | "traffic" | "atcLive";
  export function useChartLayers(options: {
    airways: Ref<FeatureCollection | null>;
    notice: LayerNotice;
    prefs: LayerPrefs;
    text: { emptyAirways: string; emptyNavaids: string; emptyGeneric: string };
    onAirwaysChange: () => void;
  }): ChartLayers; // refs + toggleAirways(on?), toggleNavaids(), toggleFirs(), toggleMora(),
                   // toggleAirspace(which), loadFirCache(), onViewport(v), restore(saved), retry(id)

  // map/useGroundLayer.ts
  export function useGroundLayer(options: { notice: LayerNotice; text: { groundAccuracy: string } }):
    { ground: Ref<FeatureCollection | null>; groundAttribution: Ref<string[]>; loadGroundFor(v: Viewport): Promise<void> };

  // map/useTrafficLayer.ts
  export function useTrafficLayer(options: {
    cid: string | null; prefs: LayerPrefs; notice: LayerNotice;
    loadFirCache: () => Promise<FeatureCollection>;
  }): TrafficLayer; // refs + toggleLive(which), refreshLive(), locateTarget(): MapPoint | null, start(saved), stop()

  // map/useRouteLayer.ts
  export function useRouteLayer(options: {
    airways: Ref<FeatureCollection | null>;
    text: { label: string; planOnMap: string };
  }): RouteLayer; // points, markers, focus, label, highlightedLegs, refreshHighlight(), start(), stop()
  ```

**Behaviour that must survive (MapSurface.vue at `29b690d`):**
- Empty is not error: an empty layer stays on and says so (`setNotice`), 339–341, 359–361, 750–752, 1107–1109.
- A failed layer reverts to off, 362–369, 753–758, 783–788, 1110–1114. Now it also shows the failure notice with retry.
- Denial is session-level and overrides per-layer notices, 250–298. A denied layer never shows the failure notice (denial has its own line).
- Live data failure keeps the last frame, 628–633.
- Toggle state flips before the await; in-flight toggles are queued, 649–698.
- Ground requests are sequence-gated, 858–864, 880, 895, 920.
- Plan route: read failure keeps whatever is drawn, 1177–1178; withdrawn plan is removed, 1183–1188; a panel publication blocks the plan, 1125–1128, 1169, 1176, 1215, 1219.
- Highlight recomputes only when the legs signature changes, 1256–1266.
- Timers and listeners stop on unmount, 1338–1348.

- [ ] **Step 1: Write the failing test for `mapPrefs`**

`src/lib/mapPrefs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFS,
  PREF_KEY,
  readPrefs,
  writePrefs,
} from "@/lib/mapPrefs";

/** 一个够用的 Storage：只要 getItem / setItem。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

/**
 * 偏好读错不会报错：图层按默认值打开，看起来一切正常，只是成员上次关掉的那几层
 * 又回来了 —— 或者更糟，上次开着的航路没了。
 */
describe("readPrefs", () => {
  test("什么都没存，给默认值", () => {
    expect(readPrefs(memoryStorage())).toEqual(DEFAULT_PREFS);
  });

  test("旧的三选一：off 折成关", () => {
    const prefs = readPrefs(
      memoryStorage({ [PREF_KEY]: JSON.stringify({ airway: "off" }) }),
    );
    expect(prefs.airways).toBe(false);
    expect("airway" in prefs).toBe(false);
  });

  test("旧的三选一：high / low 都折成开", () => {
    expect(
      readPrefs(memoryStorage({ [PREF_KEY]: JSON.stringify({ airway: "low" }) }))
        .airways,
    ).toBe(true);
  });

  test("新旧键都在时以新键为准", () => {
    expect(
      readPrefs(
        memoryStorage({
          [PREF_KEY]: JSON.stringify({ airway: "high", airways: false }),
        }),
      ).airways,
    ).toBe(false);
  });

  test("存坏了、或者 localStorage 本身会抛，一律回到默认", () => {
    expect(readPrefs(memoryStorage({ [PREF_KEY]: "{" }))).toEqual(
      DEFAULT_PREFS,
    );
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readPrefs(throwing)).toEqual(DEFAULT_PREFS);
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe("writePrefs", () => {
  test("写进去再读出来是同一份", () => {
    const storage = memoryStorage();
    const prefs = { ...DEFAULT_PREFS, mora: true, traffic: false };
    writePrefs(prefs, storage);
    expect(readPrefs(storage)).toEqual(prefs);
  });

  test("setItem 会抛也不中断", () => {
    const throwing = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writePrefs(DEFAULT_PREFS, throwing)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/mapPrefs.test.ts`
Expected: FAIL — `Cannot find module '@/lib/mapPrefs'`.

- [ ] **Step 3: Implement `src/lib/mapPrefs.ts`**

Header comment, then move `MapSurface.vue` lines 162–248 here with these changes: `PREF_KEY`, `LayerPrefs`, `DEFAULT_PREFS` get `export`; the two functions take the storage as a parameter. Keep every comment in 162–248 verbatim (the `LayerPrefs` field docs and the `DEFAULT_PREFS` reasoning). Resulting functions:

```ts
/**
 * 地图图层偏好：哪几层开着。
 *
 * 从 MapSurface.vue 搬出来，因为它是这块地图里唯一一段不碰 Vue 也不碰 DOM 的逻
 * 辑，而它错了不会被屏幕出卖：旧偏好折算错，成员上次开着的航路就悄悄没了。
 */

/* ……MapSurface.vue 162–224 原样搬来（PREF_KEY、LayerPrefs、DEFAULT_PREFS 加 export）…… */

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPrefs(
  storage: Pick<Storage, "getItem"> | null = localStorageOrNull(),
): LayerPrefs {
  try {
    const raw = storage?.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const saved = JSON.parse(raw) as Partial<LayerPrefs> & { airway?: string };
    // 旧的三选一偏好：`off` 以外都是开。折算后丢掉旧键，下次写回时就是新形状。
    if (typeof saved.airway === "string" && saved.airways === undefined) {
      saved.airways = saved.airway !== "off";
    }
    delete saved.airway;
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(
  prefs: LayerPrefs,
  storage: Pick<Storage, "setItem"> | null = localStorageOrNull(),
): void {
  try {
    storage?.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下就算了，下次回到默认 —— 不值得为此打扰用户。
  }
}
```

The `/* ……原样搬来…… */` line above is an instruction to the implementer, not code to paste: replace it with lines 162–224 of `MapSurface.vue`.

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/mapPrefs.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Create `src/components/map/useLayerNotice.ts`**

```ts
/**
 * 图层层面的那几句话：这一层为什么没东西、这次会话是不是被拒过、哪一层没取到。
 *
 * 从 MapSurface.vue 250–298 搬来。每一层都往这里写，所以它单独一个文件，而不是
 * 挂在某一层身上。
 */
import { ref, type Ref } from "vue";

/** 会失败、会被重试的那几层。`live` 是机组和管制共用的那一次 datafeed 取数。 */
export type LayerId =
  | "airways"
  | "firs"
  | "navaids"
  | "mora"
  | "ctr"
  | "app"
  | "restricted"
  | "live";

export interface LayerNotice {
  notice: Ref<{ layer: string; text: string } | null>;
  failure: Ref<LayerId | null>;
  setNotice(layer: string, text: string): void;
  clearNotice(layer: string): void;
  noteDenied(): void;
  isDeniedThisSession(): boolean;
  noteFailure(layer: LayerId): void;
  clearFailure(layer: LayerId): void;
}

/* MapSurface.vue 259–261（isDenied）加 export，原样搬来。 */
export function isDenied(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

export function useLayerNotice(deniedText: string): LayerNotice {
  /* MapSurface.vue 250–257 的注释原样放在这里。 */
  let deniedThisSession = false;

  /* MapSurface.vue 263–281 的注释原样放在这里。 */
  const notice = ref<{ layer: string; text: string } | null>(null);

  /**
   * 哪一层**没取到**。和 `notice` 分开：那一条说的是「这一层是空的 / 你没有权
   * 限」，这一条说的是「请求失败了，可以再试」。失败的那一层已经退回关，没有这一
   * 句的话它就是安静地消失了 —— 和「这一带没有数据」长得一模一样。
   *
   * 只记最近一次：两层同时失败时，重试最近那一层之后另一层还会再报。
   */
  const failure = ref<LayerId | null>(null);

  function setNotice(layer: string, text: string) {
    // 权限那条是**会话级**的，压过一切按层的提示：它一旦成立，其余每一层都会因为
    // 同一个原因空着，而把「这一层没有数据」摆在最前面会让人以为换一层就好了。
    if (notice.value?.layer === "denied") return;
    notice.value = { layer, text };
  }

  function clearNotice(layer: string) {
    if (notice.value?.layer === layer) notice.value = null;
  }

  function noteDenied() {
    deniedThisSession = true;
    notice.value = { layer: "denied", text: deniedText };
    // 被拒不是失败：那一句由权限提示来说，再挂一个「重试」只会让人去点一个永远
    // 不会成功的按钮。
    failure.value = null;
  }

  function noteFailure(layer: LayerId) {
    if (deniedThisSession) return;
    failure.value = layer;
  }

  function clearFailure(layer: LayerId) {
    if (failure.value === layer) failure.value = null;
  }

  return {
    notice,
    failure,
    setNotice,
    clearNotice,
    noteDenied,
    isDeniedThisSession: () => deniedThisSession,
    noteFailure,
    clearFailure,
  };
}
```

"原样放在这里" in the comments above means: copy those original comment blocks in place of that one-line comment.

- [ ] **Step 6: Create `src/components/map/useChartLayers.ts`**

Skeleton (write this file, then fill the marked blocks from `MapSurface.vue` exactly as listed):

```ts
/**
 * 图层登记处：航路、导航台、情报区、Grid MORA、三层空域，以及按缩放补上的机场
 * 和跑道。这些都是静态资料（can-db 或随站发的文件），按需取、取过留着。
 *
 * 从 MapSurface.vue 搬来，规矩一条没变，注释随代码一起搬。新加的只有一件事：失
 * 败时除了退回关，还要在地图角上说一声并给一个重试（`notice.noteFailure`）。
 */
import { computed, ref, type Ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  fetchAirwayNetwork,
  markNavaidFixes,
  toAirwayFixes,
  toAirwayLines,
} from "@/lib/airways";
import {
  fetchAirspaces,
  fetchNavaids,
  onlyParents,
  toAirspacePolygons,
  toNavaidPoints,
  type Airspace,
} from "@/lib/aip";
import {
  blocksFor,
  fetchMORABlock,
  toMORAPoints,
  type MORACell,
} from "@/lib/mora";
import { fetchFIRs, firBoundaries } from "@/lib/firs";
import { fetchAirportPins, toAirportPoints } from "@/lib/airports";
import {
  airportRunwaySummary,
  fetchRunways,
  toRunwayFeatures,
} from "@/lib/runways";
import { MAJOR_AIRPORT_MIN_RUNWAY_M, ZOOM } from "@/lib/chartStyle";
import { writePrefs, type LayerPrefs } from "@/lib/mapPrefs";
import {
  isDenied,
  type LayerId,
  type LayerNotice,
} from "@/components/map/useLayerNotice";

/** 视野框。RouteMap 的 `viewport` 事件就是这个形状。 */
export interface Viewport {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
}

export type ChartLayerToggle = Exclude<LayerId, "live">;
/** 图层菜单里的九个开关。实时那两层各一个，但失败时算同一次取数（`live`）。 */
export type LayerToggle = ChartLayerToggle | "traffic" | "atcLive";

export interface ChartLayerOptions {
  /** 航路网。MapStage 持有，因为航路层也要写它（高亮换一个新对象）。 */
  airways: Ref<FeatureCollection | null>;
  notice: LayerNotice;
  /** MapStage 持有的那一份偏好，开关时就地改、写回 localStorage。 */
  prefs: LayerPrefs;
  text: { emptyAirways: string; emptyNavaids: string; emptyGeneric: string };
  /** 航路网换了 —— 开、关、取回来、失败。计划高亮要跟着重算。 */
  onAirwaysChange: () => void;
}

export function useChartLayers(options: ChartLayerOptions) {
  const { airways, notice, prefs, text, onAirwaysChange } = options;

  // ① MapSurface.vue 158–160（airwayCache）
  // ② MapSurface.vue 300（navaidCache）
  // ③ MapSurface.vue 307–317、320–373（航路；跳过 318 行 prefs、319 行 airways）
  // ④ MapSurface.vue 375–404（导航台 ref、shownFixes、情报区 ref）
  // ⑤ MapSurface.vue 406–416（loadFirCache）
  // ⑥ MapSurface.vue 418–427（MORA ref）
  // ⑦ MapSurface.vue 438–443 的注释 + 453–458（airports、runways）
  // ⑧ MapSurface.vue 462–471（moraCells、moraBlocks、lastViewport）
  // ⑨ MapSurface.vue 700–792（空域 ref、skipped、layerBusy、toggleNavaids、toggleFirs）
  // ⑩ MapSurface.vue 815–851（NEED_ZOOM、loadForZoom）
  // ⑪ MapSurface.vue 967–1024（loadMoraFor、toggleMora）
  // ⑫ MapSurface.vue 1041–1123（loadControlled、loadRestricted、composeAirspaces、toggleAirspace、skippedTotal）

  /**
   * 视野变了。原来这一段在 MapSurface 的 onViewport 里和地面层挤在一起；地面层搬
   * 走之后这里只剩机场、跑道和 MORA。
   */
  function onViewport(v: Viewport) {
    lastViewport = v;
    void loadForZoom(v.zoom);
    if (!showMora.value || notice.isDeniedThisSession()) return;
    void loadMoraFor(v);
  }

  /** 挂载时按偏好把图层打开。见 MapSurface.vue 1296–1316 的说明。 */
  function restore(saved: LayerPrefs) {
    if (saved.airways) void toggleAirways(true);
    if (saved.firs) void toggleFirs();
    if (saved.mora) void toggleMora();
    if (saved.navaids) void toggleNavaids();
    if (saved.ctr) void toggleAirspace("ctr");
    if (saved.app) void toggleAirspace("app");
    if (saved.restricted) void toggleAirspace("restricted");
  }

  /**
   * 地图角上那个「重试」。失败的层已经退回关，重试就是再开一次；MORA 失败时开关
   * 留着（它按视野取，取失败的块已经放回去了），重试是把当前视野再补一次。
   */
  function retry(id: ChartLayerToggle) {
    switch (id) {
      case "airways":
        if (!showAirways.value) void toggleAirways(true);
        return;
      case "navaids":
        if (!showNavaids.value) void toggleNavaids();
        return;
      case "firs":
        if (!showFirs.value) void toggleFirs();
        return;
      case "mora":
        if (lastViewport) void loadMoraFor(lastViewport);
        return;
      default: {
        const flag =
          id === "ctr" ? showCtr : id === "app" ? showApp : showRestricted;
        if (!flag.value) void toggleAirspace(id);
      }
    }
  }

  return {
    showAirways,
    airwayFixes,
    shownFixes,
    airwayBusy,
    toggleAirways,
    showNavaids,
    navaids,
    toggleNavaids,
    showFirs,
    firs,
    toggleFirs,
    loadFirCache,
    showMora,
    mora,
    toggleMora,
    showCtr,
    showApp,
    showRestricted,
    airspaces,
    skippedTotal,
    toggleAirspace,
    layerBusy,
    airports,
    runways,
    onViewport,
    restore,
    retry,
  };
}

export type ChartLayers = ReturnType<typeof useChartLayers>;
```

Replace each `// ①…⑫` line with the listed original lines, then apply these substitutions inside the pasted code only:

| Original | Becomes |
| --- | --- |
| `refreshHighlight();` (lines 330, 338, 356) | `onAirwaysChange();` |
| `highlightedLegs.value = null;` (line 369) | `onAirwaysChange();` |
| `props.t.emptyAirways` / `emptyNavaids` / `emptyGeneric` | `text.emptyAirways` / `text.emptyNavaids` / `text.emptyGeneric` |
| `setNotice(` / `clearNotice(` | `notice.setNotice(` / `notice.clearNotice(` |
| `noteDenied()` | `notice.noteDenied()` |
| `deniedThisSession` (lines 345, 744, 1015, 1099) | `notice.isDeniedThisSession()` |

Then add the failure bookkeeping (these are the only new lines):

- In `toggleAirways` catch (after the pasted line 364): `else notice.noteFailure("airways");` so the pair reads `if (isDenied(error)) notice.noteDenied(); else notice.noteFailure("airways");`. In its success path, directly after `airwayCache = { lines, fixes };` (pasted 352): `notice.clearFailure("airways");`.
- `toggleNavaids` catch (pasted 756): same pair with `"navaids"`; success after `navaidCache = toNavaidPoints(...)` (pasted 747): `notice.clearFailure("navaids");`.
- `toggleFirs` catch (pasted 783–788): add `notice.noteFailure("firs");` after the `console.error`; success after `firs.value = firBoundaries(await loadFirCache());` (pasted 781): `notice.clearFailure("firs");`.
- `loadMoraFor` catch (pasted 996): `if (isDenied(error)) notice.noteDenied(); else notice.noteFailure("mora");`; success after the `for (const cells of batches)` loop (pasted 984–986): `notice.clearFailure("mora");`.
- `toggleAirspace` catch (pasted 1111): `if (isDenied(error)) notice.noteDenied(); else notice.noteFailure(which);`; success after `flag.value = true;` (pasted 1105): `notice.clearFailure(which);`.

The pasted `const prefs = { ...DEFAULT_PREFS };` (318) and `const airways = ref(...)` (319) are skipped; `prefs` and `airways` come from `options`.

- [ ] **Step 7: Create `src/components/map/useGroundLayer.ts`**

```ts
/**
 * 机场地面。**没有开关，由缩放决定** —— 放大本身就是「我要看这个机场」的意思。
 *
 * 从 MapSurface.vue 搬来。它有自己的序号闸（groundSeq），和别的层不共享任何状态，
 * 所以单独一个文件。
 */
import { ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  fetchGround,
  GROUND_MAX_AIRPORTS,
  GROUND_MIN_ZOOM,
  toGroundDrawing,
  type Ground,
} from "@/lib/ground";
import { airportsInView, fetchAirportPins } from "@/lib/airports";
import type { LayerNotice } from "@/components/map/useLayerNotice";
import type { Viewport } from "@/components/map/useChartLayers";

export function useGroundLayer(options: {
  notice: LayerNotice;
  text: { groundAccuracy: string };
}) {
  const { notice, text } = options;

  // ① MapSurface.vue 428–437 的注释 + 459–461（ground、groundAttribution、groundAccuracyM）
  // ② MapSurface.vue 853–965（groundCache、groundShown、groundSeq、loadGroundFor）

  return { ground, groundAttribution, loadGroundFor };
}
```

Substitutions inside ②: `setNotice(` → `notice.setNotice(`, `clearNotice(` → `notice.clearNotice(`, `props.t.groundAccuracy` → `text.groundAccuracy`. The parameter type of `loadGroundFor` becomes `v: Viewport`.

Check the current branch before pasting: `feat/ground-sector-only` (843f331) rewrites `lib/ground.ts` and this block. If it has been merged into `feat/efb-redesign` by the time you run this task, paste from the merged `MapSurface.vue` instead and keep its imports.

- [ ] **Step 8: Create `src/components/map/useTrafficLayer.ts`**

```ts
/**
 * 实时：在线机组、在线管制、自己那架和它的航迹。datafeed 每 30 秒一轮。
 *
 * 从 MapSurface.vue 搬来。两个开关共用一次取数和一个定时器，理由在下面那段原注释
 * 里。新加的只有：取数失败时在地图角上说一声（`live`），成功一次就撤掉。
 */
import { computed, ref } from "vue";
import type { FeatureCollection } from "geojson";
import type { MapPoint } from "@/lib/mapBus";
import { appendTrack, toTrackLine, type OwnTrack } from "@/lib/ownTrack";
import {
  fetchDatafeed,
  hasPosition,
  onlineControllers,
  ownPilot,
  toControllerAreas,
  toControllerPoints,
  toOwnPoint,
  toTrafficPoints,
} from "@/lib/datafeed";
import { boundaryCodesFor, ownsAirspace } from "@/lib/atc";
import { altitudeBand, flightLevel, isOnGround } from "@/lib/traffic";
import { writePrefs, type LayerPrefs } from "@/lib/mapPrefs";
import type { LayerNotice } from "@/components/map/useLayerNotice";

export function useTrafficLayer(options: {
  /** 自己的 CAN ID。见 MapSurface.vue 105–111 的说明：按 CID 认自己，不按呼号。 */
  cid: string | null;
  prefs: LayerPrefs;
  notice: LayerNotice;
  /** 边界底图。管制那层要拿它圈出「这块空域有人管」，和边界图层开不开无关。 */
  loadFirCache: () => Promise<FeatureCollection>;
}) {
  const { cid, prefs, notice, loadFirCache } = options;

  // ① MapSurface.vue 473–541（注释、开关、要素 ref、ownAt、定时器状态）
  // ② MapSurface.vue 543–551（onVisible）
  // ③ MapSurface.vue 553–634（refreshLive）
  // ④ MapSurface.vue 636–698（clearAtc、toggleLive）

  /**
   * 「定位到我」要对焦的那个点。MapSurface.vue 1026–1039 原来直接写 focus；现在
   * focus 归航路层，这里只给出目标。
   */
  function locateTarget(): MapPoint | null {
    const at = ownAt.value;
    if (!at) return null;
    return { ident: at.callsign, lat: at.lat, lon: at.lon, kind: "own" };
  }

  /** 挂载时按偏好恢复。见 MapSurface.vue 1305–1312。 */
  function start(saved: LayerPrefs) {
    document.addEventListener("visibilitychange", onVisible);
    if (saved.traffic) showTraffic.value = true;
    if (saved.atcLive) showAtc.value = true;
    if (liveOn.value) {
      void refreshLive();
      liveTimer = setInterval(() => void refreshLive(), LIVE_INTERVAL_MS);
    }
  }

  /** 见 MapSurface.vue 1341–1345：定时器必须停。 */
  function stop() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }

  return {
    showTraffic,
    showAtc,
    liveOn,
    traffic,
    atc,
    atcAreas,
    own,
    ownTrack,
    atcCount,
    ownAt,
    toggleLive,
    refreshLive,
    locateTarget,
    start,
    stop,
  };
}

export type TrafficLayer = ReturnType<typeof useTrafficLayer>;
```

Substitutions inside ①–④: `props.cid` → `cid`. In ③, line 609 becomes `const boundaries = await loadFirCache().catch(() => null);` (the cache check moved into `loadFirCache`, which already returns the cached copy). In ③, directly after `const feed = await fetchDatafeed();` (line 562) add `notice.clearFailure("live");`; in its catch (628–633) add `notice.noteFailure("live");` after the `console.error`. Nothing else changes: the catch still does not clear what is drawn.

- [ ] **Step 9: Create `src/components/map/useRouteLayer.ts`**

```ts
/**
 * 航路层：面板推来的点、成员已提交的计划、计划在航路网上点亮的那几段、镜头焦点。
 *
 * 从 MapSurface.vue 搬来。航路网本身归图层登记处；这里只读它、在高亮变了时换一个
 * 新对象写回去（原因见 refreshHighlight 里的注释）。
 */
import { ref, type Ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  PLAN_CHANGED_EVENT,
  subscribeToMap,
  type MapPoint,
} from "@/lib/mapBus";
import { markRouteOnAirways, routeLegKeys } from "@/lib/airways";
import { unwrapList } from "@/lib/aip";
import { api } from "@/lib/canApi";

export function useRouteLayer(options: {
  airways: Ref<FeatureCollection | null>;
  /** `label` 是外壳给的默认角标；`planOnMap` 带 `{from}` / `{to}`。都已翻译。 */
  text: { label: string; planOnMap: string };
}) {
  const { airways, text } = options;

  // ① MapSurface.vue 302–305（points、markers、focus、label）
  // ② MapSurface.vue 444–451（highlightedLegs 与注释）
  // ③ MapSurface.vue 1125–1235（panelPublished、planShown、planKey、planSeq、clearPlanRoute、loadPlanRoute）
  // ④ MapSurface.vue 1237–1274（refreshHighlight）
  // ⑤ MapSurface.vue 1276–1290（unsubscribe、onPageSwap）

  function start() {
    // 计划那条线不 await：地图不该等它回来才出现。
    void loadPlanRoute();
    document.addEventListener("astro:after-swap", onPageSwap);
    window.addEventListener(PLAN_CHANGED_EVENT, onPageSwap);
    unsubscribe = subscribeToMap((payload) => {
      /* MapSurface.vue 1324–1334 原样 */
    });
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    document.removeEventListener("astro:after-swap", onPageSwap);
    window.removeEventListener(PLAN_CHANGED_EVENT, onPageSwap);
  }

  return {
    points,
    markers,
    focus,
    label,
    highlightedLegs,
    refreshHighlight,
    start,
    stop,
  };
}

export type RouteLayer = ReturnType<typeof useRouteLayer>;
```

Replace the `/* MapSurface.vue 1324–1334 原样 */` comment with those lines. Substitutions: `props.label` → `text.label` (lines 305, 1148, 1334); `props.t.planOnMap` → `text.planOnMap` (1232). `airways` is the option ref, so `airways.value` in ④ needs no change.

- [ ] **Step 10: Create `src/components/map/MapControls.vue`**

```vue
<script setup lang="ts">
/**
 * 压在地图上的那几样东西：图层菜单、两条提示、没取到的那一层和它的重试、「定位
 * 到我」。
 *
 * 放在地图上而不是面板里：地图跨页面常驻，面板每换一页整个换掉 —— 开关跟着面板
 * 走的话，切一页图层状态就没人管了。
 *
 * 原来是一排九颗按钮压在左下角。地图铺满视口之后那一排在手机上要折成三行，把能
 * 看的那一小块图盖掉一半，所以收进一个菜单。
 *
 * 只收已经翻好的字符串、只往外发事件；取数和状态都在 MapStage 的几个 use* 里。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { LayerId } from "@/components/map/useLayerNotice";
import type { LayerToggle } from "@/components/map/useChartLayers";

const props = defineProps<{
  labels: Record<LayerToggle, string>;
  text: { menu: string; retry: string; locate: string; layerFailed: string };
  on: Record<LayerToggle, boolean>;
  busy: { airways: boolean; other: boolean };
  /** 在线管制席位数，只给管制那一项挂角标 —— 见 MapSurface.vue 1436–1439。 */
  atcCount: number;
  /** 「有 n 块边界不完整没画」，已经把 n 填好；没有就是 null。 */
  partial: string | null;
  notice: { layer: string; text: string } | null;
  failure: LayerId | null;
  /** 自己连着线时才有；「定位到我」按钮只在那时出现。 */
  own: { callsign: string } | null;
}>();

const emit = defineEmits<{
  toggle: [LayerToggle];
  retry: [LayerId];
  locate: [];
}>();

/** 菜单里的顺序，和原来那一排按钮一致。 */
const ORDER: LayerToggle[] = [
  "airways",
  "firs",
  "navaids",
  "mora",
  "traffic",
  "atcLive",
  "ctr",
  "app",
  "restricted",
];

const menuOpen = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);

function isBusy(id: LayerToggle): boolean {
  if (id === "airways") return props.busy.airways;
  // 实时两层从来不禁用：取数途中再点一次是合法的，见 useTrafficLayer 的 liveAgain。
  if (id === "traffic" || id === "atcLive") return false;
  return props.busy.other;
}

/** 没取到的是哪一层。`live` 是机组和管制共用的那一次取数，两个名字都报。 */
function failureLabel(id: LayerId): string {
  if (id === "live") return `${props.labels.traffic} · ${props.labels.atcLive}`;
  return props.labels[id];
}

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) menuOpen.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !menuOpen.value) return;
  menuOpen.value = false;
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
  <div class="map-overlay">
    <!-- 因为边界不完整而没画的块数。说的是「这张图缺了几块」。 -->
    <p v-if="partial" class="map-partial glass">{{ partial }}</p>

    <!-- 「这一层没有数据」/「你没有航行资料库权限」。和上一条分开，两者可能同时成立。 -->
    <p v-if="notice" class="map-notice glass" :data-notice="notice.layer">
      {{ notice.text }}
    </p>

    <!-- 只在自己真的连着线时出现；按下去没反应的按钮比没有更让人怀疑。 -->
    <button
      v-if="own"
      type="button"
      class="map-locate glass"
      :aria-label="text.locate"
      :title="text.locate"
      @click="emit('locate')"
    >
      <span aria-hidden="true">✈</span>
      <span class="font-mono">{{ own.callsign }}</span>
    </button>

    <div ref="root" class="map-layers">
      <!--
        没取到的那一层。它已经退回关了 —— 没有这一句，它就是安静地从图上消失，和
        「这一带没有数据」长得一模一样。
      -->
      <div v-if="failure" class="map-layer-failure glass" role="status">
        <span>{{ text.layerFailed.replace("{layer}", failureLabel(failure)) }}</span>
        <button type="button" class="link shrink-0" @click="emit('retry', failure)">
          {{ text.retry }}
        </button>
      </div>

      <div
        v-if="menuOpen"
        id="map-layer-menu"
        class="map-layer-menu glass"
        role="group"
        :aria-label="text.menu"
      >
        <button
          v-for="id in ORDER"
          :key="id"
          type="button"
          class="map-layer-btn"
          :class="on[id] ? 'is-on' : ''"
          :aria-pressed="on[id]"
          :disabled="isBusy(id)"
          @click="emit('toggle', id)"
        >
          {{ labels[id]
          }}<span v-if="id === 'atcLive' && on.atcLive && atcCount" class="map-layer-count">{{
            atcCount
          }}</span>
        </button>
      </div>

      <button
        ref="trigger"
        type="button"
        class="map-layer-trigger glass"
        :aria-expanded="menuOpen"
        aria-controls="map-layer-menu"
        @click="menuOpen = !menuOpen"
      >
        <Icon name="squaresPlus" class="size-4" />
        <span>{{ text.menu }}</span>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 11: Create `src/components/map/MapStage.vue`**

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
 * - `MapControls.vue` 图层菜单、提示、重试、「定位到我」
 *
 * 唯一的横向依赖是航路网：登记处开关它，航路层要在它变了之后重算高亮、并写回
 * 一个新对象。所以这份 ref 由这里持有，两边都拿到它，登记处在原来调
 * `refreshHighlight()` 的地方调 `onAirwaysChange`。
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
  ref,
} from "vue";
import type { FeatureCollection } from "geojson";
import MapControls from "@/components/map/MapControls.vue";
import { useLayerNotice, type LayerId } from "@/components/map/useLayerNotice";
import {
  useChartLayers,
  type LayerToggle,
  type Viewport,
} from "@/components/map/useChartLayers";
import { useGroundLayer } from "@/components/map/useGroundLayer";
import { useTrafficLayer } from "@/components/map/useTrafficLayer";
import { useRouteLayer } from "@/components/map/useRouteLayer";
import { DEFAULT_PREFS, readPrefs, type LayerPrefs } from "@/lib/mapPrefs";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
  /** 自己的 CAN ID。没登录是 null。见 useTrafficLayer：按 CID 认自己。 */
  cid: string | null;
  /** 九个图层开关的文案，已翻译。 */
  layerLabels: Record<LayerToggle, string>;
  /** 图层相关的几句话，已翻译。`partial` 带 `{n}`，`groundAccuracy` 带 `{m}`，
   *  `planOnMap` 带 `{from}` / `{to}`，`layerFailed` 带 `{layer}`。 */
  t: {
    partial: string;
    denied: string;
    emptyAirways: string;
    emptyNavaids: string;
    emptyGeneric: string;
    groundAccuracy: string;
    planOnMap: string;
    layersMenu: string;
    layerFailed: string;
    retry: string;
    locate: string;
  };
  /** 地图整个起不来时那两句，转交给 RouteMap。 */
  failureText: { init: string; webgl: string };
}>();

/** 见文件顶上。`mounted` 之前一律不渲染 RouteMap。 */
const mounted = ref(false);

const RouteMap = defineAsyncComponent({
  loader: () => import("@/components/RouteMap.vue"),
  // chunk 拉不下来时说话。默认行为是安静地什么都不渲染 —— 那和「地图是空的」在
  // 屏幕上长得一模一样。
  onError(error) {
    console.error("[efb] 地图组件加载失败:", error);
  },
});

const prefs: LayerPrefs = { ...DEFAULT_PREFS };
const notice = useLayerNotice(props.t.denied);
const airways = ref<FeatureCollection | null>(null);

const route = useRouteLayer({
  airways,
  text: { label: props.label, planOnMap: props.t.planOnMap },
});
const chart = useChartLayers({
  airways,
  notice,
  prefs,
  text: {
    emptyAirways: props.t.emptyAirways,
    emptyNavaids: props.t.emptyNavaids,
    emptyGeneric: props.t.emptyGeneric,
  },
  onAirwaysChange: route.refreshHighlight,
});
const groundLayer = useGroundLayer({
  notice,
  text: { groundAccuracy: props.t.groundAccuracy },
});
const live = useTrafficLayer({
  cid: props.cid,
  prefs,
  notice,
  loadFirCache: chart.loadFirCache,
});

/* 模板里只有顶层的 ref 会自动解包，所以把要用的拆出来。 */
const { points, markers, focus, label, highlightedLegs } = route;
const {
  shownFixes,
  airports,
  runways,
  navaids,
  firs,
  mora,
  airspaces,
  skippedTotal,
} = chart;
const { ground, groundAttribution } = groundLayer;
const { traffic, atc, atcAreas, own, ownTrack, atcCount, ownAt } = live;
const noticeLine = notice.notice;
const failedLayer = notice.failure;

const layerState = computed<Record<LayerToggle, boolean>>(() => ({
  airways: chart.showAirways.value,
  firs: chart.showFirs.value,
  navaids: chart.showNavaids.value,
  mora: chart.showMora.value,
  traffic: live.showTraffic.value,
  atcLive: live.showAtc.value,
  ctr: chart.showCtr.value,
  app: chart.showApp.value,
  restricted: chart.showRestricted.value,
}));

const busy = computed(() => ({
  airways: chart.airwayBusy.value,
  other: chart.layerBusy.value,
}));

const partial = computed(() =>
  skippedTotal.value
    ? props.t.partial.replace("{n}", String(skippedTotal.value))
    : null,
);

const ownButton = computed(() =>
  ownAt.value ? { callsign: ownAt.value.callsign } : null,
);

/** 视野变了：静态层按缩放补数据，地面层按视野补机场。两者互不相干。 */
function onViewport(v: Viewport) {
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
    default:
      void chart.toggleAirspace(id);
  }
}

function onRetry(id: LayerId) {
  if (id === "live") void live.refreshLive();
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

onMounted(() => {
  mounted.value = true;
  // 按偏好把图层打开 —— 这是「打开就看到航图」的那一步。不 await：地图不该等航路网
  // 下载完才出现。
  const saved = readPrefs();
  Object.assign(prefs, saved);
  chart.restore(saved);
  live.start(saved);
  route.start();
});

onBeforeUnmount(() => {
  // 这块地图是 `transition:persist` 的，一般走不到这里；真走到了而定时器和监听器
  // 还活着，就是一个谁也看不见的泄漏。
  route.stop();
  live.stop();
});
</script>

<template>
  <section class="app-map" :aria-label="label">
    <!-- `points` 为空也照样渲染：空点集只画底图，不会抛。 -->
    <RouteMap
      v-if="mounted"
      :points="points"
      :markers="markers"
      :focus="focus"
      :airways="airways"
      :airway-fixes="shownFixes"
      :airports="airports"
      :runways="runways"
      :highlighted-legs="highlightedLegs"
      :ground="ground"
      :extra-attribution="groundAttribution"
      :navaids="navaids"
      :firs="firs"
      :mora="mora"
      :traffic="traffic"
      :atc="atc"
      :atc-areas="atcAreas"
      :own="own"
      :own-track="ownTrack"
      :airspaces="airspaces"
      :label="label"
      :failure-text="failureText"
      :firs-label="layerLabels.firs"
      class="h-full"
      @viewport="onViewport"
    />
    <!-- 水合之前的占位：没有它，首屏这一整块是空的，等 JS 到了才突然出现地图。 -->
    <div v-else class="surface-grid h-full"></div>

    <MapControls
      :labels="layerLabels"
      :text="{
        menu: t.layersMenu,
        retry: t.retry,
        locate: t.locate,
        layerFailed: t.layerFailed,
      }"
      :on="layerState"
      :busy="busy"
      :atc-count="atcCount"
      :partial="partial"
      :notice="noticeLine"
      :failure="failedLayer"
      :own="ownButton"
      @toggle="onToggle"
      @retry="onRetry"
      @locate="locateOwn"
    />
  </section>
</template>
```

- [ ] **Step 12: Update `AppLayout.astro` and delete `MapSurface.vue`**

In `src/layouts/AppLayout.astro`: line 27 becomes `import MapStage from "@/components/map/MapStage.vue";`. In lines 104–133 rename the tag to `MapStage` and extend the `t` object with four entries after `planOnMap` (line 114):

```astro
        layersMenu: t("map.layersMenu"),
        layerFailed: t("map.layerFailed"),
        retry: t("common.retry"),
        locate: t("map.locate"),
```

Run: `git rm src/components/MapSurface.vue`

- [ ] **Step 13: CSS**

In `src/styles/globals.css`, replace lines 282–384 (from the `/* 航路图层开关。` comment to the end of the file) with:

```css
/* ---------------------------------------------------------------------------
   玻璃材质。轨、面板、地图上的控件共用这一个类。

   取的是 can-ui 的材质令牌（`--material-regular` 那一组），深浅两套由令牌自己换，
   这里不另写颜色。退路有两条，都退回 can-ui 的实心浮层色：浏览器不支持
   backdrop-filter 时，一层 78% 不透明的底色压在地图上会让字直接落在航路线上；
   成员要求减少透明度时，照 can-ui 自己的规矩整个去掉模糊，而不是留一层弱模糊。
   --------------------------------------------------------------------------- */
.glass {
  background-color: var(--material-regular);
  -webkit-backdrop-filter: saturate(var(--material-saturate))
    blur(var(--material-blur-regular));
  backdrop-filter: saturate(var(--material-saturate))
    blur(var(--material-blur-regular));
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-popover);
}
@supports not (
  (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))
) {
  .glass {
    background-color: var(--surface-overlay);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .glass {
    background-color: var(--surface-overlay);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

/* 地图上的覆盖层。铺在地图**露出来的那一块**上：`--map-pad-*` 由 MapStage 按面板
   位置写（Task 7 之前都是 0）。自己不接指针 —— 压在地图上能挡住拖动的东西就是一
   个看不出原因的死角 —— 里面的控件各自接。 */
.map-overlay {
  position: absolute;
  z-index: 2;
  top: var(--map-pad-top, 0px);
  right: var(--map-pad-right, 0px);
  bottom: var(--map-pad-bottom, 0px);
  left: var(--map-pad-left, 0px);
  pointer-events: none;
  transition:
    left 240ms ease,
    bottom 240ms ease;
}
.map-overlay > * {
  pointer-events: auto;
}

/* 「有 n 块边界不完整没画」。贴在可见区上沿居中：它说的是整张图缺了东西。 */
.map-partial {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(28rem, calc(100% - 8rem));
  padding: 0.25rem 0.6rem;
  border-radius: var(--radius-control);
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--color-muted);
  text-align: center;
}

/* 「这一层没有数据」/「没有航行资料库权限」。排在上一条下面，比它显眼一点。 */
.map-notice {
  position: absolute;
  top: 2.5rem;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(30rem, calc(100% - 8rem));
  padding: 0.375rem 0.75rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-ink);
  text-align: center;
}

/* 「定位到我」。放在缩放控件下面：它是改变视野的动作，和 +/- 同一类。 */
.map-locate {
  position: absolute;
  top: 5.25rem;
  left: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.45rem;
  border-radius: var(--radius-control);
  font-size: 0.6875rem;
  color: var(--color-ink);
}
.map-locate:hover {
  background: var(--surface-overlay);
}

/* 图层菜单和失败提示，从可见区左下角往上长。 */
.map-layers {
  position: absolute;
  left: 0.5rem;
  bottom: 0.5rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.375rem;
  max-width: calc(100% - 1rem);
}
.map-layer-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.3rem 0.6rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  color: var(--color-ink);
}
.map-layer-menu {
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
  max-width: 22rem;
  padding: 0.25rem;
  border-radius: var(--radius-card);
}
.map-layer-btn {
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border-radius: 0.25rem;
  color: var(--color-muted);
}
.map-layer-btn:hover:not(:disabled) {
  background: var(--surface-overlay);
}
.map-layer-btn.is-on {
  background: var(--surface-overlay);
  color: var(--color-ink);
}
.map-layer-btn:disabled {
  opacity: 0.5;
}
/* 在线管制席位数。「现在有没有人管」是开图第一眼要的答案之一。 */
.map-layer-count {
  margin-left: 0.35rem;
  padding: 0 0.3rem;
  border-radius: 0.5rem;
  background: var(--color-can, #4a7fa3);
  color: #fff;
  font-size: 0.65rem;
  font-variant-numeric: tabular-nums;
}
/* 没取到的那一层。小，但带一个能按的重试。 */
.map-layer-failure {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: 22rem;
  padding: 0.3rem 0.6rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  color: var(--color-ink);
}
```

- [ ] **Step 14: Dictionaries**

Add under `efb.map` in each file, after `planOnMap`:

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `map.layersMenu` | `图层` | `圖層` | `Layers` | `レイヤー` |
| `map.layerFailed` | `「{layer}」没取到，图上这一层是空的。` | `「{layer}」沒取到，圖上這一層是空的。` | `Couldn't load {layer}; that layer is empty on the map.` | `「{layer}」を取得できませんでした。地図上のこのレイヤーは空です。` |
| `map.locate` | `定位到我的飞机` | `定位到我的飛機` | `Center on my aircraft` | `自機を中央に表示` |

- [ ] **Step 15: Gate**

Run: `bunx prettier --write src/lib/mapPrefs.ts src/lib/mapPrefs.test.ts src/components/map src/layouts/AppLayout.astro src/styles/globals.css language && bun run lint && bun run build`
Expected: exit 0. `git grep -n MapSurface -- src` prints only comments that name the old file as history (in `useChartLayers.ts` etc.); no import.

- [ ] **Step 16: Browser check**

`bun run dev`, open `/` at ≥1152px, ~900px, ~390px, light and dark:
- Airways, FIRs, navaids, traffic and ATC come up per saved preferences (clear `localStorage["efb.map.layers"]` once to see defaults).
- The 图层 button opens the menu; each toggle works; ATC shows the controller count.
- In devtools, block `/api/db/aip/navaids` and toggle 导航台 on: it reverts to off and the corner shows 「导航台」没取到 … 重试. Unblock, press 重试: the layer comes on and the notice goes away.
- Block `fsd.ceruleanavi.net`: after the next 30s tick the 机组 · 管制 failure notice appears and aircraft stay where they were.

- [ ] **Step 17: Commit**

```bash
git add -A src/lib/mapPrefs.ts src/lib/mapPrefs.test.ts src/components/map src/components/MapSurface.vue src/layouts/AppLayout.astro src/styles/globals.css language
perl -e 'alarm 40; exec @ARGV' git commit -m "MapSurface 拆成 MapStage、四个图层 composable 和 MapControls；没取到的图层在角上给重试" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Split `RouteMap.vue`; padding and `map:focus` in the map

**Files:**
- Create: `src/lib/routeGeometry.ts`, `src/lib/routeGeometry.test.ts`
- Create: `src/components/map/basemap.ts`, `attribution.ts`, `camera.ts`
- Move: `src/components/RouteMap.vue` → `src/components/map/RouteMap.vue` (`git mv`), then edit
- Modify: `src/components/map/MapStage.vue` (loader path), `useRouteLayer.ts` (focus type, `map:focus`), `useTrafficLayer.ts` (`locateTarget`)
- Modify: `src/lib/mapBus.ts` lines 47–53 (drop `MapPayload.focus`)
- Modify: `src/components/Airports.vue` lines 17–19, 91–106 (use `focusMap`)

**Interfaces:**
- Consumes: `MapFocus`, `focusMap`, `subscribeMapFocus` (Task 3); `MapPadding` (Task 1).
- Produces:
  ```ts
  // lib/routeGeometry.ts
  export interface RoutePoint { ident: string; lat: number; lon: number; kind: number | string; via?: string; onRoute?: boolean }
  export function routeLines(points: RoutePoint[], onAirway?: Set<string> | null): FeatureCollection;
  export function pointFeatures(points: RoutePoint[]): FeatureCollection;
  // map/basemap.ts
  export function createBasemapLoader(getMap: () => MapLibreMap | null): { loadLand(): Promise<void>; loadDetail(): Promise<void> };
  // map/attribution.ts
  export function createAttribution(getMap: () => MapLibreMap | null, source: () => { firsLabel: string; extra: string[] }): { apply(): void };
  // map/camera.ts
  export interface Camera { applyFocus(focus: MapFocus | null): boolean; fitPoints(points: RoutePoint[]): void; setPadding(padding: MapPadding): void }
  export function createCamera(getMap: () => MapLibreMap | null): Camera;
  // RouteMap.vue new props
  focus?: MapFocus | null;
  padding?: MapPadding | null;
  ```

**Behaviour that must survive (RouteMap.vue at `29b690d`):**
- Worker URL set at module top, 64–86.
- `setSource` skips unchanged references; route and marker collections are memoised, 548–642.
- Focus moves the camera only when the focus object changes; points are fitted only when their signature changes, 644–687.
- Plan legs handed to the airway network are kept with `onAirway: 1`, not dropped, 357–374.
- Attribution top-right, escaped extra lines, re-created on change, 472–517, 911–915.
- Detail basemap loads once at `ZOOM.borders`, concurrent calls blocked, failures retried on next move, 689–727.
- Init failure shows the translated message with `data-failure`, 295–317, 749–816, 945–947.

- [ ] **Step 1: Write the failing test for `routeGeometry`**

`src/lib/routeGeometry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { legKey } from "@/lib/airways";
import {
  pointFeatures,
  routeLines,
  type RoutePoint,
} from "@/lib/routeGeometry";

const route: RoutePoint[] = [
  { ident: "ZBAA", lat: 40.08, lon: 116.58, kind: "airport" },
  { ident: "ELKUR", lat: 39.8, lon: 117.2, kind: "sid", via: "ELKU4K" },
  { ident: "SASAN", lat: 38.0, lon: 118.0, kind: "fix", via: "A461" },
  { ident: "ZSSS", lat: 31.2, lon: 121.3, kind: "airport", via: "DCT" },
];

/**
 * 一条腿被丢掉只是图上少一截线，剩下的都画得好好的 —— 看不出来。所以腿数、每条腿
 * 的样式归属、交给航路网的那几条还在不在，都钉住。
 */
describe("routeLines", () => {
  test("n 个点 n-1 条腿，样式取自到达的那个点", () => {
    const lines = routeLines(route);
    expect(lines.features).toHaveLength(3);
    expect(lines.features.map((f) => f.properties?.procedure)).toEqual([
      1, 0, 0,
    ]);
    expect(lines.features.map((f) => f.properties?.via)).toEqual([
      "ELKU4K",
      "A461",
      "DCT",
    ]);
  });

  test("航路网点亮了的腿仍在集合里，只标上 onAirway", () => {
    const lines = routeLines(
      route,
      new Set([legKey("A461", "ELKUR", "SASAN")]),
    );
    expect(lines.features).toHaveLength(3);
    expect(lines.features.map((f) => f.properties?.onAirway)).toEqual([
      0, 1, 0,
    ]);
  });

  test("坐标是 [经, 纬]，首尾落在两个端点上", () => {
    const coords = (
      routeLines(route).features[2].geometry as { coordinates: number[][] }
    ).coordinates;
    expect(coords[0][0]).toBeCloseTo(118.0, 3);
    expect(coords[0][1]).toBeCloseTo(38.0, 3);
    expect(coords[coords.length - 1][0]).toBeCloseTo(121.3, 3);
    expect(coords[coords.length - 1][1]).toBeCloseTo(31.2, 3);
  });

  test("不到两个点就没有线", () => {
    expect(routeLines(route.slice(0, 1)).features).toEqual([]);
  });
});

/** 只有航路上的点该标名字；全国几百个机场都标上就是一团糊。 */
describe("pointFeatures", () => {
  test("onRoute 和 airport 两个标记", () => {
    const features = pointFeatures([
      { ...route[0], onRoute: true },
      { ident: "ZSPD", lat: 31.14, lon: 121.8, kind: "airport" },
      { ...route[2], onRoute: true },
    ]).features;
    expect(features.map((f) => f.properties)).toEqual([
      { ident: "ZBAA", airport: 1, onRoute: 1 },
      { ident: "ZSPD", airport: 1, onRoute: 0 },
      { ident: "SASAN", airport: 0, onRoute: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/routeGeometry.test.ts`
Expected: FAIL — `Cannot find module '@/lib/routeGeometry'`.

- [ ] **Step 3: Implement `src/lib/routeGeometry.ts`**

```ts
/**
 * 航路在图上的几何：一条腿一条大圆弧线，一个点一个点要素。
 *
 * 从 RouteMap.vue 搬出来，因为它是纯计算，而它错了不会被屏幕出卖：一条被丢掉的
 * 腿只是图上少一截线，剩下的看起来都对（见 routeLines 上面那段）。
 */
import type { Feature, FeatureCollection } from "geojson";
import { arc, type LatLon } from "@/lib/geo";
import { legKey } from "@/lib/airways";

/* RouteMap.vue 121–135 的 `Point`，改名 RoutePoint 并 export，注释原样。 */
export interface RoutePoint {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
  onRoute?: boolean;
}

export function routeLines(
  points: RoutePoint[],
  onAirway?: Set<string> | null,
): FeatureCollection {
  /* RouteMap.vue 379–412 的函数体原样。 */
}

export function pointFeatures(points: RoutePoint[]): FeatureCollection {
  /* RouteMap.vue 416–430 的函数体原样。 */
}
```

Carry the doc comments: `onRoute` field doc (127–134) onto `onRoute`; the two blocks 345–374 above `routeLines`. In the two function bodies, replace the `/* … 原样 */` comment with the listed original lines; the only change is `Point` → `RoutePoint` in the `isProcedure` parameter.

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/routeGeometry.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Create `src/components/map/basemap.ts`**

```ts
/**
 * 底图数据：1:50m 陆地一进来就拉，1:10m 陆地和国界放大到用得上才拉。
 *
 * 从 RouteMap.vue 搬来。两份状态（缓存、是否已拉、是否在拉）按地图实例各一份，所
 * 以是一个工厂而不是模块级变量 —— 和原来 `<script setup>` 里的写法同一个作用域。
 */
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { ZOOM } from "@/lib/chartStyle";
/* RouteMap.vue 263–290：三行 `?url` import 和它们上面的注释，原样。 */

export function createBasemapLoader(getMap: () => MapLibreMap | null) {
  let landCache: unknown = null;
  let detailLoaded = false;
  let detailPending = false;

  async function loadDetail() {
    const map = getMap();
    if (detailLoaded || detailPending || !map) return;
    if (map.getZoom() < ZOOM.borders) return;
    detailPending = true;
    try {
      const [land, borders] = await Promise.all([
        fetch(LAND_DETAIL_URL).then((r) => (r.ok ? r.json() : null)),
        fetch(BORDERS_URL).then((r) => (r.ok ? r.json() : null)),
      ]);
      const current = getMap();
      if (!current) return;
      if (land) {
        (current.getSource("landDetail") as GeoJSONSource | undefined)?.setData(
          land,
        );
      }
      if (borders) {
        (current.getSource("borders") as GeoJSONSource | undefined)?.setData(
          borders,
        );
      }
      if (land && borders) detailLoaded = true;
    } catch (error) {
      // 和底图同一条：静默降级成没有细节，但日志里留一行。
      console.error("[efb] 细节底图加载失败:", error);
    } finally {
      detailPending = false;
    }
  }

  async function loadLand() {
    try {
      if (!landCache) {
        const response = await fetch(LAND_URL);
        if (!response.ok) return;
        landCache = await response.json();
      }
      const map = getMap();
      if (!map) return;
      (map.getSource("land") as GeoJSONSource | undefined)?.setData(
        landCache as FeatureCollection,
      );
    } catch (error) {
      /* RouteMap.vue 740–744 的注释原样。 */
      console.error("[efb] 底图数据加载失败:", error);
    }
  }

  return { loadLand, loadDetail };
}
```

Carry the doc comment 689–700 above `loadDetail`.

- [ ] **Step 6: Create `src/components/map/attribution.ts`**

```ts
/**
 * 署名控件。VATSpy 是 CC BY-SA 4.0，**署名是许可条款不是装饰**；OSM 那份地面数据
 * 是 ODbL，同样。从 RouteMap.vue 472–517 搬来，注释原样。
 */
import { AttributionControl, type Map as MapLibreMap } from "maplibre-gl";
import { escapeHtml } from "@/lib/mapText";

export function createAttribution(
  getMap: () => MapLibreMap | null,
  source: () => { firsLabel: string; extra: string[] },
) {
  let control: AttributionControl | null = null;

  function baseAttribution(firsLabel: string): string {
    return (
      `${escapeHtml(firsLabel)} ` +
      '<a href="https://github.com/vatsimnetwork/vatspy-data-project" ' +
      'target="_blank" rel="noreferrer">VATSpy</a> (CC BY-SA 4.0) · ' +
      "Natural Earth"
    );
  }

  function apply() {
    const map = getMap();
    if (!map) return;
    if (control) {
      map.removeControl(control);
      control = null;
    }
    const { firsLabel, extra } = source();
    /* RouteMap.vue 509–510 的注释原样。 */
    const lines = extra.filter(Boolean).map(escapeHtml);
    control = new AttributionControl({
      compact: true,
      customAttribution: [baseAttribution(firsLabel), ...lines].join(" · "),
    });
    map.addControl(control, "top-right");
  }

  return { apply };
}
```

- [ ] **Step 7: Create `src/components/map/camera.ts`**

```ts
/**
 * 镜头：对焦、框选、内边距。
 *
 * 从 RouteMap.vue 543–546、644–687 搬来，再加上 `setPadding`。三件事共享一个前
 * 提 —— **只在输入真的变了的时候动镜头**：render() 被实时数据每 30 秒触发一次，
 * 每次都动镜头的话，正在平移或放大看机场的人会被一次次拽回去，以为地图坏了。
 */
import { LngLatBounds, type Map as MapLibreMap } from "maplibre-gl";
import { prefersReducedMotion } from "@jianyuelab-org/can-ui/motion";
import type { MapFocus } from "@/lib/mapBus";
import type { MapPadding } from "@/lib/panelLayout";
import type { RoutePoint } from "@/lib/routeGeometry";

export interface Camera {
  /** 有焦点就对过去（只在焦点对象换了的时候），并返回 true，调用方据此不再框选。 */
  applyFocus(focus: MapFocus | null): boolean;
  /** 把这批点框进可见区（只在这批点换了的时候）。 */
  fitPoints(points: RoutePoint[]): void;
  /** 面板盖住了哪一块。地图还没起来时先记着，起来之后由调用方再给一次。 */
  setPadding(padding: MapPadding): void;
}

export function createCamera(getMap: () => MapLibreMap | null): Camera {
  let lastFocus: MapFocus | null = null;
  let lastFitted = "";
  let lastPadding = "";

  function applyFocus(focus: MapFocus | null): boolean {
    const map = getMap();
    if (!map) return false;
    if (!focus) {
      lastFocus = null;
      return false;
    }
    if (focus === lastFocus) return true;
    lastFocus = focus;
    if (focus.kind === "point") {
      map.easeTo({
        center: [focus.lon, focus.lat],
        zoom: Math.max(map.getZoom(), focus.zoom ?? 7),
      });
    } else {
      map.fitBounds(
        [
          [focus.west, focus.south],
          [focus.east, focus.north],
        ],
        { padding: 48, maxZoom: 10 },
      );
    }
    return true;
  }

  function fitPoints(points: RoutePoint[]) {
    const map = getMap();
    if (!map) return;
    /* RouteMap.vue 661–686 原样，`all` 换成 `points`。 */
  }

  function setPadding(padding: MapPadding) {
    const map = getMap();
    if (!map) return;
    const key = `${padding.top},${padding.right},${padding.bottom},${padding.left}`;
    if (key === lastPadding) return;
    lastPadding = key;
    // 面板开合、抽屉拖动时内容跟着滑到新的中心，而不是跳过去。减少动态效果时直接到位。
    map.easeTo({ padding, duration: prefersReducedMotion() ? 0 : 240 });
  }

  return { applyFocus, fitPoints, setPadding };
}
```

In `fitPoints`, the pasted 661–686 block starts with the `**航路网不参与框选**` comment and uses `all`; rename to `points`.

- [ ] **Step 8: Move and edit `RouteMap.vue`**

Run: `git mv src/components/RouteMap.vue src/components/map/RouteMap.vue`

Edits to `src/components/map/RouteMap.vue`, bottom-up (original line numbers):

1. Line 920: delete `window.removeEventListener("resize", syncScrollZoom);`.
2. After line 915 add:
   ```ts

   /* 面板开合、抽屉拖动、换页换宽度都会改内边距。深比：MapStage 每次给的是新对象，
      而数值没变时不该再 easeTo 一次（camera 里还有一道闸）。 */
   watch(
     () => props.padding,
     (padding) => {
       if (padding) camera.setPadding(padding);
     },
     { deep: true },
   );
   ```
3. Line 913: `applyAttribution` → `attribution.apply`.
4. Line 862: delete `window.addEventListener("resize", syncScrollZoom);`.
5. Line 855: `void loadLand();` → `void basemap.loadLand();`. Before line 852 (`render();`) add `if (props.padding) camera.setPadding(props.padding);`.
6. Line 829: `applyAttribution();` → `attribution.apply();`.
7. Lines 793–804: replace with
   ```ts
         // 滚轮缩放恒开：地图铺满视口，页面本身不滚，不存在「滚轮停在地图上把页
         // 面卡住」那回事了。以前这里问 CSS 的 `--shell-layout`，那个变量随三栏外壳
         // 一起删了。
         scrollZoom: true,
   ```
8. Lines 689–747 (`loadDetail`, `loadLand` and their comments): delete.
9. Lines 644–686: replace with
   ```ts
     if (camera.applyFocus(props.focus ?? null)) return;
     camera.fitPoints([...points, ...markers]);
   ```
10. Lines 543–546 (`lastFocus`, `lastFitted`): delete.
11. Lines 472–517 (`baseAttribution`, `attributionControl`, `applyAttribution`): delete.
12. Line 458: `void loadDetail();` → `void basemap.loadDetail();`.
13. Lines 345–431 (`routeLines`, `pointFeatures` and their comments): delete.
14. Line 322 (`let landCache`): replace with
    ```ts
    const basemap = createBasemapLoader(() => map);
    const attribution = createAttribution(
      () => map,
      () => ({
        firsLabel: props.firsLabel,
        extra: props.extraAttribution ?? [],
      }),
    );
    const camera = createCamera(() => map);
    ```
15. Lines 263–290 (`?url` imports and comment): delete.
16. Props: line 149 `points: Point[];` → `points: RoutePoint[];`, line 150 `markers?: Point[];` → `markers?: RoutePoint[];`, line 151 `focus?: Point | null;` →
    ```ts
      /**
       * 镜头焦点（`lib/mapBus.ts` 的 `MapFocus`）。按**引用**判断变没变：同一个对象
       * 留着不会再动镜头，新对象才会 —— 所以「定位到我」每次都造一个新的。
       */
      focus?: MapFocus | null;
      /** 面板盖住的那一块，MapStage 由 `panel:layout` 换算。 */
      padding?: MapPadding | null;
    ```
17. Lines 121–135 (`interface Point`): delete.
18. Lines 88–119 (`shellIsColumns`, `syncScrollZoom`): delete.
19. Imports 39–62 become:
    ```ts
    import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
    import {
      Map as MapLibreMap,
      NavigationControl,
      ScaleControl,
      setWorkerUrl,
      type GeoJSONSource,
    } from "maplibre-gl";
    import "maplibre-gl/dist/maplibre-gl.css";
    // eslint-disable-next-line import/no-unresolved -- Vite 的 worker 后缀，不是真实路径
    import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
    import type { FeatureCollection } from "geojson";
    import { formatLatLon } from "@/lib/mapText";
    import { buildStyle, themedProperties, type Theme } from "@/lib/chartStyle";
    import { registerChartIcons } from "@/lib/chartIcons";
    import type { MapFocus } from "@/lib/mapBus";
    import type { MapPadding } from "@/lib/panelLayout";
    import {
      pointFeatures,
      routeLines,
      type RoutePoint,
    } from "@/lib/routeGeometry";
    import { createBasemapLoader } from "@/components/map/basemap";
    import { createAttribution } from "@/components/map/attribution";
    import { createCamera } from "@/components/map/camera";
    ```
20. In the header comment (lines 1–38) replace the `## 样式在 lib/chartStyle.ts` paragraph's neighbour `## 契约没变` (34–37) with:
    ```
     * ## 拆成了几块
     *
     * 纯几何在 `lib/routeGeometry.ts`，底图取数在 `map/basemap.ts`，署名在
     * `map/attribution.ts`，镜头（对焦、框选、内边距）在 `map/camera.ts`。这个文件
     * 只剩构造地图、灌 source、切主题。
    ```
21. Inside `render()` (original 593–642), the memo types `unknown` stay; `routeLines(points, props.highlightedLegs)` and `pointFeatures([...])` now resolve to the imports.

- [ ] **Step 9: Point the rest at the new pieces**

- `src/components/map/MapStage.vue`: loader becomes `() => import("@/components/map/RouteMap.vue")`.
- `src/components/map/useTrafficLayer.ts`: import `type MapFocus` from `@/lib/mapBus` instead of `type MapPoint`; `locateTarget(): MapFocus | null` returns `{ kind: "point", lat: at.lat, lon: at.lon }`.
- `src/components/map/useRouteLayer.ts`:
  - import `subscribeMapFocus, type MapFocus` from `@/lib/mapBus`;
  - `const focus = ref<MapFocus | null>(null);`
  - in the `subscribeToMap` handler, the pasted line `focus.value = payload.focus ?? null;` becomes `focus.value = null;` with the comment `// 面板换了内容：旧焦点作废，否则 RouteMap 一直当它是「在挑一个看」而不框选新内容。`
  - add `let unsubscribeFocus: (() => void) | null = null;`; in `start()` after `subscribeToMap(...)`: `unsubscribeFocus = subscribeMapFocus((target) => { focus.value = target; });`; in `stop()`: `unsubscribeFocus?.(); unsubscribeFocus = null;`.
- `src/lib/mapBus.ts`: delete lines 47–53 (`focus?: MapPoint;` and its comment).
- `src/components/Airports.vue`: line 19 imports `focusMap, publishToMap`; lines 91–106 become:
  ```ts
  /**
   * 挑中一个机场：**只推那一个**，不铺全量，再把镜头对过去。
   *
   * 先推点、再对焦，顺序是要紧的：地图收到新的点会把旧焦点作废（否则它不框选新内
   * 容），对焦要落在那之后。
   */
  function showOnMap(airport: Airport) {
    publishToMap({
      markers: [toMarker(airport)],
      label: airport.name ? `${airport.icao} · ${airport.name}` : airport.icao,
    });
    focusMap({ kind: "point", lat: airport.lat, lon: airport.lon, zoom: 10 });
  }
  ```
  Keep the paragraph of the old comment explaining why only one airport is pushed (lines 94–98) inside the new comment.

- [ ] **Step 10: Gate**

Run: `bunx prettier --write src/lib/routeGeometry.ts src/lib/routeGeometry.test.ts src/components/map src/lib/mapBus.ts src/components/Airports.vue && bun run lint && bun run build`
Expected: exit 0. `ls dist/client/_astro | grep -i worker` still lists one `maplibre-gl-worker` file (RouteMap.vue 77–81: the proof that the worker is bundled).

- [ ] **Step 11: Browser check**

`bun run dev`, ≥1152px, ~900px, ~390px, light and dark:
- `/`: the filed plan draws and the map fits it once; pan away and wait 30s: the camera does not snap back.
- `/airports`: search `ZSSS`, pick it: map eases to Shanghai at z10 with one marker.
- ✈ locate button (while connected): eases to own aircraft; press twice: both work.
- Theme toggle: all layers switch colours; attribution top-right lists VATSpy.
- Zoom past `ZOOM.borders`: detail land and borders appear (Network tab shows `land-10m` and `borders-10m` once).

- [ ] **Step 12: Commit**

```bash
git add -A src/lib/routeGeometry.ts src/lib/routeGeometry.test.ts src/components/map src/components/RouteMap.vue src/lib/mapBus.ts src/components/Airports.vue
perl -e 'alarm 40; exec @ARGV' git commit -m "RouteMap 拆出几何、底图、署名、镜头；地图接 map:focus 和内边距" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: Route lines in avionics magenta

**Files:**
- Modify: `src/lib/chartStyle.ts` lines 107, 144
- Modify: `src/lib/chartStyle.test.ts` lines 10–22 (import), append a `describe`

**Interfaces:**
- Consumes: `COLORS` from `lib/chartStyle.ts`.
- Produces: `COLORS.light.route = "#c8189f"`, `COLORS.dark.route = "#ff4fd8"`.

- [ ] **Step 1: Write the failing test**

Add `COLORS,` to the import list at `src/lib/chartStyle.test.ts` lines 10–22. Append:

```ts
/**
 * 计划航线用航电里的品红：PFD / ND 上现用航路就是这个颜色，飞行员不用学新图例。
 * 以前是紫色（色相约 291°）。这里只钉色相落在品红那一段（305–325°），两套主题
 * 各验一次；和别的图层分不分得开，靠浏览器里看，不靠这个测试。
 */
describe("计划航线是品红", () => {
  function hue(hex: string): number {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h =
      max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  test.each(["light", "dark"] as const)("%s 主题色相在 305–325°", (theme) => {
    const h = hue(COLORS[theme].route);
    expect(h).toBeGreaterThanOrEqual(305);
    expect(h).toBeLessThanOrEqual(325);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/chartStyle.test.ts`
Expected: FAIL — `light 主题色相在 305–325°`: `Expected: >= 305, Received: 291.3…`.

- [ ] **Step 3: Implement**

`src/lib/chartStyle.ts` line 107: `route: "#c8189f",`; line 144: `route: "#ff4fd8",`. Add above line 107:

```ts
    // 计划航线：航电品红。深浅两套同色相，只调明度，和这张表别的语义色一个规矩。
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/chartStyle.test.ts`
Expected: PASS (all previous tests plus 2).

- [ ] **Step 5: Gate**

Run: `bunx prettier --write src/lib/chartStyle.ts src/lib/chartStyle.test.ts && bun run lint && bun run build`
Expected: exit 0 (`check:style` prints ok for both themes).

- [ ] **Step 6: Browser check**

`bun run dev`, `/` in light and dark at ≥1152px: the filed plan line and its airway labels are magenta; restricted-area hatching is still distinguishable next to it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/chartStyle.ts src/lib/chartStyle.test.ts
perl -e 'alarm 40; exec @ARGV' git commit -m "计划航线改用航电品红" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: `FloatingPanel`, panel controller, full-bleed shell

**Files:**
- Create: `src/components/FloatingPanel.astro`
- Create: `src/lib/panelController.ts`
- Modify: `src/styles/globals.css` lines 64–280 (replaced; lines 1–63 and the Task 4 block after 281 stay)
- Modify: `src/layouts/AppLayout.astro` (whole file)
- Modify: `src/components/map/MapStage.vue` (padding subscription, `.map-stage`)
- Modify: `src/pages/index.astro`, `flightplan.astro`, `route.astro`, `airports.astro`, `settings.astro`, `404.astro` (drop `PageHeader`, pass `panel`)
- Modify: `language/*.json` (`efb.panel.*`)

**Interfaces:**
- Consumes: `announcePanelLayout`, `subscribePanelLayout` (Task 3); `parseShellMode`, `mapPaddingFor`, `PanelWidth`, `MapPadding` (Task 1); `initialSnap`, `sheetOffsets`, `snapAfterDrag`, `SHEET_PEEK_PX` (Task 2); `RouteMap` `padding` prop (Task 5).
- Produces:
  ```ts
  // lib/panelController.ts
  export function mountPanel(): void;   // on astro:page-load
  export function unmountPanel(): void; // on astro:before-swap
  ```
  ```astro
  <!-- FloatingPanel.astro -->
  interface Props { width: PanelWidth; title: string; description?: string; labels: { collapse: string; expand: string; handle: string } }
  <!-- AppLayout.astro -->
  interface Props { title: string; description?: string; panel?: PanelWidth } // panel defaults to "standard"
  ```
  DOM contract: `[data-floating-panel]` with `data-width`, `data-collapsed`, `data-sheet`; `[data-panel-body]`, `[data-panel-toggle]` (`data-label-collapse`, `data-label-expand`), `[data-panel-handle]`.

**Behaviour that must survive:**
- Skip link targets `#main-content` with `tabindex="-1"` (AppLayout.astro 72).
- Beian line at the bottom of the scrolling panel, not on the map (AppLayout.astro 76–90).
- `MapStage` stays `client:load transition:persist` (AppLayout.astro 93–133).
- Only the `efb` namespace goes into islands (AppLayout.astro 22–24).

- [ ] **Step 1: Dictionaries**

Add `efb.panel` in all four files (after `efb.search`):

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `panel.collapse` | `收起面板` | `收起面板` | `Collapse panel` | `パネルを畳む` |
| `panel.expand` | `展开面板` | `展開面板` | `Expand panel` | `パネルを開く` |
| `panel.handle` | `拖动或按方向键调整面板高度` | `拖動或按方向鍵調整面板高度` | `Drag, or use the arrow keys, to resize the panel` | `ドラッグまたは矢印キーでパネルの高さを変更` |

- [ ] **Step 2: `src/lib/panelController.ts`**

```ts
/**
 * 浮动面板的行为：桌面和平板上折叠成一条，手机上是三档的底部抽屉，以及随时把自
 * 己盖住了哪一块告诉地图（`panel:layout`）。
 *
 * 面板是 Astro 渲染的静态 HTML，里面装着各页自己的岛屿 —— 把整页塞进一个 Vue 岛
 * 屿，正是轨当初避开的水合代价。所以行为写成这一段普通脚本：每次
 * `astro:page-load`（首屏和每次换页都会发）挂一次，`astro:before-swap` 拆一次。
 *
 * 纯计算在 `lib/panelLayout.ts` 和 `lib/sheet.ts`；这里只碰 DOM。
 */
import {
  prefersReducedMotion,
  rubberbandClamp,
  VelocityTracker,
} from "@jianyuelab-org/can-ui/motion";
import { announcePanelLayout } from "@/lib/mapBus";
import {
  parseShellMode,
  type PanelWidth,
  type ShellMode,
} from "@/lib/panelLayout";
import {
  initialSnap,
  SHEET_PEEK_PX,
  sheetOffsets,
  snapAfterDrag,
  type SheetSnap,
} from "@/lib/sheet";

/** 手指移动超过这么多才算拖，之前的都当点按 —— 否则抽屉里的按钮点不动。 */
const DRAG_SLOP_PX = 6;

/**
 * 尺寸变化引起的位置播报合并成一次。窗口拖动、宽度过渡都会连着触发几十次
 * ResizeObserver，每一次都让地图 easeTo 一回，镜头会一直在抖。
 */
const ANNOUNCE_DEBOUNCE_MS = 80;

let teardown: (() => void) | null = null;

function readShellMode(): ShellMode {
  return parseShellMode(
    getComputedStyle(document.documentElement).getPropertyValue("--shell-mode"),
  );
}

export function unmountPanel(): void {
  teardown?.();
  teardown = null;
}

export function mountPanel(): void {
  unmountPanel();

  const found = document.querySelector<HTMLElement>("[data-floating-panel]");
  if (!found) return;
  const root: HTMLElement = found;
  const body = root.querySelector<HTMLElement>("[data-panel-body]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-panel-toggle]");
  const handle = root.querySelector<HTMLButtonElement>("[data-panel-handle]");
  const width: PanelWidth = root.dataset.width === "wide" ? "wide" : "standard";

  let mode = readShellMode();
  let snap: SheetSnap = initialSnap(width);
  let announceTimer: ReturnType<typeof setTimeout> | null = null;

  const geometry = () => ({ height: root.offsetHeight, peek: SHEET_PEEK_PX });

  function announce() {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = null;
    const r = root.getBoundingClientRect();
    announcePanelLayout({
      mode,
      collapsed:
        mode === "phone"
          ? snap === "collapsed"
          : root.dataset.collapsed === "true",
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }

  function scheduleAnnounce() {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(announce, ANNOUNCE_DEBOUNCE_MS);
  }

  /* ------------------------------------------------ 桌面 / 平板：折叠成一条 */

  function setCollapsed(next: boolean) {
    root.dataset.collapsed = String(next);
    // 收起时正文还在 DOM 里，只是看不见；inert 让键盘和读屏也跳过它，否则 Tab 会
    // 走进一块看不见的表单里。
    if (body) body.inert = next;
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(!next));
    const label = next
      ? toggle.dataset.labelExpand
      : toggle.dataset.labelCollapse;
    if (label) {
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
  }

  const onToggle = () => setCollapsed(root.dataset.collapsed !== "true");

  /* ------------------------------------------------ 手机：三档抽屉 */

  function applySnap(next: SheetSnap, animate = true) {
    snap = next;
    root.dataset.sheet = next;
    const moving = animate && !prefersReducedMotion();
    root.style.transition = moving ? "" : "none";
    root.style.setProperty(
      "--sheet-offset",
      `${sheetOffsets(geometry())[next]}px`,
    );
    if (body) body.inert = next === "collapsed";
    // 有动画时等 transitionend 再报位置；没有动画它就不会来，直接报。
    if (!moving) announce();
  }

  const tracker = new VelocityTracker();
  let pointerId: number | null = null;
  let startY = 0;
  let startOffset = 0;
  let dragging = false;
  let suppressClick = false;

  function onPointerDown(event: PointerEvent) {
    if (mode !== "phone" || event.button !== 0) return;
    // 拉满时只有把手能拖，正文留给滚动；没拉满时整张抽屉都能拖。
    if (snap === "full" && !handle?.contains(event.target as Node)) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startOffset = sheetOffsets(geometry())[snap];
    dragging = false;
    tracker.reset();
    tracker.add(0, event.clientY, event.timeStamp);
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      // 过了门槛才抓住指针：一开始就抓，按钮上的点按会被改投到面板上，按钮就点不动了。
      dragging = true;
      root.setPointerCapture(event.pointerId);
      root.style.transition = "none";
    }
    const g = geometry();
    const o = sheetOffsets(g);
    root.style.setProperty(
      "--sheet-offset",
      `${rubberbandClamp(startOffset + dy, o.full, o.collapsed, g.height)}px`,
    );
    tracker.add(0, event.clientY, event.timeStamp);
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    applySnap(
      snapAfterDrag(
        startOffset + (event.clientY - startY),
        tracker.velocity().y,
        geometry(),
      ),
    );
  }

  /** 拖完松手浏览器还会补一个 click；别让它落到把手上再翻一次档。 */
  function onClickCapture(event: MouseEvent) {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
    event.preventDefault();
  }

  /** 把手能点：一半 ↔ 拉满，收起时回到一半。 */
  function onHandleClick() {
    applySnap(snap === "half" ? "full" : "half");
  }

  /** 也能用方向键，拖不了的人一样能调。 */
  function onHandleKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      applySnap(snap === "collapsed" ? "half" : "full");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      applySnap(snap === "full" ? "half" : "collapsed");
    }
  }

  /** 抽屉没拉满时点进输入框就拉满：一半高度放不下键盘上面那一截。 */
  function onFocusIn(event: FocusEvent) {
    if (mode !== "phone" || snap === "full") return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches("input, textarea, select")
    ) {
      applySnap("full");
    }
  }

  /* ------------------------------------------------ 跨过断点 */

  function onResize() {
    const next = readShellMode();
    if (next !== mode) {
      mode = next;
      if (mode === "phone") {
        setCollapsed(false);
        applySnap(snap, false);
        return;
      }
      // 离开手机排布：抽屉那一套行内样式全部撤掉，交回给 CSS。
      root.style.removeProperty("--sheet-offset");
      root.style.transition = "";
      if (body) body.inert = root.dataset.collapsed === "true";
    }
    scheduleAnnounce();
  }

  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.target === root) announce();
  };
  const resizeObserver = new ResizeObserver(scheduleAnnounce);

  toggle?.addEventListener("click", onToggle);
  handle?.addEventListener("click", onHandleClick);
  handle?.addEventListener("keydown", onHandleKeydown);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  root.addEventListener("click", onClickCapture, true);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("transitionend", onTransitionEnd);
  window.addEventListener("resize", onResize);
  resizeObserver.observe(root);

  if (mode === "phone") applySnap(snap, false);
  else announce();

  teardown = () => {
    if (announceTimer) clearTimeout(announceTimer);
    toggle?.removeEventListener("click", onToggle);
    handle?.removeEventListener("click", onHandleClick);
    handle?.removeEventListener("keydown", onHandleKeydown);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", onPointerUp);
    root.removeEventListener("pointercancel", onPointerUp);
    root.removeEventListener("click", onClickCapture, true);
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("transitionend", onTransitionEnd);
    window.removeEventListener("resize", onResize);
    resizeObserver.disconnect();
  };
}
```

- [ ] **Step 3: `src/components/FloatingPanel.astro`**

```astro
---
/**
 * 浮在地图上的那张面板：当前页面的标题和内容。
 *
 * 宽度由页面声明（`width`）：`standard` 约 26rem，放列表和短表单；`wide` 约
 * 44rem，放两列表单（飞行计划、设置）。平板上 wide 退回 standard，手机上它是底部
 * 抽屉 —— 这些都写在 globals.css 里，这里只把声明挂到 `data-width` 上。
 *
 * **是 Astro 组件，不是 Vue 岛屿。** 里面装的是各页自己的岛屿，把整页塞进一个岛
 * 屿就是每一页都为外壳付一次水合代价（轨当初避开的正是这个）。折叠、拖动、把位置
 * 告诉地图，都在 `lib/panelController.ts` 那段普通脚本里。
 *
 * `transition:name`：换页时新旧两张面板被当成同一个东西，视图过渡把宽度从旧的动到
 * 新的，而不是一张淡出、一张淡入。
 *
 * `data-sheet` 在服务端就按页面摆好那一档（表单页拉满，地图页一半），脚本接手之前
 * 不跳。
 */
import PageHeader from "@/components/PageHeader.astro";
import BeianLine from "@jianyuelab-org/can-ui/components/BeianLine.vue";
import Icon from "@jianyuelab-org/can-ui/components/Icon.vue";
import { initialSnap } from "@/lib/sheet";
import type { PanelWidth } from "@/lib/panelLayout";

interface Props {
  width: PanelWidth;
  title: string;
  description?: string;
  /** 已翻译。 */
  labels: { collapse: string; expand: string; handle: string };
}

const { width, title, description, labels } = Astro.props;
---

<main
  id="main-content"
  tabindex="-1"
  class="floating-panel glass"
  data-floating-panel
  data-width={width}
  data-collapsed="false"
  data-sheet={initialSnap(width)}
  aria-label={title}
  transition:name="efb-panel"
>
  <button
    type="button"
    class="panel-handle"
    data-panel-handle
    aria-label={labels.handle}
  >
    <span aria-hidden="true"></span>
  </button>

  <div class="panel-bar">
    <button
      type="button"
      class="panel-toggle"
      data-panel-toggle
      aria-expanded="true"
      aria-controls="panel-body"
      aria-label={labels.collapse}
      title={labels.collapse}
      data-label-collapse={labels.collapse}
      data-label-expand={labels.expand}
    >
      <Icon name="chevronDoubleLeft" class="panel-toggle-icon size-4" />
    </button>
  </div>

  <div id="panel-body" class="panel-body" data-panel-body>
    <PageHeader title={title} description={description} />
    <slot />
    {
      /*
        备案号在面板底部：面板是每一页内容所在、会滚到底的那一块，而地图跨页面存
        活 —— 挂在地图上等于挂在一个不属于任何一页的东西上。不加 client: 指令，
        它是一个静态链接。
      */
    }
    <div class="pt-6">
      <BeianLine />
    </div>
  </div>
</main>

<script>
  import { mountPanel, unmountPanel } from "@/lib/panelController";

  // ClientRouter 下这段模块只执行一次；首屏和每次换页都会发 astro:page-load。
  document.addEventListener("astro:page-load", mountPanel);
  document.addEventListener("astro:before-swap", unmountPanel);
</script>
```

- [ ] **Step 4: CSS**

In `src/styles/globals.css`, replace lines 64–280 (from `/* 航路地图（RouteMap.vue）。` through the end of the `.map-failure` rule) with:

```css
/* 航路地图（RouteMap.vue）。

   只管两件事：让容器在深浅两套主题下都不露出地图库自带的灰底，以及把控件调到和
   站内其余控件一个观感。归属声明在署名控件里，见 map/attribution.ts。

   **高度撑满父容器**：父容器是铺满视口的 `.map-stage`。 */
.route-map {
  height: 100%;
  width: 100%;
  background: var(--surface-sunken);
}
/* MapLibre 自己给容器设了字体，不接管的话地图上的文字和全站不是一套。 */
.maplibregl-canvas-container,
.maplibregl-map {
  font: inherit;
}

/* 缩放控件调成和站内其余控件一个观感。默认那套白底方块在纯黑陆地上很扎眼。 */
.maplibregl-ctrl-group {
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  box-shadow: none;
}
.maplibregl-ctrl-group button + button {
  border-top-color: var(--border-subtle);
}
.maplibregl-ctrl-group button:hover {
  background: var(--surface-overlay);
}

/* 地图外框。角落坐标是绝对定位在它上面的，所以这一层要建立定位上下文。 */
.route-map-wrap {
  position: relative;
  height: 100%;
  width: 100%;
}

/* MapLibre 的四个控件角跟着可见区走。

   地图铺满视口之后，左上的缩放钮会落在面板底下、右下的比例尺会落在手机抽屉底
   下 —— 控件还在、按不到，看起来像没有。`--map-pad-*` 由 MapStage 按面板位置写。 */
.map-stage .maplibregl-ctrl-top-left {
  top: var(--map-pad-top, 0px);
  left: var(--map-pad-left, 0px);
}
.map-stage .maplibregl-ctrl-top-right {
  top: var(--map-pad-top, 0px);
  right: var(--map-pad-right, 0px);
}
.map-stage .maplibregl-ctrl-bottom-left {
  bottom: var(--map-pad-bottom, 0px);
  left: var(--map-pad-left, 0px);
}
.map-stage .maplibregl-ctrl-bottom-right {
  bottom: var(--map-pad-bottom, 0px);
  right: var(--map-pad-right, 0px);
}
.map-stage .maplibregl-ctrl-top-left,
.map-stage .maplibregl-ctrl-bottom-left,
.map-stage .maplibregl-ctrl-bottom-right {
  transition:
    left 240ms ease,
    bottom 240ms ease;
}

/* 角落坐标标注。

   等宽字体不是装饰：这两个数是拿来读的，比例字体下小数点不对齐。`pointer-events:
   none` 同样是必须的 —— 它压在地图上，能挡住拖动就成了一个看不出原因的死角。 */
.map-corner {
  position: absolute;
  z-index: 2;
  pointer-events: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem;
  color: var(--color-muted);
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  padding: 0.0625rem 0.25rem;
  border-radius: 0.25rem;
}
.map-corner-nw {
  top: calc(var(--map-pad-top, 0px) + 0.5rem);
  /* 左上角让给缩放控件。 */
  left: calc(var(--map-pad-left, 0px) + 3rem);
}
.map-corner-se {
  right: calc(var(--map-pad-right, 0px) + 0.5rem);
  /* 让开右下角的比例尺（约 1.5rem 高加 10px 内边距）。 */
  bottom: calc(var(--map-pad-bottom, 0px) + 2.5rem);
}

/* ---------------------------------------------------------------------------
   外壳：地图铺满视口，轨和面板浮在上面。

   上一版是「轨 | 面板 | 地图」三栏：地图只拿到剩下那一截，1024–1152 之间还得改走
   上下堆叠。现在地图永远是整个视口，面板是压在它上面的一张玻璃卡片，地图用
   `setPadding` 把内容对到露出来的那一块中间（lib/panelLayout.ts）。

   **断点只在这个文件里定义**：768 和 1152 两个数不出现在任何 .vue / .ts 里。JS
   要知道当前排布就读 `--shell-mode`，这里在媒体查询里翻面。

       视口        轨                           面板
       ≥1152       显示，可折叠                 standard 或 wide
       768–1151    默认收起（data-rail=auto）   wide 退回 standard
       <768        换成底部标签栏               底部抽屉，三档
   --------------------------------------------------------------------------- */

:root {
  --shell-mode: phone;
  --shell-inset: 12px;
  --panel-standard: 26rem;
  --panel-wide: 44rem;
  --panel-collapsed: 3.25rem;
  --tabbar-height: 4rem;
  /* 和 lib/sheet.ts 的 SHEET_PEEK_PX 同值：服务端先按它摆「收起」那一档。 */
  --sheet-peek: 72px;
}

.map-stage {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
}

/* 面板。手机上是底部抽屉（这里是起点），平板和桌面上是左边一张卡片（下面两个媒
   体查询）。 */
.floating-panel {
  position: fixed;
  z-index: 30;
  left: 0;
  right: 0;
  bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom));
  height: calc(
    100dvh - var(--tabbar-height) - env(safe-area-inset-bottom) -
      var(--shell-inset)
  );
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
  border-bottom-width: 0;
  transform: translateY(var(--sheet-offset, 50%));
  transition: transform 320ms var(--ease-out-quint);
  outline: none;
}
/* 服务端先按页面声明的那一档摆好，脚本接手之前不跳。 */
.floating-panel[data-sheet="full"] {
  --sheet-offset: 0px;
}
.floating-panel[data-sheet="half"] {
  --sheet-offset: 50%;
}
.floating-panel[data-sheet="collapsed"] {
  --sheet-offset: calc(100% - var(--sheet-peek));
}

.panel-handle {
  display: flex;
  flex-shrink: 0;
  justify-content: center;
  padding: 0.625rem 0 0.375rem;
  touch-action: none;
  cursor: grab;
}
.panel-handle > span {
  width: 2.5rem;
  height: 0.3125rem;
  border-radius: 9999px;
  background: var(--border-strong);
}
.panel-bar {
  display: none;
}
.panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.25rem 1rem 1.5rem;
  /* 面板里的多列排布按**面板**宽度判，不按视口判（`.field-grid` 和各组件里的
     `@md:` 之类都问它）。 */
  container: efb-panel / inline-size;
}

/* 手机上抽屉没拉满时正文不滚：那时的手势是在拖抽屉。拉满之后才滚。 */
@media (max-width: 767.98px) {
  .floating-panel:not([data-sheet="full"]) .panel-body {
    overflow-y: hidden;
  }
}

/* 只在手机上出现的东西（设置页里的退出登录、跨站链接）：轨在手机上换成了标签栏，
   这几样没有别的家。 */
@media (min-width: 768px) {
  .phone-only {
    display: none !important;
  }
}

@media (min-width: 768px) {
  :root {
    --shell-mode: tablet;
  }

  .floating-panel {
    top: var(--shell-inset);
    bottom: var(--shell-inset);
    right: auto;
    left: calc(var(--rail-current) + var(--shell-inset));
    height: auto;
    /* 平板上 wide 也是这个宽度：再宽地图就只剩一条。 */
    width: var(--panel-standard);
    max-width: calc(100vw - var(--rail-current) - 2 * var(--shell-inset));
    border-radius: var(--radius-sheet);
    border-bottom-width: 1px;
    transform: none;
    transition:
      width 240ms var(--ease-out-quint),
      left 200ms ease;
  }
  .panel-handle {
    display: none;
  }
  .panel-bar {
    display: flex;
    flex-shrink: 0;
    justify-content: flex-end;
    padding: 0.5rem 0.5rem 0;
  }
  .panel-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-control);
    color: var(--color-muted);
  }
  .panel-toggle:hover {
    background: var(--surface-overlay);
    color: var(--color-ink);
  }
  .panel-body {
    padding: 0 1.25rem 1.5rem;
  }
  .floating-panel[data-collapsed="true"] {
    width: var(--panel-collapsed);
  }
  .floating-panel[data-collapsed="true"] .panel-body {
    visibility: hidden;
  }
  .floating-panel[data-collapsed="true"] .panel-toggle-icon {
    rotate: 180deg;
  }
}

@media (min-width: 1152px) {
  :root {
    --shell-mode: desktop;
  }
  .floating-panel[data-width="wide"] {
    width: var(--panel-wide);
  }
  /* 三个条件的选择器是必须的：上一条和折叠那条同分，后写的赢，折叠就失效了。 */
  .floating-panel[data-width="wide"][data-collapsed="true"] {
    width: var(--panel-collapsed);
  }
}

@media (prefers-reduced-motion: reduce) {
  .floating-panel {
    transition: none;
  }
}

/* 地图起不来时那句话。压在**可见区**上沿居中。

   显示的是按语言给的一句话；诊断记号在 `data-failure` 属性和 console 里。 */
.map-failure {
  position: absolute;
  z-index: 3;
  top: calc(var(--map-pad-top, 0px) + 0.5rem);
  left: calc(
    var(--map-pad-left, 0px) +
      (100% - var(--map-pad-left, 0px) - var(--map-pad-right, 0px)) / 2
  );
  transform: translateX(-50%);
  max-width: min(26rem, calc(100% - 8rem));
  font-size: 0.75rem;
  line-height: 1.5;
  text-align: center;
  color: var(--color-ink);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: 0.25rem;
  padding: 0.375rem 0.75rem;
}
```

- [ ] **Step 5: `src/layouts/AppLayout.astro`**

Replace the whole file:

```astro
---
/**
 * 外壳：**地图铺满视口，轨和面板浮在上面。** 没有站头，也不要加回来 —— 为什么见
 * AppRail.vue 顶上的注释。
 *
 * 这是第三版外壳。第二版是「轨 | 面板 | 地图」三栏，地图只拿到剩下那一截，而且
 * 1024–1152 之间得改走上下堆叠。现在地图永远是整个视口，面板是压在它上面的一张
 * 玻璃卡片，宽度由页面声明（`panel`）。地图从 `lib/mapBus.ts` 的 `panel:layout`
 * 知道面板盖住了哪一块，用 `setPadding` 把内容对到露出来的那一块中间。
 *
 * 层次自下而上：MapStage → 面板 → 轨。DOM 里地图排在最后，是为了键盘顺序：跳过
 * 链接、轨、面板正文，最后才是地图上的控件。
 *
 * `client:load` 只给三样：轨（唯一的导航，手机上那条标签栏在水合之前按不动也要
 * 能跳页，所以里面全是 `<a>`）、地图（这块面积上没有任何服务端渲染的内容能先顶
 * 着）、以及每一页自己那一个主岛屿。
 *
 * `messages` 只传 `efb` 这一本：岛屿的 props 会原样序列化进每个页面的 HTML。
 */
import BaseLayout from "@/layouts/BaseLayout.astro";
import AppRail from "@/components/AppRail.vue";
import MapStage from "@/components/map/MapStage.vue";
import FloatingPanel from "@/components/FloatingPanel.astro";
import { getLocale, getMessages, useTranslations } from "@/lib/i18n";
import { buildCrossLinks, buildNav } from "@/lib/nav";
import { toEfbUser } from "@/lib/session";
import { signInUrl } from "@/lib/config";
import type { PanelWidth } from "@/lib/panelLayout";

interface Props {
  title: string;
  description?: string;
  /** 面板宽度。表单页（飞行计划、设置）用 `wide`，其余 `standard`。 */
  panel?: PanelWidth;
}

const { title, description, panel = "standard" } = Astro.props;

const locale = getLocale(Astro.cookies);
const t = useTranslations(locale, "efb");

// 中间件已经问过 can-api 了，这里只是取出来 —— 不要在页面里再解一次会话。
const user = toEfbUser(Astro.locals.user);

const sections = buildNav(t);
const crossLinks = buildCrossLinks(t);
---

<BaseLayout title={title} description={description}>
  <AppRail
    sections={sections}
    crossLinks={crossLinks}
    pathname={Astro.url.pathname}
    messages={getMessages(locale, "efb")}
    locale={locale}
    user={user}
    signInHref={signInUrl()}
    client:load
  />

  <FloatingPanel
    width={panel}
    title={title}
    description={description}
    labels={{
      collapse: t("panel.collapse"),
      expand: t("panel.expand"),
      handle: t("panel.handle"),
    }}
  >
    <slot />
  </FloatingPanel>

  {
    /*
      地图跨页面存活：`transition:persist` 让 Astro 在导航时保留这个岛屿的实例。
      没有它，每换一页地图都要重新初始化、底图重新下载一遍 —— 在平板上那是一次
      肉眼可见的白闪，而地图是这一版外壳里唯一从不改变的东西。
    */
  }
  <MapStage
    label={t("route.map.label")}
    cid={user?.id ?? null}
    t={{
      partial: t("map.partial"),
      denied: t("map.denied"),
      emptyAirways: t("map.emptyLayer.airways"),
      emptyNavaids: t("map.emptyLayer.navaids"),
      emptyGeneric: t("map.emptyLayer.generic"),
      groundAccuracy: t("map.groundAccuracy"),
      planOnMap: t("map.planOnMap"),
      layersMenu: t("map.layersMenu"),
      layerFailed: t("map.layerFailed"),
      retry: t("common.retry"),
      locate: t("map.locate"),
    }}
    failureText={{
      init: t("map.failure.init"),
      webgl: t("map.failure.webgl"),
    }}
    layerLabels={{
      airways: t("map.layers.airways"),
      firs: t("map.layers.firs"),
      navaids: t("map.layers.navaids"),
      mora: t("map.layers.mora"),
      traffic: t("map.layers.traffic"),
      atcLive: t("map.layers.atcLive"),
      ctr: t("map.layers.ctr"),
      app: t("map.layers.app"),
      restricted: t("map.layers.restricted"),
    }}
    client:load
    transition:persist
  />
</BaseLayout>
```

If `groundAccuracy` is no longer a MapStage prop by the time this runs (see the note in Task 4 Step 7 about `feat/ground-sector-only`), drop that line and its prop together.

- [ ] **Step 6: `MapStage.vue` — padding**

In `src/components/map/MapStage.vue`:

- add imports `import { subscribePanelLayout } from "@/lib/mapBus";` and `import { mapPaddingFor, type MapPadding } from "@/lib/panelLayout";`
- after `const ownButton = …` add:
  ```ts
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
  ```
- in `onMounted`, first line after `mounted.value = true;`:
  ```ts
    unsubscribeLayout = subscribePanelLayout((layout) => {
      padding.value = mapPaddingFor(layout, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
    });
  ```
- in `onBeforeUnmount`: `unsubscribeLayout?.();`
- template root: `<section class="map-stage" :style="padStyle" :aria-label="label">`; add `:padding="padding"` to `<RouteMap>`.

- [ ] **Step 7: Pages**

Remove the `PageHeader` import and the `<PageHeader … />` line from all six pages (`index.astro` 3, 19; `flightplan.astro` 3, 14; `route.astro` 3, 15; `airports.astro` 19, 35; `settings.astro` 3, 19; `404.astro` has none). Then:

- `src/pages/flightplan.astro` line 13: `<AppLayout title={title} description={description} panel="wide">`
- `src/pages/settings.astro` line 18: `<AppLayout title={title} description={description} panel="wide">`
- the other four keep the default (`standard`).

- [ ] **Step 8: Gate**

Run: `bunx prettier --write src/lib/panelController.ts src/components/FloatingPanel.astro src/styles/globals.css src/layouts/AppLayout.astro src/components/map/MapStage.vue src/pages language && bun run lint && bun run build`
Expected: exit 0. `git grep -n -e "--shell-layout" -e "app-shell" -e "app-panel" -e "app-map" -- src` prints nothing.

- [ ] **Step 9: Browser check**

`bun run dev`. The rail is still the old one until Task 8 (on phone it is the old FAB; that is expected here).

- ≥1152px, light and dark: map fills the window under the rail; the panel is a glass card 12px from the rail, top and bottom. `/flightplan` and `/settings` are wide (~44rem), others ~26rem. Navigating `/` → `/flightplan` animates the width. The filed plan is centred in the area right of the panel, not under it. Collapse button: panel shrinks to a bar, map content slides left to recentre; Tab from the bar skips the hidden body.
- ~900px: `/flightplan` panel is ~26rem (wide falls back); zoom buttons and ✈ sit right of the panel; scale bar bottom-right.
- ~390px: panel is a bottom sheet over a 4rem gap (tab bar arrives in Task 8). `/` opens at half, `/flightplan` at full. Drag the handle: follows the finger with rubber-banding past the ends; a fast flick down from full lands collapsed; a fast flick up lands full. Arrow keys on the focused handle step between snaps. At half, the body does not scroll; tapping an input expands to full. The layer menu and the scale bar stay above the sheet.
- `prefers-reduced-transparency` (Chrome devtools → Rendering → Emulate CSS media feature): panel is solid.
- Keyboard: Tab from the skip link reaches the panel body before the map controls.

- [ ] **Step 10: Commit**

```bash
git add src/lib/panelController.ts src/components/FloatingPanel.astro src/styles/globals.css src/layouts/AppLayout.astro src/components/map/MapStage.vue src/pages language
perl -e 'alarm 40; exec @ARGV' git commit -m "外壳改成全屏地图加浮动面板；手机上面板是三档抽屉" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Glass rail, tablet auto-collapse, phone tab bar

**Files:**
- Modify: `src/lib/nav.ts` (append `isCurrentPath`)
- Create: `src/lib/nav.test.ts`
- Modify: `src/components/SidebarNav.vue` lines 14–15, 25–35, 65–80
- Modify: `src/components/RailScript.astro` lines 2–13, 18–31
- Modify: `src/components/AppRail.vue` lines 10–18, 24–30, 74–82, 199–215, 228–234, 411–505
- Modify: `src/components/Settings.vue` lines 13, 97–99, 110–119
- Modify: `src/styles/globals.css` lines 18–62 (rail section), append tab bar CSS

**Interfaces:**
- Consumes: `effectiveRail` (Task 1); `--tabbar-height` (Task 7).
- Produces:
  ```ts
  // lib/nav.ts
  export function isCurrentPath(href: string, pathname: string): boolean;
  ```
  `html[data-rail]` gains a third value `auto` (nothing stored). CSS gives `--rail-auto: collapsed` between 768 and 1151px, `expanded` elsewhere.

**Behaviour that must survive (AppRail.vue at `29b690d`):**
- `data-rail` is the single source; AppRail and Settings only write it and observe it, 56–76, 199–207; Settings.vue 93–119.
- Collapse rules are scoped to `.app-rail` so other copies of `.rail-*` are unaffected (globals.css 48–54).
- ⌘K opens from anywhere, arrow keys and Enter work, Escape handled by `useOverlay`, 84–150, 183–192.
- Sign-out always navigates, even on failure, 165–179.
- Unsigned-in branch renders only when a sign-in URL is given, 320–350.

- [ ] **Step 1: Write the failing test**

`src/lib/nav.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isCurrentPath } from "@/lib/nav";

/**
 * 当前页判错不报错：侧栏和标签栏上亮错一项，或者「概览」在每一页都亮着。侧栏和
 * 手机标签栏共用这一个判断，所以它从 SidebarNav.vue 搬到了这里。
 */
describe("isCurrentPath", () => {
  test("根路由只在根上亮", () => {
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath("/", "/route")).toBe(false);
  });

  test("子路由算在父项上，前缀相同的兄弟不算", () => {
    expect(isCurrentPath("/route", "/route")).toBe(true);
    expect(isCurrentPath("/route", "/route/expand")).toBe(true);
    expect(isCurrentPath("/route", "/routes")).toBe(false);
  });

  test("外链和空链接永远不亮", () => {
    expect(isCurrentPath("https://ceruleanavi.net", "/")).toBe(false);
    expect(isCurrentPath("#", "/")).toBe(false);
    expect(isCurrentPath("", "/")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/nav.test.ts`
Expected: FAIL — `Export named 'isCurrentPath' not found`.

- [ ] **Step 3: Implement**

Append to `src/lib/nav.ts`:

```ts

/**
 * 这一项是不是当前页。侧栏和手机标签栏共用。
 *
 * 根路由必须精确匹配，否则「概览」在每一个子路由上都亮着；其余按路径段匹配，
 * `/route` 不该在 `/routes` 上亮。
 */
export function isCurrentPath(href: string, pathname: string): boolean {
  if (!href || href === "#" || href.startsWith("http")) return false;
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  if (pathname.startsWith(href)) {
    const nextChar = pathname[href.length];
    return !nextChar || nextChar === "/";
  }
  return false;
}
```

`src/components/SidebarNav.vue`: line 15 adds `import { isCurrentPath } from "@/lib/nav";` next to the type import (`import { isCurrentPath, type NavSection } from "@/lib/nav";`); delete lines 25–35; in the template replace the three `isCurrentPath(item.href)` calls with `isCurrentPath(item.href, pathname)`.

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/nav.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: `RailScript.astro`**

Lines 18–31 become:

```astro
<script is:inline>
  (function () {
    var root = document.documentElement;
    try {
      var stored = localStorage.getItem("efb.rail");
      // 成员选过就照他选的；没选过写 auto，交给 CSS 按宽度定（平板收起、桌面展开）。
      root.dataset.rail =
        stored === "collapsed" || stored === "expanded" ? stored : "auto";
    } catch (e) {
      // 锁死的浏览器里 localStorage 会抛。auto 是个完全合理的结果，而且这么早
      // 也没有地方可以上报。
      root.dataset.rail = "auto";
    }
  })();
</script>
```

Append to the doc comment (after line 13):

```
 *
 * 三个值：`collapsed` / `expanded` 是成员点过折叠钮之后的选择；`auto` 是没选过，
 * 由 CSS 按宽度决定（768–1151 收起，其余展开），JS 读 `--rail-auto` 得到答案
 * （`lib/panelLayout.ts` 的 `effectiveRail`）。断点因此仍然只写在 globals.css 里。
```

- [ ] **Step 6: CSS**

Replace `src/styles/globals.css` lines 30–62 (from the first `:root {` of the rail section to the end of the `.rail-label` rule; keep the comment at 18–29) with:

```css
:root {
  --rail-width: 17rem;
  --rail-width-collapsed: 4.75rem;
  --rail-current: var(--rail-width);
  /* `data-rail="auto"` 时轨该是什么样。只在平板那一段翻成 collapsed。 */
  --rail-auto: expanded;
}
:root[data-rail="collapsed"] {
  --rail-current: var(--rail-width-collapsed);
}

/* 轨。手机上不显示（换成底部标签栏），768 起贴在左边。材质来自 `.glass`，这里
   只收掉三边的边框和阴影：它贴着视口边，不是一张浮起来的卡片。 */
.app-rail {
  display: none;
}
@media (min-width: 768px) {
  .app-rail {
    position: fixed;
    inset-block: 0;
    left: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    width: var(--rail-current);
    transition: width 200ms ease;
  }
  .app-rail.glass {
    border-width: 0 1px 0 0;
    box-shadow: none;
  }
}

/* 平板上成员没选过就收起。这一段是范围查询，因为「auto 在桌面上展开」不需要写：
   那就是 `--rail-current` 的默认值。 */
@media (min-width: 768px) and (max-width: 1151.98px) {
  :root {
    --rail-auto: collapsed;
  }
  :root[data-rail="auto"] {
    --rail-current: var(--rail-width-collapsed);
  }
  :root[data-rail="auto"] .app-rail .rail-item {
    justify-content: center;
    padding-left: 0;
    padding-right: 0;
  }
  :root[data-rail="auto"] .app-rail .rail-label {
    display: none;
  }
}

/* 折叠态下导航项只剩图标：居中成一格方块、文字让位。写成类而不是一串条件式
   Tailwind，是因为同一组规则要作用在四处（主导航、跨站链接、品牌、轨脚的账户
   与搜索），而它们的 DOM 形状并不相同。

   选择器里保留 `.app-rail` 限定：data-rail 挂在 <html> 上，这一层让规则只作用于
   轨本身，别处出现的 `.rail-*` 不受折叠态影响。 */
:root[data-rail="collapsed"] .app-rail .rail-item {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}
:root[data-rail="collapsed"] .app-rail .rail-label {
  display: none;
}
```

Append at the end of the file:

```css
/* 手机的底部标签栏。轨在手机上整条换成它：五个导航项正好一行，拇指够得着。主题、
   语言、账户、跨站链接在设置页的 `.phone-only` 那几块里。 */
.tab-bar {
  position: fixed;
  z-index: 40;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(var(--tabbar-height) + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
}
.tab-bar.glass {
  border-width: 1px 0 0 0;
  box-shadow: none;
}
.tab-bar-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.125rem;
  font-size: 0.6875rem;
  color: var(--color-muted);
}
.tab-bar-item[aria-current="page"] {
  color: var(--color-can);
}
@media (min-width: 768px) {
  .tab-bar {
    display: none;
  }
}
```

- [ ] **Step 7: `AppRail.vue`**

Edits, bottom-up (original line numbers):

1. Lines 411–505 (FAB + drawer) → replace with:
   ```vue
       <!-- ===================== 手机：底部标签栏 ===================== -->
       <!--
         手机上轨整条换成它。全是 <a>：水合之前也能跳页。只收本站页面，理由和 ⌘K
         一样 —— 跨站链接点过去是另一个域。
       -->
       <nav class="tab-bar glass" :aria-label="t('rail.label')">
         <a
           v-for="item in flatNav"
           :key="item.href"
           :href="item.href"
           class="tab-bar-item"
           :aria-current="isCurrentPath(item.href, pathname) ? 'page' : undefined"
         >
           <Icon :name="item.icon" class="size-6" />
           <span class="max-w-full truncate px-1">{{ item.name }}</span>
         </a>
       </nav>
   ```
2. Lines 228–234 → replace with:
   ```vue
       <!-- ===================== 桌面 / 平板轨（768 起，见 globals.css） ===================== -->
       <div class="app-rail glass">
         <div
           class="flex grow flex-col gap-y-4 overflow-y-auto overscroll-contain px-3 py-4"
         >
   ```
3. Lines 199–215: in `onMounted` add `window.addEventListener("resize", syncCollapsed);` after the observer; in `onBeforeUnmount` add `window.removeEventListener("resize", syncCollapsed);`.
4. Lines 78–82 (drawer state): delete.
5. Lines 74–76 → replace with:
   ```ts
   /**
    * 轨此刻收着还是展开。`data-rail="auto"` 时答案在 CSS 里（`--rail-auto`，平板上
    * 收起），所以窗口跨过断点时要再问一次 —— 见 onMounted 里的 resize。
    */
   function syncCollapsed() {
     const root = document.documentElement;
     collapsed.value =
       effectiveRail(
         root.dataset.rail,
         getComputedStyle(root).getPropertyValue("--rail-auto"),
       ) === "collapsed";
   }
   ```
6. Lines 24–30: add `import { isCurrentPath } from "@/lib/nav";` (merge with the existing `type NavSection` import) and `import { effectiveRail } from "@/lib/panelLayout";`.
7. Lines 12–14 (header item 1) → replace with:
   ```
    * 1. 手机上轨整条换成底部标签栏：五个导航项正好一行，拇指够得着，全是 <a>，水
    *    合之前也能跳页。主题、语言、账户和跨站链接在设置页里（`.phone-only`）。
   ```

`applyCollapsed` (58–70) is unchanged: it writes `collapsed` / `expanded`, which is the member's explicit choice and overrides `auto`.

- [ ] **Step 8: `Settings.vue` rail switch follows `auto`**

Line 13 imports gain `import { effectiveRail } from "@/lib/panelLayout";`. Lines 97–99 become:

```ts
function syncRail() {
  const root = document.documentElement;
  railCollapsed.value =
    effectiveRail(
      root.dataset.rail,
      getComputedStyle(root).getPropertyValue("--rail-auto"),
    ) === "collapsed";
}
```

In `onMounted` (110–118) add `window.addEventListener("resize", syncRail);`; line 119 becomes `onBeforeUnmount(() => { railObserver?.disconnect(); window.removeEventListener("resize", syncRail); });`.

- [ ] **Step 9: Gate**

Run: `bunx prettier --write src/lib/nav.ts src/lib/nav.test.ts src/components/SidebarNav.vue src/components/RailScript.astro src/components/AppRail.vue src/components/Settings.vue src/styles/globals.css && bun run lint && bun run build`
Expected: exit 0. `git grep -n -e "lg:" -e "md:" -- src/components/AppRail.vue` prints nothing.

- [ ] **Step 10: Browser check**

Clear `localStorage["efb.rail"]` first.
- ≥1152px, light/dark: rail expanded, glass over the map, one hairline on its right. Collapse button narrows it; the panel slides left with it. Reload: stays collapsed (stored).
- Clear storage, ~900px: rail comes up collapsed without a flash; the arrow points "expand". Widen past 1152: it expands and the arrow flips. Press expand at 900px, reload: stays expanded.
- ~390px: no rail; tab bar at the bottom with five items, current page tinted; the sheet sits above it. Navigating between tabs keeps the map (no reload flash).
- ⌘K still opens at ≥768px.
- `/settings` at 900px with nothing stored: the "默认收起侧栏" switch shows on.

- [ ] **Step 11: Commit**

```bash
git add src/lib/nav.ts src/lib/nav.test.ts src/components/SidebarNav.vue src/components/RailScript.astro src/components/AppRail.vue src/components/Settings.vue src/styles/globals.css
perl -e 'alarm 40; exec @ARGV' git commit -m "轨改成玻璃材质、平板上默认收起；手机上换成底部标签栏" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: `lib/requestState.ts`

**Files:**
- Create: `src/lib/requestState.ts`
- Create: `src/lib/requestState.test.ts`

**Interfaces:**
- Consumes: `ApiResult`, `ApiFailure` from `lib/canApi.ts`.
- Produces:
  ```ts
  export type StateKind = "loading" | "empty" | "error" | "forbidden";
  export type RequestState<T> =
    | { kind: "loading" }
    | { kind: "data"; data: T }
    | { kind: "empty" }
    | { kind: "error"; status: number; failure?: ApiFailure }
    | { kind: "forbidden"; status: number };
  export const LOADING: { kind: "loading" };
  export function isForbiddenStatus(status: number): boolean;
  export function fromApiResult<T>(result: ApiResult<T | null | undefined>, isEmpty?: (data: T) => boolean): RequestState<T>;
  export function fromDbResponse<T>(ok: boolean, status: number, data: T | null | undefined, isEmpty?: (data: T) => boolean): RequestState<T>;
  export function stateCardKind<T>(state: RequestState<T>): StateKind | null;
  ```

- [ ] **Step 1: Write the failing test**

`src/lib/requestState.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  fromApiResult,
  fromDbResponse,
  isForbiddenStatus,
  LOADING,
  stateCardKind,
} from "@/lib/requestState";

/**
 * 这个站反复踩的坑：把「没读到」画成「没有」（AGENTS.md〈别把「失败」画成「没
 * 有」〉）。所以每一种请求结果落到哪一类，在这里钉死。
 */
describe("fromApiResult（can-api）", () => {
  test("读到了、有内容", () => {
    expect(fromApiResult({ ok: true, data: { callsign: "CCA1501" } })).toEqual({
      kind: "data",
      data: { callsign: "CCA1501" },
    });
  });

  test("读到了、确实没有：null 是空，不是错", () => {
    expect(fromApiResult({ ok: true, data: null })).toEqual({ kind: "empty" });
  });

  test("空数组由调用方说了算", () => {
    expect(
      fromApiResult<number[]>({ ok: true, data: [] }, (list) => !list.length),
    ).toEqual({ kind: "empty" });
    expect(fromApiResult<number[]>({ ok: true, data: [] })).toEqual({
      kind: "data",
      data: [],
    });
  });

  test("can-api 的 401 是登录失效，是错误，不是没权限", () => {
    const failure = {
      ok: false as const,
      status: 401,
      error: "unauthorized",
      message: "Unauthorized",
    };
    expect(fromApiResult(failure)).toEqual({
      kind: "error",
      status: 401,
      failure,
    });
  });

  test("网络断了是 status 0 的错误", () => {
    expect(
      fromApiResult({
        ok: false,
        status: 0,
        error: "network",
        message: "Network request failed.",
      }).kind,
    ).toBe("error");
  });
});

/**
 * can-db 的 401/403 是「你没有 aipAccess」—— 大多数飞行员的常态，不是故障，要有
 * 自己的一句话（can-db 的门是 `aipAccess >= 1 || rating >= 8`）。
 */
describe("fromDbResponse（can-db）", () => {
  test("401 和 403 都是没权限", () => {
    expect(fromDbResponse(false, 401, null)).toEqual({
      kind: "forbidden",
      status: 401,
    });
    expect(fromDbResponse(false, 403, null)).toEqual({
      kind: "forbidden",
      status: 403,
    });
  });

  test("别的失败都是错误，连不上是 status 0", () => {
    expect(fromDbResponse(false, 502, null)).toEqual({
      kind: "error",
      status: 502,
    });
    expect(fromDbResponse(false, 0, null)).toEqual({
      kind: "error",
      status: 0,
    });
  });

  test("成功但空", () => {
    expect(
      fromDbResponse<string[]>(true, 200, [], (list) => !list.length),
    ).toEqual({ kind: "empty" });
    expect(fromDbResponse(true, 200, null)).toEqual({ kind: "empty" });
  });

  test("成功有内容", () => {
    expect(fromDbResponse(true, 200, ["ZBAA"])).toEqual({
      kind: "data",
      data: ["ZBAA"],
    });
  });
});

describe("isForbiddenStatus", () => {
  test("只有 401 和 403", () => {
    expect([400, 401, 403, 404, 500].map(isForbiddenStatus)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("stateCardKind", () => {
  test("有数据时不画状态卡，其余四种各对各的", () => {
    expect(stateCardKind({ kind: "data", data: 1 })).toBeNull();
    expect(stateCardKind(LOADING)).toBe("loading");
    expect(stateCardKind({ kind: "empty" })).toBe("empty");
    expect(stateCardKind({ kind: "error", status: 500 })).toBe("error");
    expect(stateCardKind({ kind: "forbidden", status: 403 })).toBe(
      "forbidden",
    );
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `bun test src/lib/requestState.test.ts`
Expected: FAIL — `Cannot find module '@/lib/requestState'`.

- [ ] **Step 3: Implement**

`src/lib/requestState.ts`:

```ts
/**
 * 一次请求的结果落到哪一类：有数据、真的没有、没读到、没有权限、还在读。
 *
 * 这个站反复踩的坑是把「没读到」画成「没有」：概览说「还没有提交飞行计划」、设置说
 * 「未绑定」，而那两句话读起来完全正常，人会照着它做决定（AGENTS.md〈别把「失败」
 * 画成「没有」〉）。每一处各写一遍 `if (!result.ok)`，迟早有一处落错分支。所以分类
 * 只在这里做一次，岛屿按类渲染 `StateCard`。
 *
 * **两个来源分开判 401/403。** can-api 的 401 是登录失效 —— 一种错误，刷新重登就
 * 好；can-db 的 401/403 是「你没有航行资料库权限」—— 大多数飞行员的常态，要说清楚
 * 是权限、找谁开通，而不是弹一个像坏了的错误。
 */
import type { ApiFailure, ApiResult } from "@/lib/canApi";

export type StateKind = "loading" | "empty" | "error" | "forbidden";

export type RequestState<T> =
  | { kind: "loading" }
  | { kind: "data"; data: T }
  | { kind: "empty" }
  /** `failure` 只有 can-api 的结果带：界面用它按错误码给一句话（describeFailure）。 */
  | { kind: "error"; status: number; failure?: ApiFailure }
  | { kind: "forbidden"; status: number };

export const LOADING = { kind: "loading" } as const;

export function isForbiddenStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function present<T>(
  data: T | null | undefined,
  isEmpty?: (data: T) => boolean,
): RequestState<T> {
  if (data === null || data === undefined) return { kind: "empty" };
  return isEmpty?.(data) ? { kind: "empty" } : { kind: "data", data };
}

/** can-api（`lib/canApi.ts` 的 `api()`）。它的失败一律是错误。 */
export function fromApiResult<T>(
  result: ApiResult<T | null | undefined>,
  isEmpty?: (data: T) => boolean,
): RequestState<T> {
  if (!result.ok) {
    return { kind: "error", status: result.status, failure: result };
  }
  return present(result.data, isEmpty);
}

/** can-db（同源 `/api/db/*` 或 SSR 的 `server/canDb.ts`）。401/403 是没权限。 */
export function fromDbResponse<T>(
  ok: boolean,
  status: number,
  data: T | null | undefined,
  isEmpty?: (data: T) => boolean,
): RequestState<T> {
  if (!ok) {
    return isForbiddenStatus(status)
      ? { kind: "forbidden", status }
      : { kind: "error", status };
  }
  return present(data, isEmpty);
}

/** 这一状态该画哪一种状态卡；有数据时不画，返回 null。 */
export function stateCardKind<T>(state: RequestState<T>): StateKind | null {
  return state.kind === "data" ? null : state.kind;
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `bun test src/lib/requestState.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Gate**

Run: `bunx prettier --write src/lib/requestState.ts src/lib/requestState.test.ts && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/requestState.ts src/lib/requestState.test.ts
perl -e 'alarm 40; exec @ARGV' git commit -m "请求结果统一分成数据、空、错误、无权限、载入中" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: `StateCard`, `PanelSection`, `Field`, `FieldGrid`

**Files:**
- Create: `src/components/ui/StateCard.vue`, `PanelSection.vue`, `Field.vue`, `FieldGrid.vue`
- Modify: `src/styles/globals.css` (append `.field-grid`)

**Interfaces:**
- Consumes: `StateKind` (Task 9); `EmptyState`, `Spinner` from can-ui; container `efb-panel` (Task 7).
- Produces:
  ```ts
  // StateCard.vue
  props: { kind: StateKind; title: string; body?: string; retryLabel?: string; compact?: boolean }
  emits: { retry: [] }
  slots: { action?: () => unknown }
  // PanelSection.vue
  props: { title: string; description?: string; level?: 2 | 3 }
  slots: { default: () => unknown; actions?: () => unknown }
  // Field.vue
  props: { label: string; hint?: string; error?: string; wide?: boolean; group?: boolean }
  slots: { default: (p: { id: string; describedby: string | undefined; invalid: boolean; labelledby: string }) => unknown }
  // FieldGrid.vue
  slots: { default: () => unknown }
  ```

- [ ] **Step 1: `src/components/ui/StateCard.vue`**

```vue
<script setup lang="ts">
/**
 * 「这里现在是什么情况」的统一样子：还在读、真的没有、没读到、没有权限。
 *
 * 四种各有各的图标和措辞，**不许合并**：
 *
 * - `error` 必须带一个重试（`retryLabel` + `@retry`）。没读到的东西再读一次常常就
 *   有了，不给按钮等于让人去刷新整页。
 * - `forbidden` 是 can-db 的 401/403：说清楚这是权限、不是故障，和谁能开通。
 * - `empty` 只在**读到了、确实没有**时用 —— 读失败落到这里，就是那句读起来完全
 *   正常的假话（AGENTS.md〈别把「失败」画成「没有」〉）。
 *
 * 文案全部由调用方传进来、已经翻好：这个组件不认识词典，所以 Astro 页面（404）
 * 和岛屿都能直接用。外观借 can-ui 的 EmptyState，不另起一套。
 */
import { EmptyState, Spinner } from "@jianyuelab-org/can-ui";
import type { StateKind } from "@/lib/requestState";

withDefaults(
  defineProps<{
    kind: StateKind;
    title: string;
    body?: string;
    /** 只对 `error` 生效。 */
    retryLabel?: string;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{ retry: [] }>();

const ICONS: Record<Exclude<StateKind, "loading">, string> = {
  empty: "inbox",
  error: "exclamationTriangle",
  forbidden: "key",
};
</script>

<template>
  <div
    class="state-card rounded-card border border-subtle bg-surface-sunken"
    :data-state="kind"
    :role="kind === 'error' ? 'alert' : 'status'"
    :aria-busy="kind === 'loading' ? 'true' : undefined"
  >
    <Spinner v-if="kind === 'loading'" :label="title" centered />
    <EmptyState
      v-else
      :title="title"
      :description="body"
      :icon="ICONS[kind]"
      :compact="compact"
    >
      <template
        v-if="(kind === 'error' && retryLabel) || $slots.action"
        #action
      >
        <div class="flex flex-wrap justify-center gap-2">
          <button
            v-if="kind === 'error' && retryLabel"
            type="button"
            class="btn btn-secondary"
            @click="emit('retry')"
          >
            {{ retryLabel }}
          </button>
          <slot name="action" />
        </div>
      </template>
    </EmptyState>
  </div>
</template>
```

- [ ] **Step 2: `src/components/ui/PanelSection.vue`**

```vue
<script setup lang="ts">
/**
 * 面板里的一节：一个标题，下面是内容。
 *
 * 替掉各页里那种光秃秃的 `<h2 class="mb-3 text-sm …">`：一样的字号和间距各写一遍，
 * 就是 can-web 上页面之间开始漂移的样子（PageHeader.astro 顶上那段）。`section`
 * 用 `aria-labelledby` 挂上标题，读屏的「区域」列表里就能跳到它。
 */
import { useId } from "vue";

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** 面板里页面标题是 h1，节标题默认 h2；节里再套一节用 3。 */
    level?: 2 | 3;
  }>(),
  { level: 2 },
);

const headingId = useId();
</script>

<template>
  <section class="panel-section" :aria-labelledby="headingId">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <component
          :is="level === 3 ? 'h3' : 'h2'"
          :id="headingId"
          class="text-sm font-semibold text-ink"
        >
          {{ title }}
        </component>
        <p v-if="description" class="mt-1 text-sm text-muted">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <div class="mt-3">
      <slot />
    </div>
  </section>
</template>
```

- [ ] **Step 3: `src/components/ui/Field.vue`**

```vue
<script setup lang="ts">
/**
 * 表单里的一格：标签、说明、错误，以及把它们连到输入框上的 `aria-describedby`。
 *
 * 以前每一格都手写 `<label><span>…</span><input/><span v-if="error">…</span></label>`，
 * 错误那一行和输入框之间没有任何关联 —— 看得见的人知道它说的是哪一格，读屏软件
 * 只读到一个孤零零的句子。
 *
 * **输入框由调用方放进插槽**：这里的输入有 input、select、textarea、两格并排的时分，
 * 形状各不相同。插槽参数给出它该挂的 `id`、`describedby`、`invalid`；`group` 时标
 * 签不是 `<label for>` 而是一个 id，调用方把 `labelledby` 挂到 `role="group"` 上。
 *
 * 错误文案来自 can-api 422 的 `fields`，翻译在调用方做 —— 这里不重写任何校验规则。
 */
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    error?: string;
    /** 两列排布下独占一整行（航路、备注）。 */
    wide?: boolean;
    /** 这一格里不止一个输入框（时 : 分）。 */
    group?: boolean;
  }>(),
  { wide: false, group: false },
);

const base = useId();
const inputId = `${base}-input`;
const labelId = `${base}-label`;
const hintId = `${base}-hint`;
const errorId = `${base}-error`;

const describedby = computed(
  () =>
    [props.hint ? hintId : "", props.error ? errorId : ""]
      .filter(Boolean)
      .join(" ") || undefined,
);
</script>

<template>
  <div class="field" :class="wide ? 'field-wide' : ''">
    <span
      v-if="group"
      :id="labelId"
      class="mb-1 block text-sm font-medium text-ink"
      >{{ label }}</span
    >
    <label
      v-else
      :id="labelId"
      :for="inputId"
      class="mb-1 block text-sm font-medium text-ink"
      >{{ label }}</label
    >
    <slot
      :id="inputId"
      :describedby="describedby"
      :invalid="!!error"
      :labelledby="labelId"
    />
    <p v-if="hint" :id="hintId" class="mt-1 text-xs text-muted">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="mt-1 text-xs text-danger">
      {{ error }}
    </p>
  </div>
</template>
```

- [ ] **Step 4: `src/components/ui/FieldGrid.vue`**

```vue
<script setup lang="ts">
/**
 * 一组 Field。面板窄（standard、平板、手机）时一列，面板宽（wide）时两列。
 *
 * 按**面板**宽度判，不按视口判：规则在 globals.css 的 `.field-grid`，问的是
 * `efb-panel` 这个容器。用视口前缀的话，1440 的屏上 standard 面板也会被排成两列，
 * 每列不到 200px。
 */
</script>

<template>
  <div class="field-grid">
    <slot />
  </div>
</template>
```

- [ ] **Step 5: CSS**

Append to `src/styles/globals.css`:

```css
/* 表单两列排布（FieldGrid.vue）。按面板宽度判：standard 面板 26rem 恒为一列，wide
   面板 44rem 才分两列。36rem 这道线落在两者之间，离哪一边都够远，不会在某个宽度上
   来回跳。 */
.field-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: minmax(0, 1fr);
}
@container efb-panel (min-width: 36rem) {
  .field-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .field-grid > .field-wide {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 6: Gate**

Run: `bunx prettier --write src/components/ui src/styles/globals.css && bun run lint && bun run build`
Expected: exit 0. No page uses these yet; the browser check happens in Task 11.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui src/styles/globals.css
perl -e 'alarm 40; exec @ARGV' git commit -m "加上 StateCard、PanelSection、Field、FieldGrid" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Dashboard

**Files:**
- Modify: `src/components/Dashboard.vue` (whole file)
- Modify: `src/pages/index.astro` lines 18–24
- Modify: `language/*.json` (`efb.dashboard.summary.id`, `efb.dashboard.weather.title`, `efb.dashboard.weather.failed`)

**Interfaces:**
- Consumes: `fromApiResult`, `LOADING`, `RequestState` (Task 9); `StateCard`, `PanelSection` (Task 10); `showPlanOnMap` (Task 3); `describeFailure` from `lib/canApi.ts`.
- Produces: `Dashboard.vue` props `{ messages: Record<string, unknown>; userName: string; userId: string }`.

**Behaviour that must survive (Dashboard.vue at `29b690d`):**
- Plan read failure is not "no plan"; failure is checked before empty, 70–95, 193–203.
- The plan card link does not say "file" when we do not know, 179–188. New rule: "file" only when the plan is known to be empty.
- ATC read failure is not "nobody online", 121–126, 149–156, 284–290.
- Controllers grouped by airport and ordered by contact sequence, 97–117, 291–343.
- "Online for" goes through `onlineFor` / `parseFeedTime`, 326–335.
- ATIS letter is not guessed, 362–367; ATIS listed separately from callable stations, 346–381.
- METAR cards keyed by role, so same-airport departure and arrival do not share a node, 250–254.
- No polling on this page, 104–106.

**Deliberate change:** METAR failure used to render as "暂无报文" (65–67). The spec says failed ≠ empty everywhere, so a failed METAR now says so and offers retry.

- [ ] **Step 1: Dictionaries**

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `dashboard.summary.id` | `CAN ID` | `CAN ID` | `CAN ID` | `CAN ID` |
| `dashboard.weather.title` | `起降天气` | `起降天氣` | `Departure and arrival weather` | `出発地と目的地の天気` |
| `dashboard.weather.failed` | `没能读取 {icao} 的报文 —— 这不代表没有。` | `沒能讀取 {icao} 的報文 —— 這不代表沒有。` | `Couldn't load the METAR for {icao} — that doesn't mean there isn't one.` | `{icao} の METAR を取得できませんでした。報文がないという意味ではありません。` |

- [ ] **Step 2: Rewrite `src/components/Dashboard.vue`**

```vue
<script setup lang="ts">
/**
 * 概览：这次飞行开始之前要看的那几件事，一屏之内。
 *
 * 它自己**不产生任何数据** —— 全部是别处已经在用的那几个来源的组合：当前计划、
 * 起降两地的 METAR、在线管制和 ATIS。所以这一页永远不会显示别处看不到的东西，也
 * 就不会和别处对不上。
 *
 * 两条线**并发**且互不阻塞：计划那条走 can-api（METAR 要等计划回来才知道查哪两个
 * 机场，所以它挂在计划后面），管制那条走 can-fsd 的 datafeed。一条失败不影响另一
 * 条渲染。
 *
 * **地图画的是已提交的计划。** 打开这一页时向地图要一次（`showPlanOnMap`）：别的页
 * 面推过东西之后地图就不再自己画计划，概览是那个要回来的地方。
 *
 * 每一块都走 `RequestState`：读到了、确实没有、没读到，各说各的话。METAR 以前把
 * 「没读到」和「没有报文」当成一回事，现在分开 —— 没读到的时候「暂无报文」是一句
 * 假话。
 *
 * **这里曾经还有一块飞行统计，删掉了。** 它显示的是 `logbook.stats.flights` 这样
 * 的**键名本身** —— 删飞行日志那一页时词典里的 `logbook` 命名空间跟着没了，模板
 * 却还在调它。`scripts/check-i18n-keys.mjs` 现在盯着这一类。
 */
import { computed, onMounted, ref } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { showPlanOnMap } from "@/lib/mapBus";
import { fromApiResult, LOADING, type RequestState } from "@/lib/requestState";
import {
  facilityLabel,
  fetchDatafeed,
  onlineAtis,
  onlineControllers,
  type DatafeedController,
} from "@/lib/datafeed";
import {
  atisLetter,
  atisText,
  facilityColor,
  groupControllers,
  onlineFor,
  type StationGroup,
} from "@/lib/atc";
import { Icon } from "@jianyuelab-org/can-ui";
import StateCard from "@/components/ui/StateCard.vue";
import PanelSection from "@/components/ui/PanelSection.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  userName: string;
  /** CAN ID。 */
  userId: string;
}>();
const t = createTranslator(props.messages);

interface Plan {
  callsign: string;
  aircraft: string;
  departure: string;
  arrival: string;
  alternate: string;
  departureTime: string;
  cruisingAltitude: string;
  route: string;
  updatedAt: string;
}

const initials = computed(() => {
  const parts = props.userName.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
});

/**
 * 计划**没取到**，和**没有计划**，是两件事。
 *
 * 以前失败时 `plan` 留在 null，于是这一段显示「还没有提交飞行计划」，而那是一句
 * **假话**：成员可能明明交了，只是这一次没读上。按钮跟着变成「去提交」，于是它还在
 * **劝人再交一份**。现在失败是 `error`，空是 `empty`，按钮只在确知为空时说「去提交」。
 */
const plan = ref<RequestState<Plan>>(LOADING);
const filed = computed(() =>
  plan.value.kind === "data" ? plan.value.data : null,
);

async function loadPlan() {
  plan.value = LOADING;
  const result = await api<Plan | null>("/api/v1/pilot/flightplan");
  plan.value = fromApiResult(result);
  if (plan.value.kind === "data") {
    void loadMetar(plan.value.data.departure);
    void loadMetar(plan.value.data.arrival);
  }
}

const metars = ref<Record<string, RequestState<string>>>({});

async function loadMetar(icao: string) {
  if (!icao) return;
  metars.value[icao] = LOADING;
  const result = await api<{ icao: string; metar: string | null }>(
    `/api/v1/metar?icao=${encodeURIComponent(icao)}`,
  );
  metars.value[icao] = fromApiResult<string>(
    result.ok ? { ok: true, data: result.data.metar } : result,
  );
}

/** 两张天气卡。key 带角色：本场起落时两张卡的 ICAO 相同，只用 ICAO 做 key 会重复。 */
const weather = computed(() =>
  filed.value
    ? [
        { role: "dep", icao: filed.value.departure },
        { role: "arr", icao: filed.value.arrival },
      ]
    : [],
);

/*
 * 在线管制 —— Dashboard.vue 97–159 原样搬来（groups、atis、atcLoading、atcFailed、
 * fetchedAt、controllerCount、loadControllers），只改一处：loadControllers 开头加
 * `atcLoading.value = true;`，这样「重试」按下去先回到载入中，而不是停在失败那句上。
 */

onMounted(() => {
  showPlanOnMap();
  void loadPlan();
  void loadControllers();
});
</script>

<template>
  <div class="space-y-6">
    <!-- 谁在用。和轨里的账户是同一份会话，这里只是开门第一眼。 -->
    <section class="flex items-center gap-3">
      <span
        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-can text-sm font-semibold text-white"
        aria-hidden="true"
        >{{ initials }}</span
      >
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold text-ink">
          {{ t("dashboard.greeting", { name: userName }) }}
        </p>
        <p class="font-mono text-xs text-faint">
          {{ t("dashboard.summary.id") }} {{ userId }}
        </p>
      </div>
    </section>

    <PanelSection :title="t('dashboard.plan.title')">
      <template #actions>
        <!-- 只有确知没有计划时才说「去提交」；不知道的时候那句话是在替他假设。 -->
        <a href="/flightplan" class="link text-sm">{{
          plan.kind === "empty"
            ? t("dashboard.plan.file")
            : t("dashboard.plan.edit")
        }}</a>
      </template>

      <StateCard
        v-if="plan.kind === 'loading'"
        kind="loading"
        :title="t('common.loading')"
        compact
      />
      <!-- 失败要排在「没有」前面：两句话占同一个位置。 -->
      <StateCard
        v-else-if="plan.kind === 'error'"
        kind="error"
        :title="t('dashboard.plan.failed')"
        :body="plan.failure ? describeFailure(t, plan.failure) : undefined"
        :retry-label="t('common.retry')"
        compact
        @retry="loadPlan"
      />
      <StateCard
        v-else-if="plan.kind === 'empty'"
        kind="empty"
        :title="t('dashboard.plan.none')"
        compact
      >
        <template #action>
          <a href="/flightplan" class="btn btn-primary">{{
            t("dashboard.plan.file")
          }}</a>
        </template>
      </StateCard>

      <div v-else-if="filed" class="card p-4">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="font-mono text-xl font-semibold text-ink">{{
            filed.callsign
          }}</span>
          <span class="font-mono text-xl text-ink">
            {{ filed.departure }}
            <Icon name="arrowRight" class="inline size-4 text-faint" />
            {{ filed.arrival }}
          </span>
          <span v-if="filed.alternate" class="font-mono text-sm text-muted">
            {{ t("dashboard.plan.alternate") }} {{ filed.alternate }}
          </span>
        </div>
        <dl class="mt-3 grid gap-3 text-sm @sm:grid-cols-3">
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.aircraft") }}
            </dt>
            <dd class="truncate font-mono text-ink">{{ filed.aircraft }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.off") }}
            </dt>
            <dd class="font-mono text-ink">{{ filed.departureTime }}Z</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.level") }}
            </dt>
            <dd class="font-mono text-ink">{{ filed.cruisingAltitude }}</dd>
          </div>
        </dl>
        <p
          v-if="filed.route"
          class="mt-3 break-words font-mono text-xs text-muted"
        >
          {{ filed.route }}
        </p>
      </div>
    </PanelSection>

    <PanelSection v-if="weather.length" :title="t('dashboard.weather.title')">
      <div class="grid gap-3 @md:grid-cols-2">
        <div
          v-for="card in weather"
          :key="`${card.role}-${card.icao}`"
          class="card p-4"
        >
          <h3 class="font-mono text-sm font-semibold text-ink">
            {{ card.icao }}
          </h3>
          <p
            v-if="metars[card.icao]?.kind === 'data'"
            class="mt-2 break-words font-mono text-xs leading-relaxed text-muted"
          >
            {{ (metars[card.icao] as { data: string }).data }}
          </p>
          <StateCard
            v-else-if="metars[card.icao]?.kind === 'error'"
            class="mt-2"
            kind="error"
            :title="t('dashboard.weather.failed', { icao: card.icao })"
            :retry-label="t('common.retry')"
            compact
            @retry="loadMetar(card.icao)"
          />
          <p
            v-else-if="metars[card.icao]?.kind === 'empty'"
            class="mt-2 text-xs text-faint"
          >
            {{ t("dashboard.weather.none") }}
          </p>
          <p v-else class="skeleton mt-2 h-4 w-3/4"></p>
        </div>
      </div>
    </PanelSection>

    <!-- 在线管制。频率是这一段存在的理由：「谁在线、我该呼叫哪个频率」。 -->
    <PanelSection :title="t('dashboard.atc.title')">
      <template v-if="!atcLoading && !atcFailed" #actions>
        <span class="text-xs text-muted">{{
          t("dashboard.atc.count", { count: String(controllerCount) })
        }}</span>
      </template>

      <StateCard
        v-if="atcLoading"
        kind="loading"
        :title="t('dashboard.atc.loading')"
        compact
      />
      <StateCard
        v-else-if="atcFailed"
        kind="error"
        :title="t('dashboard.atc.failed')"
        :retry-label="t('common.retry')"
        compact
        @retry="loadControllers"
      />
      <StateCard
        v-else-if="!groups.length"
        kind="empty"
        :title="t('dashboard.atc.none')"
        compact
      />
      <!-- Dashboard.vue 295–343 的 `<div v-else class="space-y-3">…</div>` 原样放在这里。 -->
    </PanelSection>

    <!-- ATIS：Dashboard.vue 346–381 原样，只把外层 `<section … class="card p-5">`
         和它的 `<h2>` 换成 `<PanelSection v-if="atis.length" :title="t('dashboard.atis.title')">`，
         里面的 `<ul>` 包一层 `<div class="card p-4">`。 -->
  </div>
</template>
```

The three HTML comments that say 原样 are instructions: replace each with the named original block. The ATC comment block from 309–312 and 326–330 inside the pasted list stays.

`(metars[card.icao] as { data: string }).data` is there because template narrowing does not follow an index expression. If vue-tsc still complains, add a helper in the script: `function metarText(icao: string): string | null { const m = metars.value[icao]; return m?.kind === "data" ? m.data : null; }` and use `metarText(card.icao)` in both the `v-if` and the text.

- [ ] **Step 3: `src/pages/index.astro`**

Lines 18–24 become:

```astro
<AppLayout title={title} description={description}>
  <Dashboard
    messages={getMessages(locale, "efb")}
    userName={user?.name ?? ""}
    userId={user?.id ?? ""}
    client:load
  />
</AppLayout>
```

- [ ] **Step 4: Gate**

Run: `bunx prettier --write src/components/Dashboard.vue src/pages/index.astro language && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 5: Browser check**

`bun run dev`, `/` at ≥1152px, ~900px, ~390px, light and dark:
- Visit `/route`, generate or expand any route, then go to `/`: the map switches back to the filed plan (magenta) with the 已提交的飞行计划 label.
- User row shows initials, greeting and CAN ID.
- Block `/api/v1/pilot/flightplan` in devtools and reload: the plan card is an error card with 重试 and the header link reads 查看 / 修改, not 去提交. Unblock, 重试: the plan appears.
- Block `/api/v1/metar*`: each weather card says 没能读取 ZBAA 的报文 … with 重试; it never says 暂无报文.
- Block `fsd.ceruleanavi.net`: ATC card is an error with 重试, not 当前没有管制员在线.
- At ~390px the sheet opens at half and the map shows the plan above it.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard.vue src/pages/index.astro language
perl -e 'alarm 40; exec @ARGV' git commit -m "概览：用户摘要、计划卡片、起降天气都区分没读到和没有；地图回到已提交的计划" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: `lib/flightPlan.ts`, `lib/routePreview.ts`

**Files:**
- Create: `src/lib/flightPlan.ts`, `src/lib/flightPlan.test.ts`
- Create: `src/lib/routePreview.ts`, `src/lib/routePreview.test.ts`

**Interfaces:**
- Consumes: `fromDbResponse`, `RequestState` (Task 9); `unwrapList` from `lib/aip.ts`; `MapPoint` from `lib/mapBus.ts`.
- Produces:
  ```ts
  // lib/flightPlan.ts
  export interface Plan { callsign; flightRules; aircraft; cruiseTas; departure; departureTime; cruisingAltitude; arrival; alternate; hoursEnroute; minutesEnroute; fuelHours; fuelMinutes; remarks; route: string }
  export interface StoredPlan extends Plan { filedFromClient: boolean; updatedAt: string }
  export const FLIGHT_RULES: readonly ["I", "V", "S", "D"];
  export function blankPlan(): Plan;
  export function formatUtc(iso: string): string;
  export function fillPlan(target: Plan, source: Partial<Plan>): void;
  // lib/routePreview.ts
  export function shouldPreview(departure: string, arrival: string, route: string): boolean;
  export function previewKey(departure: string, arrival: string, route: string): string;
  export function resolveRoute(departure: string, arrival: string, route: string, signal?: AbortSignal): Promise<RequestState<MapPoint[]>>;
  ```

- [ ] **Step 1: Write the failing tests**

`src/lib/flightPlan.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { blankPlan, fillPlan, formatUtc } from "@/lib/flightPlan";

/**
 * 时刻按 UTC 显示：管制员、ATIS、计划里的 EOBT 都是 Z 时。按本地时区显示不会报错，
 * 只是在东八区差八小时。
 */
describe("formatUtc", () => {
  test("RFC 3339 排成 YYYY-MM-DD HH:MMZ", () => {
    expect(formatUtc("2026-09-25T13:05:09Z")).toBe("2026-09-25 13:05Z");
  });

  test("带时区偏移的也折回 UTC", () => {
    expect(formatUtc("2026-09-25T08:05:00+08:00")).toBe("2026-09-25 00:05Z");
  });

  test("解析不了就原样返回", () => {
    expect(formatUtc("yesterday")).toBe("yesterday");
  });
});

describe("fillPlan", () => {
  test("只抄已知字段里的字符串，别的不碰", () => {
    const plan = blankPlan();
    fillPlan(plan, {
      callsign: "CCA1501",
      route: "ELKUR A461 SASAN",
      // @ts-expect-error —— can-api 回来的对象里有表单不认识的字段
      updatedAt: "2026-09-25T13:05:09Z",
    });
    expect(plan.callsign).toBe("CCA1501");
    expect(plan.route).toBe("ELKUR A461 SASAN");
    expect("updatedAt" in plan).toBe(false);
    expect(plan.flightRules).toBe("I");
  });

  test("非字符串的值跳过，不把字段写成 undefined", () => {
    const plan = blankPlan();
    fillPlan(plan, { callsign: undefined });
    expect(plan.callsign).toBe("");
  });
});
```

`src/lib/routePreview.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { previewKey, resolveRoute, shouldPreview } from "@/lib/routePreview";

/**
 * 边打字边画：起降机场还没填完整就去问 can-db，每敲一个字母就是一次必然失败的请
 * 求，而失败提示会在人打字的时候一直闪。
 */
describe("shouldPreview", () => {
  test("两个四字码加一段航路才画", () => {
    expect(shouldPreview("ZBAA", "zsss", "ELKUR A461 SASAN")).toBe(true);
  });

  test("机场没填完、航路是空的，都不画", () => {
    expect(shouldPreview("ZBA", "ZSSS", "ELKUR")).toBe(false);
    expect(shouldPreview("ZBAA", "", "ELKUR")).toBe(false);
    expect(shouldPreview("ZBAA", "ZSSS", "   ")).toBe(false);
  });
});

describe("previewKey", () => {
  test("大小写和多余空白不算改动", () => {
    expect(previewKey("zbaa", "ZSSS", " elkur  A461 sasan ")).toBe(
      previewKey("ZBAA", "zsss", "ELKUR A461 SASAN"),
    );
  });
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** 画不出来的三种原因各说各的：没权限、没读到、读到了但一个点都没对上。 */
describe("resolveRoute", () => {
  test("有点就是数据", async () => {
    answer(200, {
      data: [{ ident: "ZBAA", lat: 40.08, lon: 116.58, kind: "airport" }],
    });
    const state = await resolveRoute("ZBAA", "ZSSS", "ELKUR");
    expect(state.kind).toBe("data");
  });

  test("一个点都没对上是空", async () => {
    answer(200, { data: [] });
    expect((await resolveRoute("ZBAA", "ZSSS", "XXXXX")).kind).toBe("empty");
  });

  test("can-db 401/403 是没权限", async () => {
    answer(403, { error: "forbidden" });
    expect((await resolveRoute("ZBAA", "ZSSS", "ELKUR")).kind).toBe(
      "forbidden",
    );
  });

  test("连不上是错误，不是空", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await resolveRoute("ZBAA", "ZSSS", "ELKUR")).toEqual({
      kind: "error",
      status: 0,
    });
  });
});
```

- [ ] **Step 2: Run the tests, expect FAIL**

Run: `bun test src/lib/flightPlan.test.ts src/lib/routePreview.test.ts`
Expected: FAIL — `Cannot find module '@/lib/flightPlan'` and `'@/lib/routePreview'`.

- [ ] **Step 3: Implement `src/lib/flightPlan.ts`**

```ts
/**
 * 飞行计划的形状和两三个纯函数。从 FlightPlan.vue 搬出来：表单拆成了几个组件，它们
 * 共用这一份类型；而 `formatUtc` 错了不会被屏幕出卖（东八区差八小时，看起来仍然是
 * 一个像样的时刻）。
 */

/* FlightPlan.vue 30–47（Plan）、49–52（StoredPlan）加 export，注释原样。 */

/** 飞行规则的四个值，顺序就是下拉框里的顺序。文案在 `flightplan.rules.*`。 */
export const FLIGHT_RULES = ["I", "V", "S", "D"] as const;

/* FlightPlan.vue 54–68（formatUtc 与注释）加 export。 */

/* FlightPlan.vue 70–88（blank）改名 blankPlan 并 export。 */

/**
 * 把一份（可能来自 can-api、SimBrief 或草稿的）计划抄进表单：只抄表单认识的字段，
 * 只抄字符串。FlightPlan.vue 132–137 原来的 `fill`。
 */
export function fillPlan(target: Plan, source: Partial<Plan>): void {
  for (const key of Object.keys(target) as (keyof Plan)[]) {
    const value = source[key];
    if (typeof value === "string") target[key] = value;
  }
}
```

Replace each `/* FlightPlan.vue … */` comment with the named original lines plus the stated change.

- [ ] **Step 4: Implement `src/lib/routePreview.ts`**

```ts
/**
 * 飞行计划页上「边打字边画」：把表单里那串航路交给 can-db 解析成点，交给地图。
 *
 * 走的是 can-db 的 `/aip/resolve`，和地图画已提交计划用的是同一条（理由写在
 * useRouteLayer 的 loadPlanRoute 里：can-api 的 `/route` 读全球 navdata，链式消歧
 * 会一路错到俄罗斯）。结果落成 `RequestState`：没权限、没读到、一个点都没对上，各说
 * 各的 —— 三种都是「图上没有线」，但对填表的人意思完全不同。
 *
 * 校验规则不在这里：画不出来不等于航路有误，交计划时 can-api 的 422 才是权威。
 */
import { unwrapList } from "@/lib/aip";
import type { MapPoint } from "@/lib/mapBus";
import { fromDbResponse, type RequestState } from "@/lib/requestState";

const ICAO = /^[A-Z]{4}$/;

export function shouldPreview(
  departure: string,
  arrival: string,
  route: string,
): boolean {
  return (
    ICAO.test(departure.trim().toUpperCase()) &&
    ICAO.test(arrival.trim().toUpperCase()) &&
    route.trim().length > 0
  );
}

/** 同一份输入的签名：大小写、多余空白不算改动，免得每敲一个空格就重画一次。 */
export function previewKey(
  departure: string,
  arrival: string,
  route: string,
): string {
  return [
    departure.trim().toUpperCase(),
    arrival.trim().toUpperCase(),
    route.trim().replace(/\s+/g, " ").toUpperCase(),
  ].join("|");
}

export async function resolveRoute(
  departure: string,
  arrival: string,
  route: string,
  signal?: AbortSignal,
): Promise<RequestState<MapPoint[]>> {
  const params = new URLSearchParams({
    departure: departure.trim().toUpperCase(),
    arrival: arrival.trim().toUpperCase(),
    route: route.trim().replace(/\s+/g, " "),
  });
  let response: Response;
  try {
    response = await fetch(`/api/db/aip/resolve?${params}`, { signal });
  } catch {
    return { kind: "error", status: 0 };
  }
  if (!response.ok) return fromDbResponse(false, response.status, null);
  const points = unwrapList<MapPoint>(await response.json().catch(() => null));
  return fromDbResponse(true, response.status, points, (list) => !list.length);
}
```

- [ ] **Step 5: Run the tests, expect PASS**

Run: `bun test src/lib/flightPlan.test.ts src/lib/routePreview.test.ts`
Expected: PASS, 5 + 7 tests.

- [ ] **Step 6: Point the allow-list comment at the new caller**

`src/pages/api/db/[...path].ts`: the `aip/resolve` entry's `who` (line 75 of that file, `"MapSurface.vue 画已提交的飞行计划"`) becomes `"useRouteLayer.ts 画已提交的飞行计划；routePreview.ts 画正在填的航路"`. The file's own rule is that every entry names its callers. Also update the other `who` strings that name `MapSurface.vue` or `RouteMap.vue` in that allow-list (lines 41, 47, 48, 51) to `useChartLayers.ts`.

- [ ] **Step 7: Gate**

Run: `bunx prettier --write src/lib/flightPlan.ts src/lib/flightPlan.test.ts src/lib/routePreview.ts src/lib/routePreview.test.ts "src/pages/api/db/[...path].ts" && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/flightPlan.ts src/lib/flightPlan.test.ts src/lib/routePreview.ts src/lib/routePreview.test.ts "src/pages/api/db/[...path].ts"
perl -e 'alarm 40; exec @ARGV' git commit -m "飞行计划的类型和纯函数搬进 lib；加上航路预览的解析" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Flight plan split and live route preview

**Files:**
- Move: `src/components/FlightPlan.vue` → `src/components/flightplan/FlightPlan.vue` (`git mv`, then rewrite)
- Create: `src/components/flightplan/SimbriefImport.vue`, `PlanStatusBar.vue`, `PlanForm.vue`
- Modify: `src/pages/flightplan.astro` (import path; `panel="wide"` already set in Task 7)
- Modify: `language/*.json` (`efb.flightplan.preview.*`, `efb.flightplan.import.hint`)

**Interfaces:**
- Consumes: `Plan`, `StoredPlan`, `FLIGHT_RULES`, `blankPlan`, `fillPlan`, `formatUtc` (Task 12); `shouldPreview`, `previewKey`, `resolveRoute` (Task 12); `Field`, `FieldGrid`, `PanelSection`, `StateCard` (Task 10); `publishToMap`, `announcePlanChanged` from `lib/mapBus.ts`; `takeDraft` from `lib/planDraft.ts`.
- Produces:
  ```ts
  // SimbriefImport.vue
  props: { messages: Record<string, unknown>; disabled: boolean }
  emits: { imported: [plan: Plan]; failed: [text: string] }
  // PlanStatusBar.vue
  props: { messages: Record<string, unknown>; loading: boolean; loadFailed: boolean; stored: StoredPlan | null; disabled: boolean }
  emits: { reload: []; delete: [] }
  // PlanForm.vue
  model: form: Plan   (defineModel<Plan>("form", { required: true }))
  props: { messages: Record<string, unknown>; errors: Record<string, string>; disabled: boolean; submitLabel: string; previewNote: string }
  emits: { submit: [] }
  ```

**Behaviour that must survive (FlightPlan.vue at `29b690d`):**
- Read failure locks the form and says so; failure is checked before "none", 101–113, 142–155, 377–386.
- Re-read after filing lands only in the status bar, never over the "filed" banner, 110–111, 247–250.
- 422 maps `fields` to per-field errors, 254–258.
- 409 `tracked` locks the form and names the controller, 259–266; only 重新检查 unlocks, 157–181, 359–368.
- DELETE `tracked` locks the same way, 281–289.
- `not_linked` gets its own message, 307–314.
- SimBrief import fills the form and never submits, 317–320.
- `applyDraft` fills only empty fields and states the route's origin, 183–232.
- `confirm` before delete, 272–274.
- Submit says 更新计划 when a plan exists or the read failed, 698–710.
- `announcePlanChanged` after file and delete, 248, 296.

**Live preview.** The spec's "route preview on the map as the route is typed". Rules:
- 600 ms debounce; only when `shouldPreview`; one request in flight (abort the previous).
- Skip while the key equals the stored plan's key and nothing has been previewed yet: the map already shows that plan.
- `data` → `publishToMap({ points, label })`. Anything else → `publishToMap({})`, so the map never shows a line that is no longer the one in the box.
- The reason it could not be drawn goes in the route field's hint (`previewNote`). It is not a validation error; 422 stays the authority.

- [ ] **Step 1: Dictionaries**

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `flightplan.preview.label` | `正在填写：{from} → {to}` | `正在填寫：{from} → {to}` | `Draft: {from} → {to}` | `入力中：{from} → {to}` |
| `flightplan.preview.forbidden` | `航路预览要航图权限，你暂时没有；不影响提交。` | `航路預覽需要航圖權限，你暫時沒有；不影響提交。` | `Previewing the route needs chart access, which you don't have yet. You can still file.` | `航路のプレビューには航空図の権限が必要です。提出には影響しません。` |
| `flightplan.preview.failed` | `没能读取航路预览 —— 这不代表航路有误。` | `沒能讀取航路預覽 —— 這不代表航路有誤。` | `Couldn't load the route preview — that doesn't mean the route is wrong.` | `航路のプレビューを取得できませんでした。航路が誤っているという意味ではありません。` |
| `flightplan.preview.empty` | `这串航路里没有能在图上找到的点。` | `這串航路裡沒有能在圖上找到的點。` | `None of the points in this route could be found on the map.` | `この航路には地図上で見つかる地点がありません。` |
| `flightplan.import.hint` | `从你绑定的 SimBrief 账号取最新的 OFP，填进表单，不会自动提交。` | `從你綁定的 SimBrief 帳號取最新的 OFP，填進表單，不會自動提交。` | `Fetches the latest OFP from your linked SimBrief account into the form. Nothing is filed until you submit.` | `連携済みの SimBrief から最新の OFP をフォームに読み込みます。自動では提出しません。` |

- [ ] **Step 2: `git mv src/components/FlightPlan.vue src/components/flightplan/FlightPlan.vue`**

- [ ] **Step 3: `src/components/flightplan/SimbriefImport.vue`**

```vue
<script setup lang="ts">
/**
 * 从 SimBrief 导入。
 *
 * **导入完不提交** —— 只把 OFP 填进表单，交不交由成员自己按。SimBrief 里的计划常
 * 常是几天前排的，静默提交出去就是一份他没检查过的计划挂在网上。
 *
 * 自己不写横幅：成功把计划交回容器（`imported`），失败把已经翻好的一句话交回去
 * （`failed`），横幅只有容器那一条。
 */
import { ref } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import type { Plan } from "@/lib/flightPlan";
import { Icon } from "@jianyuelab-org/can-ui";

const props = defineProps<{
  messages: Record<string, unknown>;
  disabled: boolean;
}>();
const emit = defineEmits<{ imported: [plan: Plan]; failed: [text: string] }>();
const t = createTranslator(props.messages);

const importing = ref(false);

async function run() {
  if (importing.value) return;
  importing.value = true;
  const result = await api<Plan>("/api/v1/pilot/simbrief/import");
  importing.value = false;

  if (!result.ok) {
    emit(
      "failed",
      result.error === "not_linked"
        ? t("flightplan.notice.notLinked")
        : describeFailure(t, result),
    );
    return;
  }
  emit("imported", result.data);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="btn btn-secondary"
      :disabled="importing || disabled"
      :aria-busy="importing"
      @click="run"
    >
      <Icon name="arrowDownTray" class="size-4" />
      {{ importing ? t("common.loading") : t("flightplan.actions.import") }}
    </button>
    <p class="min-w-0 flex-1 text-xs text-muted">
      {{ t("flightplan.import.hint") }}
    </p>
  </div>
</template>
```

- [ ] **Step 4: `src/components/flightplan/PlanStatusBar.vue`**

```vue
<script setup lang="ts">
/**
 * 「我现在有没有一份计划」那一行，外加撤销。
 *
 * **失败排在「没有」前面**：先判 `stored` 的话，读取失败会落进「当前没有已提交的飞
 * 行计划」—— 而他可能有，此时再交一份就是拿空白表单覆盖他没看到的那份。
 */
import { createTranslator } from "@/lib/i18n";
import { formatUtc, type StoredPlan } from "@/lib/flightPlan";
import StateCard from "@/components/ui/StateCard.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  loading: boolean;
  loadFailed: boolean;
  stored: StoredPlan | null;
  disabled: boolean;
}>();
const emit = defineEmits<{ reload: []; delete: [] }>();
const t = createTranslator(props.messages);
</script>

<template>
  <StateCard
    v-if="loading"
    kind="loading"
    :title="t('common.loading')"
    compact
  />
  <StateCard
    v-else-if="loadFailed"
    kind="error"
    :title="t('flightplan.status.failed')"
    :retry-label="t('common.refresh')"
    compact
    @retry="emit('reload')"
  />
  <div
    v-else
    class="flex flex-col gap-3 rounded-card border border-subtle p-4 @sm:flex-row @sm:items-center @sm:justify-between"
  >
    <div v-if="stored" class="min-w-0 text-sm">
      <p class="font-semibold text-ink">
        {{ t("flightplan.status.filed") }}
        <span class="font-mono">{{ stored.callsign }}</span>
        <span class="text-muted">
          {{ stored.departure }} → {{ stored.arrival }}</span
        >
      </p>
      <p class="mt-0.5 text-xs text-faint">
        {{ t("flightplan.status.updatedAt") }}
        {{ formatUtc(stored.updatedAt) }}
        <span v-if="stored.filedFromClient">
          · {{ t("flightplan.status.fromClient") }}</span
        >
      </p>
    </div>
    <p v-else class="text-sm text-muted">{{ t("flightplan.status.none") }}</p>

    <button
      v-if="stored"
      type="button"
      class="btn btn-danger shrink-0"
      :disabled="disabled"
      @click="emit('delete')"
    >
      {{ t("flightplan.actions.delete") }}
    </button>
  </div>
</template>
```

- [ ] **Step 5: `src/components/flightplan/PlanForm.vue`**

```vue
<script setup lang="ts">
/**
 * 计划表单本身：只管字段、错误和提交按钮，不发任何请求。
 *
 * 错误是 can-api 422 的 `fields`（字段 → 错误码），翻译在这里做；**这里不重写任何
 * 校验规则** —— 规则只在 can-api 一处，前端再抄一份就会有两份不一致的规则。
 *
 * 宽面板下两列、窄面板下一列，由 FieldGrid 按面板宽度决定。时分两格用 `group`，
 * 读屏软件读到的是「航路时间，小时」「航路时间，分钟」。
 */
import { createTranslator } from "@/lib/i18n";
import { FLIGHT_RULES, type Plan } from "@/lib/flightPlan";
import Field from "@/components/ui/Field.vue";
import FieldGrid from "@/components/ui/FieldGrid.vue";
import PanelSection from "@/components/ui/PanelSection.vue";
import { Icon } from "@jianyuelab-org/can-ui";

const form = defineModel<Plan>("form", { required: true });
const props = defineProps<{
  messages: Record<string, unknown>;
  errors: Record<string, string>;
  disabled: boolean;
  submitLabel: string;
  /** 航路画不出来的原因，已经翻好；空串＝没什么要说的。 */
  previewNote: string;
}>();
const emit = defineEmits<{ submit: [] }>();
const t = createTranslator(props.messages);

function errorFor(...fields: string[]): string {
  for (const field of fields) {
    const code = props.errors[field];
    if (code) return t(`flightplan.errors.${code}`);
  }
  return "";
}

/** 一行纯文本输入的公共属性，省得每一格都抄一遍。 */
const TEXT_FIELDS = [
  { key: "callsign", mono: true, upper: true, placeholder: "CCA1501" },
  { key: "aircraft", mono: true, upper: true, placeholder: "A320/M-SDE2E3FGHIRWY/LB1" },
  { key: "cruiseTas", mono: true, upper: false, placeholder: "450", numeric: true },
  { key: "departure", mono: true, upper: true, placeholder: "ZBAA", max: 4 },
  { key: "departureTime", mono: true, upper: false, placeholder: "1230", max: 4 },
  { key: "arrival", mono: true, upper: true, placeholder: "ZSSS", max: 4 },
  { key: "alternate", mono: true, upper: true, placeholder: "ZSPD", max: 4 },
  { key: "cruisingAltitude", mono: true, upper: true, placeholder: "FL350" },
] as const satisfies readonly {
  key: keyof Plan;
  mono: boolean;
  upper: boolean;
  placeholder: string;
  numeric?: boolean;
  max?: number;
}[];

const PAIRS = [
  { label: "enroute", hours: "hoursEnroute", minutes: "minutesEnroute", ph: ["02", "15"] },
  { label: "fuel", hours: "fuelHours", minutes: "fuelMinutes", ph: ["03", "30"] },
] as const;
</script>

<template>
  <form class="space-y-6" @submit.prevent="emit('submit')">
    <fieldset :disabled="disabled" class="space-y-6">
      <PanelSection :title="t('flightplan.sections.flight')" :level="3">
        <FieldGrid>
          <Field
            :label="t('flightplan.fields.flightRules')"
            :error="errorFor('flightRules')"
          >
            <template #default="{ id, describedby, invalid }">
              <select
                :id="id"
                v-model="form.flightRules"
                class="input"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              >
                <option v-for="rule in FLIGHT_RULES" :key="rule" :value="rule">
                  {{ t(`flightplan.rules.${rule}`) }}
                </option>
              </select>
            </template>
          </Field>

          <Field
            v-for="f in TEXT_FIELDS"
            :key="f.key"
            :label="t(`flightplan.fields.${f.key}`)"
            :error="errorFor(f.key)"
          >
            <template #default="{ id, describedby, invalid }">
              <input
                :id="id"
                v-model="form[f.key]"
                class="input"
                :class="[
                  f.mono ? 'font-mono' : '',
                  f.upper ? 'uppercase' : '',
                  invalid ? 'input-error' : '',
                ]"
                autocomplete="off"
                :inputmode="'numeric' in f ? 'numeric' : undefined"
                :maxlength="'max' in f ? f.max : undefined"
                :placeholder="f.placeholder"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              />
            </template>
          </Field>

          <Field
            v-for="p in PAIRS"
            :key="p.label"
            :label="t(`flightplan.fields.${p.label}`)"
            :error="errorFor(p.hours, p.minutes)"
            group
          >
            <template #default="{ describedby, invalid, labelledby }">
              <div
                role="group"
                :aria-labelledby="labelledby"
                :aria-describedby="describedby"
                class="flex items-center gap-2"
              >
                <input
                  v-model="form[p.hours]"
                  class="input font-mono"
                  :class="invalid ? 'input-error' : ''"
                  maxlength="2"
                  inputmode="numeric"
                  :aria-label="t('flightplan.fields.hours')"
                  :aria-invalid="invalid"
                  :placeholder="p.ph[0]"
                />
                <span class="text-faint" aria-hidden="true">:</span>
                <input
                  v-model="form[p.minutes]"
                  class="input font-mono"
                  :class="invalid ? 'input-error' : ''"
                  maxlength="2"
                  inputmode="numeric"
                  :aria-label="t('flightplan.fields.minutes')"
                  :aria-invalid="invalid"
                  :placeholder="p.ph[1]"
                />
              </div>
            </template>
          </Field>
        </FieldGrid>
      </PanelSection>

      <PanelSection :title="t('flightplan.sections.route')" :level="3">
        <FieldGrid>
          <Field
            :label="t('flightplan.fields.route')"
            :hint="previewNote || undefined"
            :error="errorFor('route')"
            wide
          >
            <template #default="{ id, describedby, invalid }">
              <textarea
                :id="id"
                v-model="form.route"
                class="input min-h-20 font-mono uppercase"
                :class="invalid ? 'input-error' : ''"
                placeholder="ELKUR A461 SASAN W82 PIMOL"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              ></textarea>
            </template>
          </Field>
          <Field
            :label="t('flightplan.fields.remarks')"
            :error="errorFor('remarks')"
            wide
          >
            <template #default="{ id, describedby, invalid }">
              <textarea
                :id="id"
                v-model="form.remarks"
                class="input min-h-16"
                :class="invalid ? 'input-error' : ''"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              ></textarea>
            </template>
          </Field>
        </FieldGrid>
      </PanelSection>
    </fieldset>

    <!-- 提交按钮贴在面板底部：长表单滚到一半也按得到。 -->
    <div
      class="sticky bottom-0 -mx-4 flex justify-end border-t border-subtle bg-[var(--material-regular)] px-4 py-3"
    >
      <button type="submit" class="btn btn-primary" :disabled="disabled">
        <Icon name="paperAirplane" class="size-4" />
        {{ submitLabel }}
      </button>
    </div>
  </form>
</template>
```

This needs two more keys; add them in Step 1's table as well:

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `flightplan.sections.flight` | `航班` | `航班` | `Flight` | `フライト` |
| `flightplan.sections.route` | `航路与备注` | `航路與備註` | `Route and remarks` | `航路と備考` |

`form[f.key]` and `form[p.hours]` type-check because every `Plan` field is `string`. If vue-tsc rejects `v-model` on an indexed `defineModel` ref, bind `:value="form[f.key]"` and `@input="form[f.key] = ($event.target as HTMLInputElement).value"` instead.

- [ ] **Step 6: Rewrite `src/components/flightplan/FlightPlan.vue`**

```vue
<script setup lang="ts">
/**
 * 飞行计划页的容器：读、交、撤、导入、锁定，和那一条横幅。
 *
 * 字段、状态行、SimBrief 按钮各是一个子组件（PlanForm、PlanStatusBar、
 * SimbriefImport）；**请求只在这里发**，子组件只报事件。这样「提交之后回读失败不
 * 能盖掉已提交」「409 锁定只能靠重新检查解开」这些跨越几块界面的规则只有一处。
 *
 * 另外把正在填的航路画到地图上（`preview*`）。那是**预览**，不是校验：画不出来的
 * 原因写在航路那一格的说明里，交得上交不上仍然只由 can-api 的 422 决定。
 *
 * 以下注释从旧文件原样保留：文件顶部 FlightPlan.vue 1–18 的整段说明接在这一段后面。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { announcePlanChanged, publishToMap } from "@/lib/mapBus";
import { takeDraft } from "@/lib/planDraft";
import {
  blankPlan,
  fillPlan,
  type Plan,
  type StoredPlan,
} from "@/lib/flightPlan";
import { previewKey, resolveRoute, shouldPreview } from "@/lib/routePreview";
import type { RequestState } from "@/lib/requestState";
import type { MapPoint } from "@/lib/mapBus";
import { Icon } from "@jianyuelab-org/can-ui";
import PanelSection from "@/components/ui/PanelSection.vue";
import SimbriefImport from "./SimbriefImport.vue";
import PlanStatusBar from "./PlanStatusBar.vue";
import PlanForm from "./PlanForm.vue";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const form = reactive<Plan>(blankPlan());

/*
 * 旧文件 90–130 原样：fieldErrors、loading、saving、deleting、stored、loadFailed
 * （连同它那段注释）、notice、lockedBy。删掉 `importing` —— 它搬进了
 * SimbriefImport；`disabled` 里对应那一项一并删掉。
 */

/* 旧文件 139–181：load() 与 recheck()，`fill(` 全部改成 `fillPlan(form, `。 */
/* 旧文件 183–232：applyDraft()，原样。 */
/* 旧文件 234–267：file()，原样。 */
/* 旧文件 269–298：remove()，`fill(blank())` 改成 `fillPlan(form, blankPlan())`。 */

function onImported(plan: Plan) {
  fillPlan(form, plan);
  fieldErrors.value = {};
  // 导入完**不自动提交** —— 见 SimbriefImport。
  notice.value = { kind: "ok", text: t("flightplan.notice.imported") };
}

function onImportFailed(text: string) {
  notice.value = { kind: "error", text };
}

const submitLabel = computed(() =>
  saving.value
    ? t("flightplan.actions.filing")
    : // 没读到时说「更新」而不是「提交」：不替他假设没有计划。按钮此时本来也锁着。
      stored.value || loadFailed.value
      ? t("flightplan.actions.refile")
      : t("flightplan.actions.file"),
);

/* ---- 航路预览 ---- */

const preview = ref<RequestState<MapPoint[]> | null>(null);
/** 已经推给地图的那一份。null＝还没推过，地图上仍是已提交的计划。 */
let previewedKey: string | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewAbort: AbortController | undefined;

function storedKey(): string | null {
  const s = stored.value;
  return s ? previewKey(s.departure, s.arrival, s.route) : null;
}

async function runPreview() {
  const { departure, arrival, route } = form;
  if (!shouldPreview(departure, arrival, route)) {
    // 填得还不够画。以前推过的那条已经不是框里的这条了，撤掉。撤掉之后记成空串
    // 而不是 null：地图上已经没有已提交的那份了，下次框里回到那份也要重新画。
    if (previewedKey !== null) {
      publishToMap({});
      previewedKey = "";
    }
    preview.value = null;
    return;
  }
  const key = previewKey(departure, arrival, route);
  if (key === previewedKey) return;
  // 刚打开页面、框里就是已提交的那份：地图本来就画着它，不必再问一遍。
  if (previewedKey === null && key === storedKey()) return;

  previewAbort?.abort();
  previewAbort = new AbortController();
  const signal = previewAbort.signal;
  const state = await resolveRoute(departure, arrival, route, signal);
  if (signal.aborted) return;

  previewedKey = key;
  preview.value = state;
  if (state.kind === "data") {
    publishToMap({
      points: state.data,
      label: t("flightplan.preview.label", {
        from: departure.trim().toUpperCase(),
        to: arrival.trim().toUpperCase(),
      }),
    });
  } else {
    // 画不出来就一条都不画：留着上一条，图上那条就不是框里这条了。
    publishToMap({});
  }
}

watch(
  () => [form.departure, form.arrival, form.route],
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void runPreview(), 600);
  },
);

const previewNote = computed(() => {
  switch (preview.value?.kind) {
    case "forbidden":
      return t("flightplan.preview.forbidden");
    case "error":
      return t("flightplan.preview.failed");
    case "empty":
      return t("flightplan.preview.empty");
    default:
      return "";
  }
});

onMounted(load);
onBeforeUnmount(() => {
  clearTimeout(previewTimer);
  previewAbort?.abort();
});
</script>

<template>
  <div class="space-y-6">
    <!-- 横幅：旧文件 335–369 原样（含锁定时的「重新检查」按钮）。 -->

    <PlanStatusBar
      :messages="messages"
      :loading="loading"
      :load-failed="loadFailed"
      :stored="stored"
      :disabled="disabled"
      @reload="load()"
      @delete="remove"
    />

    <PanelSection :title="t('flightplan.actions.import')" :level="3">
      <SimbriefImport
        :messages="messages"
        :disabled="disabled"
        @imported="onImported"
        @failed="onImportFailed"
      />
    </PanelSection>

    <PlanForm
      v-model:form="form"
      :messages="messages"
      :errors="fieldErrors"
      :disabled="disabled"
      :submit-label="submitLabel"
      :preview-note="previewNote"
      @submit="file"
    />
  </div>
</template>
```

`v-model:form` on a `reactive` object passes the same object; PlanForm mutates its fields in place and never reassigns `form.value`, so no copy is made. `Icon` stays imported for the pasted banner.

Two behaviour notes the executor must keep:
- The status bar's retry label is `common.refresh`, the same word the old inline link used (FlightPlan.vue 383).
- The banner's `role="status"` stays on the banner, not on StateCard; StateCard is not a live region.

- [ ] **Step 7: `src/pages/flightplan.astro`**

Change the import to `import FlightPlan from "@/components/flightplan/FlightPlan.vue";`. Nothing else changes.

- [ ] **Step 8: Gate**

Run: `bunx prettier --write src/components/flightplan src/pages/flightplan.astro language && bun test && bun run lint && bun run build`
Expected: exit 0; `check-i18n-keys` passes (it would fail on a missing `flightplan.sections.*` or `flightplan.preview.*`).

- [ ] **Step 9: Browser check**

`bun run dev`, `/flightplan` at ≥1152px, ~900px, ~390px, light and dark:
- ≥1152px: wide panel, form in two columns; ~900px and ~390px: one column.
- Type `ZBAA`, `ZSSS`, `ELKUR A461 SASAN`: after ~0.6 s a magenta line with 正在填写：ZBAA → ZSSS appears. Change the route to `XXXXX`: the line goes away and the route hint says 这串航路里没有能在图上找到的点。
- As a member without `aipAccess`: the hint says 航路预览要航图权限 …; the form still files.
- Block `/api/db/aip/resolve`: hint says 没能读取航路预览 …; no line.
- Block `/api/v1/pilot/flightplan` and reload: status bar error card, form locked, submit reads 更新计划.
- File an invalid callsign: 422 error sits under 呼号 and the input's `aria-describedby` points at it (devtools).
- File while a controller tracks the aircraft (or stub 409 `tracked`): amber banner with 重新检查; form locked until it is pressed.
- SimBrief import with no link: 还没有绑定 SimBrief 账号 … banner; with a link: form fills, nothing is filed.
- Come from `/route` with a draft: only empty fields fill, banner states the origin.
- ~390px: the sheet expands to full when a field takes focus; the submit bar stays visible at the bottom of the sheet.

- [ ] **Step 10: Commit**

```bash
git add -A src/components/flightplan src/components/FlightPlan.vue src/pages/flightplan.astro language
perl -e 'alarm 40; exec @ARGV' git commit -m "飞行计划拆成容器、状态行、SimBrief 导入和表单；边填边在地图上预览航路" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: Route page

**Files:**
- Create: `src/components/RouteTabs.vue`
- Modify: `src/components/RouteGenerator.vue` lines 86–88, 102–150, 227
- Modify: `src/components/RoutePlanner.vue` lines 62–66, 74–139, 190–210
- Modify: `src/components/ProcedurePicker.vue` lines 265–282
- Modify: `src/pages/route.astro` (whole file)
- Modify: `language/*.json` (`efb.route.tabs.*`, `efb.route.generate.forbidden.*`, `efb.route.expand.failed`, `efb.route.expand.unavailableTitle`)

**Interfaces:**
- Consumes: `StateCard`, `PanelSection` (Task 10); `RoutePlanError` from `lib/routePlan.ts` (`status: number`); `ProcedureError` from `lib/procedures.ts` (`status: number`).
- Produces: `RouteTabs.vue` props `{ messages: Record<string, unknown>; aipAccess: number }`. It is the page's only island.

**Behaviour that must survive:**
- RouteGenerator, 400 and 404 stay two different answers, 125–147; 400 keeps can-db's own message.
- RouteGenerator, the tier switch shows only from `aipAccess >= 3` and is a cap, not a grant, 40–63, 206.
- RouteGenerator, `route` stays a separate ref from `plan.route` so a second SID change can still remove the first, 66–77.
- RouteGenerator, hand-off to the flight plan sends the rewritten string and never the cruise level, 152–170.
- RouteGenerator, `plan.unrestricted` is shown from can-db's answer, not the checkbox, 238–248.
- RouteGenerator, restrictions without text show the restricted legs, 312–349; `levelBelowMtca` stays a danger card, 300–303.
- RoutePlanner, `legs` is not cleared on failure so a failed expand does not wipe the map, 99–103.
- RoutePlanner, `navDataUnavailable` is its own state, 113–117, 190–196.
- RoutePlanner, plan read failure ≠ no plan, 80–88.
- RoutePlanner, zero points after a successful expand is its own message, 205–210.
- ProcedurePicker, 401/403 is "no access", not a fault, 78–80, 117–122.
- ProcedurePicker, module-level cache per ICAO, 68–72.

**No client-side gate on Generate.** The spec says Generate "stays gated by aipAccess". There is no client gate today: the gate is can-db's 401/403. AGENTS.md forbids copying permission checks into the frontend, and instructors (rating ≥ 8) pass can-db without `aipAccess`, so a client gate on `aipAccess` would lock out people the server lets in. Generate stays visible to everyone; a 401/403 turns into a forbidden StateCard.

- [ ] **Step 1: Dictionaries**

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `route.tabs.label` | `航路工具` | `航路工具` | `Route tools` | `航路ツール` |
| `route.tabs.generate` | `生成` | `生成` | `Generate` | `生成` |
| `route.tabs.expand` | `展开` | `展開` | `Expand` | `展開` |
| `route.generate.forbidden.title` | `没有航行资料权限` | `沒有航行資料權限` | `No aeronautical data access` | `航空情報の権限がありません` |
| `route.generate.forbidden.body` | `生成航路要读资料库。这是权限，不是故障 —— 向所在管制分区申请开通。` | `生成航路要讀資料庫。這是權限，不是故障 —— 向所在管制分區申請開通。` | `Generating a route reads the aeronautical database. This is a permission, not a fault — ask your division to enable it.` | `航路の生成には航空情報データベースが必要です。障害ではなく権限の問題です。所属の管制区に申請してください。` |
| `route.expand.failed` | `没能展开这条航路` | `沒能展開這條航路` | `Couldn't expand this route` | `航路を展開できませんでした` |
| `route.expand.unavailableTitle` | `导航数据未部署` | `導航資料未部署` | `Navigation data not deployed` | `航法データ未配備` |

`route.generate` already holds strings; the new `forbidden` object sits beside them. `route.expand` is already an object (it holds `title`).

- [ ] **Step 2: Imports**

Add `import StateCard from "@/components/ui/StateCard.vue";` to the import block of `RouteGenerator.vue`, `RoutePlanner.vue` and `ProcedurePicker.vue`. The three files stay where they are.

- [ ] **Step 3: RouteGenerator.vue (bottom-up)**

Line 227, `<p v-if="error" class="text-sm text-danger">{{ error }}</p>`, becomes:

```vue
    <!-- 输入有误（400）留在一行字里：那是「改输入」，不是一种页面状态。 -->
    <p v-if="outcome?.kind === 'input'" class="text-sm text-danger">
      {{ outcome.text }}
    </p>
    <!-- 没权限：说清楚是权限，不是故障。规划器要读资料库，这一页的前端不替它判权限。 -->
    <StateCard
      v-else-if="outcome?.kind === 'forbidden'"
      kind="forbidden"
      :title="t('route.generate.forbidden.title')"
      :body="t('route.generate.forbidden.body')"
    />
    <!-- 404：这对机场在这个高度上没有走法。读到了、确实没有 —— 是「空」，不是失败。 -->
    <StateCard
      v-else-if="outcome?.kind === 'empty'"
      kind="empty"
      :title="t('route.generate.noRoute')"
      compact
    />
    <StateCard
      v-else-if="outcome?.kind === 'error'"
      kind="error"
      :title="t('route.generate.failed')"
      :retry-label="t('common.retry')"
      compact
      @retry="generate"
    />
```

Lines 102–150, `generate()`, become:

```ts
async function generate() {
  const a = from.value.trim().toUpperCase();
  const b = to.value.trim().toUpperCase();
  if (!a || !b) return;

  busy.value = true;
  outcome.value = null;
  plan.value = null;

  try {
    const result = await planRoute(
      a,
      b,
      Number(level.value) || undefined,
      canChooseTier.value && unrestricted.value,
    );
    plan.value = result;
    route.value = result.route;
    publishToMap({
      points: planToMapPoints(result),
      label: `${result.from} → ${result.to}`,
    });
  } catch (e) {
    // 四种答案，不合并成一句「失败」：400 是改输入；404 是这对机场在这个高度上没有
    // 走法，改输入也没用；401/403 是权限，向分区申请；剩下的才是真的失败，可以重试。
    const status = e instanceof RoutePlanError ? e.status : 0;
    if (status === 401 || status === 403) {
      outcome.value = { kind: "forbidden" };
    } else if (status === 404) {
      outcome.value = { kind: "empty" };
    } else if (status === 400) {
      outcome.value = {
        kind: "input",
        text:
          (e as RoutePlanError).message || t("route.generate.badInput"),
      };
    } else {
      outcome.value = { kind: "error" };
    }
  } finally {
    busy.value = false;
  }
}
```

Lines 86–88 (`busy`, `plan`, `error`) become:

```ts
const busy = ref(false);
const plan = ref<RoutePlan | null>(null);
/** 上一次生成没出结果的原因。null＝还没生成过，或者生成出来了。 */
const outcome = ref<
  | { kind: "input"; text: string }
  | { kind: "forbidden" }
  | { kind: "empty" }
  | { kind: "error" }
  | null
>(null);
```


`planRoute` already throws `RoutePlanError(response.status, …)` for every non-OK answer, 401/403 included (`lib/routePlan.ts` 144–146). A rejected `fetch` throws a plain error, which lands on `status = 0` → `error`.

- [ ] **Step 4: RoutePlanner.vue (bottom-up)**

Lines 190–210, from `<div v-if="unavailable"` down to the `noPoints` paragraph, become:

```vue
    <StateCard
      v-if="unavailable"
      kind="empty"
      :title="t('route.expand.unavailableTitle')"
      :body="t('route.navdataUnavailable')"
    />
    <StateCard
      v-else-if="problem?.kind === 'error'"
      kind="error"
      :title="problem.title"
      :body="problem.body"
      :retry-label="t('common.retry')"
      compact
      @retry="problem.retry === 'plan' ? fromPlan() : resolve()"
    />
    <StateCard
      v-else-if="problem?.kind === 'empty'"
      kind="empty"
      :title="problem.title"
      compact
    />

    <template v-else-if="resolved">
      <StateCard
        v-if="!legs.length"
        kind="empty"
        :title="t('route.noPoints')"
        compact
      />
```

The closing `</template>` structure and the table below stay as they are. The outer `<div class="card space-y-4 p-5">` around the inputs loses `card` and `p-5` (the panel is the card now).

Lines 74–139: in `fromPlan()` and `resolve()`, replace every `error.value = …` as follows:

| Old | New |
| --- | --- |
| `error.value = t("route.planFailed");` | `problem.value = { kind: "error", title: t("route.planFailed"), retry: "plan" };` |
| `error.value = t("route.noPlan");` | `problem.value = { kind: "empty", title: t("route.noPlan") };` |
| `error.value = "";` (both) | `problem.value = null;` |
| `error.value = describeFailure(t, result);` | `problem.value = { kind: "error", title: t("route.expand.failed"), body: describeFailure(t, result), retry: "resolve" };` |

Lines 62–66: replace `const error = ref("");` with:

```ts
/**
 * 上一次操作没出结果的原因。读计划失败和展开失败都能重试，但重试的是不同的事，所
 * 以记下重试哪一个。「没有计划」是读到了、确实没有 —— 空，不给重试。
 */
const problem = ref<
  | { kind: "error"; title: string; body?: string; retry: "plan" | "resolve" }
  | { kind: "empty"; title: string }
  | null
>(null);
```


- [ ] **Step 5: ProcedurePicker.vue lines 265–282**

The `<h3>` and the three state paragraphs become:

```vue
    <h3 class="text-sm font-semibold text-ink">
      {{ t("route.procedures.title") }}
    </h3>

    <StateCard
      v-if="busy"
      kind="loading"
      :title="t('route.procedures.loading')"
      compact
    />
    <!-- 没权限是常态，不是故障 —— 和别的失败分开说。 -->
    <StateCard
      v-else-if="denied"
      kind="forbidden"
      :title="t('route.procedures.denied')"
      compact
    />
    <StateCard
      v-else-if="failed"
      kind="error"
      :title="t('route.procedures.failed')"
      :retry-label="t('common.retry')"
      compact
      @retry="loadBoth"
    />
```

`loadBoth` retries both airports; the module cache (68–72) already holds whichever one succeeded, so only the failed one is fetched again.

- [ ] **Step 6: `src/components/RouteTabs.vue`**

```vue
<script setup lang="ts">
/**
 * 航路页的两件事：生成、展开。**先生成，后展开** —— 还没有航路的人要第一件，已经有
 * 一串航路的人要第二件（route.astro 原来的顺序和理由）。
 *
 * 做成标签页而不是上下两段：面板只有 26rem 宽，两段叠着的话展开那一段永远在折叠
 * 线以下，手机上更是整整一屏之外。
 *
 * 两个面板用 `v-show` 而不是 `v-if`：切过去再切回来，生成的结果、选好的程序、展开
 * 的表格都还在。生成器里的程序缓存本来就是模块级的，这里只是不把组件本身卸掉。
 *
 * 键盘按 WAI-ARIA 标签页的做法：左右箭头换标签并激活，Home/End 到两端，只有当前
 * 那个标签在 Tab 顺序里。
 */
import { nextTick, ref, useId } from "vue";
import { createTranslator } from "@/lib/i18n";
import PanelSection from "@/components/ui/PanelSection.vue";
import RouteGenerator from "./RouteGenerator.vue";
import RoutePlanner from "./RoutePlanner.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  aipAccess: number;
}>();
const t = createTranslator(props.messages);

const TABS = ["generate", "expand"] as const;
type Tab = (typeof TABS)[number];

const base = useId();
const active = ref<Tab>("generate");
const tabEls = ref<HTMLButtonElement[]>([]);

function select(tab: Tab) {
  active.value = tab;
}

async function onKey(event: KeyboardEvent) {
  const i = TABS.indexOf(active.value);
  const next =
    event.key === "ArrowRight"
      ? (i + 1) % TABS.length
      : event.key === "ArrowLeft"
        ? (i - 1 + TABS.length) % TABS.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? TABS.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  select(TABS[next]);
  await nextTick();
  tabEls.value[next]?.focus();
}
</script>

<template>
  <div class="space-y-5">
    <div
      role="tablist"
      :aria-label="t('route.tabs.label')"
      class="flex gap-1 rounded-control bg-surface-sunken p-1"
      @keydown="onKey"
    >
      <button
        v-for="tab in TABS"
        :id="`${base}-tab-${tab}`"
        :key="tab"
        ref="tabEls"
        type="button"
        role="tab"
        :aria-selected="active === tab"
        :aria-controls="`${base}-panel-${tab}`"
        :tabindex="active === tab ? 0 : -1"
        class="flex-1 rounded-control px-3 py-1.5 text-sm font-medium transition-colors"
        :class="
          active === tab
            ? 'bg-surface text-ink shadow-sm'
            : 'text-muted hover:text-ink'
        "
        @click="select(tab)"
      >
        {{ t(`route.tabs.${tab}`) }}
      </button>
    </div>

    <div
      v-show="active === 'generate'"
      :id="`${base}-panel-generate`"
      role="tabpanel"
      :aria-labelledby="`${base}-tab-generate`"
      tabindex="0"
    >
      <PanelSection :title="t('route.generate.title')">
        <RouteGenerator :messages="messages" :aip-access="aipAccess" />
      </PanelSection>
    </div>

    <div
      v-show="active === 'expand'"
      :id="`${base}-panel-expand`"
      role="tabpanel"
      :aria-labelledby="`${base}-tab-expand`"
      tabindex="0"
    >
      <PanelSection :title="t('route.expand.title')">
        <RoutePlanner :messages="messages" />
      </PanelSection>
    </div>
  </div>
</template>
```

RoutePlanner publishes to the map from a `watch` on `legs` (RoutePlanner.vue 59–61). While hidden by `v-show` it publishes nothing new, so switching tabs never repaints the map by itself. The map keeps the last thing either tab drew; that is intended.

- [ ] **Step 7: Rewrite `src/pages/route.astro`**

```astro
---
import AppLayout from "@/layouts/AppLayout.astro";
import RouteTabs from "@/components/RouteTabs.vue";
import { getLocale, getMessages, useTranslations } from "@/lib/i18n";

const locale = getLocale(Astro.cookies);
const t = useTranslations(locale, "efb");
const title = t("pages.route.title");
const description = t("pages.route.description");
---

<AppLayout title={title} description={description}>
  {
    /*
    两件事，顺序是刻意的：**先生成，后展开**（见 RouteTabs.vue）。
    生成走 can-db 的规划器，展开走 can-api —— 见 lib/routePlan.ts 顶上的对照。
    aipAccess 只决定生成器里那个「不使用受限汇编」开关出不出，不是权限判断。
  */
  }
  <RouteTabs
    messages={getMessages(locale, "efb")}
    aipAccess={Astro.locals.user?.aipAccess ?? 0}
    client:load
  />
</AppLayout>
```

- [ ] **Step 8: Gate**

Run: `bunx prettier --write src/components/RouteTabs.vue src/components/RouteGenerator.vue src/components/RoutePlanner.vue src/components/ProcedurePicker.vue src/pages/route.astro language && bun test && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 9: Browser check**

`bun run dev`, `/route` at ≥1152px, ~900px, ~390px, light and dark:
- Tabs: Tab lands on 生成; ←/→ switch and move focus; the panel content survives switching back.
- Generate ZBAA → ZSSS: magenta line, route string, procedures. Change the SID twice: the first SID is gone from the string.
- As a member without `aipAccess` (and not an instructor): Generate shows the 没有航行资料权限 card, not 生成失败.
- Stub a 404: 这两个机场之间没有可用的走法 as an empty card, no retry. Stub a 400: the red line under the inputs.
- Block `/api/db/*`: 生成失败 card with 重试.
- Expand: block `/api/v1/route` → 没能展开这条航路 with 重试, and the previously drawn line stays on the map. 从我的计划填入 with the plan request blocked → error with 重试 that re-reads the plan.
- ~390px: tabs fit on one row; the leg table scrolls horizontally inside the sheet, not the page.

- [ ] **Step 10: Commit**

```bash
git add src/components/RouteTabs.vue src/components/RouteGenerator.vue src/components/RoutePlanner.vue src/components/ProcedurePicker.vue src/pages/route.astro language
perl -e 'alarm 40; exec @ARGV' git commit -m "航路页改成生成/展开两个标签；没权限、没有、失败各用各的状态卡" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: Airports and 404

**Files:**
- Modify: `src/components/Airports.vue` (rewrite)
- Create: `src/components/AirportDetail.vue`
- Modify: `src/lib/airports.ts` (append `AirportRow`)
- Modify: `src/pages/airports.astro` lines 17–72
- Modify: `src/pages/404.astro` lines 9–24
- Modify: `src/pages/api/db/[...path].ts` line 60 (`who` of `aip/airports`) and line 118 (`who` of the detail route)
- Modify: `language/*.json` (`efb.airports.empty`, `efb.airports.detail.*`)

**Interfaces:**
- Consumes: `RequestState`, `fromDbResponse` (Task 9); `StateCard`, `PanelSection` (Task 10); `focusMap` (Task 3); `publishToMap`; `unwrapList` (`lib/aip.ts`); `fetchAirportProcedures`, `ProcedureError`, `runwayIdents`, `AirportProcedures` (`lib/procedures.ts`); `AirportRow` (Step 4).
- Produces:
  ```ts
  // Airports.vue
  props: { initial: RequestState<Airport[]>; messages: Record<string, unknown> }
  // AirportDetail.vue
  props: { airport: Airport; messages: Record<string, unknown> }
  emits: { back: [] }
  ```

**Behaviour that must survive:**
- 401/403 is a normal outcome with its own wording, not a fault; the page does not re-judge permission, airports.astro 1–16, 30.
- Other failures say it is a fault and not a permission problem, airports.astro 37–61 → now with retry.
- Nothing is listed until something is typed; results capped at 12, and the cap is said out loud, Airports.vue 45–75, 128–143.
- Selecting pushes only that airport, never the whole list, so the member's plan is not wiped for nothing, Airports.vue 91–106.
- Markers, not points: airports never get joined into a line, Airports.vue 9–11.

**Task 5 already touched this file** (17–19, 91–106: `show()` calls `publishToMap` then `focusMap`). Citations below are at `29b690d`; the rewrite in Step 5 supersedes Task 5's edit and keeps its behaviour.

**Change to the island's own rule.** Airports.vue 4–8 says the island never fetches in the browser. Retry has to. The path it uses, `/api/db/aip/airports`, is already on the proxy allow-list for `lib/airports.ts` (`[...path].ts` 58–61), so retry opens nothing new. The comment is rewritten to say that; the first load still comes from SSR.

- [ ] **Step 1: Dictionaries**

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `airports.empty` | `资料库里没有机场数据。` | `資料庫裡沒有機場資料。` | `The database has no airports.` | `データベースに空港データがありません。` |
| `airports.detail.back` | `返回列表` | `返回列表` | `Back to list` | `一覧に戻る` |
| `airports.detail.position` | `位置` | `位置` | `Position` | `位置` |
| `airports.detail.runways` | `跑道` | `跑道` | `Runways` | `滑走路` |
| `airports.detail.noRunways` | `资料库里这个机场没有跑道数据。` | `資料庫裡這個機場沒有跑道資料。` | `The database has no runways for this airport.` | `この空港の滑走路データはありません。` |
| `airports.detail.runwaysFailed` | `没能读取跑道 —— 这不代表没有。` | `沒能讀取跑道 —— 這不代表沒有。` | `Couldn't load the runways — that doesn't mean there are none.` | `滑走路を取得できませんでした。存在しないという意味ではありません。` |

- [ ] **Step 2: Nothing moves.** `Airports.vue` stays at `src/components/`, beside the new `AirportDetail.vue`.

- [ ] **Step 3: `src/components/AirportDetail.vue`**

```vue
<script setup lang="ts">
/**
 * 一个机场的详情：标高、位置、机位数、跑道。
 *
 * 跑道走 can-db 的机场详情（和进离场程序选择器同一个接口、同一份缓存形状）。那个
 * 接口的门和列表一样，但**能看到列表不等于一定能看到详情** —— 两次请求之间权限可
 * 能变，所以 401/403 在这里也单独说。
 */
import { onMounted, ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import {
  fetchAirportProcedures,
  ProcedureError,
  runwayIdents,
} from "@/lib/procedures";
import { LOADING, type RequestState } from "@/lib/requestState";
import StateCard from "@/components/ui/StateCard.vue";
import PanelSection from "@/components/ui/PanelSection.vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { AirportRow as Airport } from "@/lib/airports";

const props = defineProps<{
  airport: Airport;
  messages: Record<string, unknown>;
}>();
const emit = defineEmits<{ back: [] }>();
const t = createTranslator(props.messages);

const runways = ref<RequestState<string[]>>(LOADING);

async function loadRunways() {
  runways.value = LOADING;
  try {
    const data = await fetchAirportProcedures(props.airport.icao);
    const idents = runwayIdents(data.runways);
    runways.value = idents.length
      ? { kind: "data", data: idents }
      : { kind: "empty" };
  } catch (e) {
    const status = e instanceof ProcedureError ? e.status : 0;
    runways.value =
      status === 401 || status === 403
        ? { kind: "forbidden", status }
        : { kind: "error", status };
  }
}

onMounted(loadRunways);
watch(() => props.airport.icao, loadRunways);
</script>

<template>
  <div class="space-y-5">
    <button type="button" class="link text-sm" @click="emit('back')">
      <Icon name="arrowLeft" class="inline size-4" />
      {{ t("airports.detail.back") }}
    </button>

    <header>
      <h2 class="font-mono text-2xl font-semibold text-ink">
        {{ airport.icao }}
      </h2>
      <p v-if="airport.name" class="mt-1 text-sm text-muted">
        {{ airport.name }}
      </p>
    </header>

    <dl class="grid grid-cols-2 gap-3 text-sm">
      <div v-if="airport.fir">
        <dt class="text-xs uppercase tracking-wide text-faint">FIR</dt>
        <dd class="font-mono text-ink">{{ airport.fir }}</dd>
      </div>
      <div v-if="airport.elev !== null">
        <dt class="text-xs uppercase tracking-wide text-faint">
          {{ t("airports.elev") }}
        </dt>
        <dd class="font-mono text-ink">{{ airport.elev }} ft</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-faint">
          {{ t("airports.detail.position") }}
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ airport.lat.toFixed(4) }}, {{ airport.lon.toFixed(4) }}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-faint">
          {{ t("airports.stands") }}
        </dt>
        <dd class="font-mono text-ink">{{ airport.stands }}</dd>
      </div>
    </dl>

    <PanelSection :title="t('airports.detail.runways')" :level="3">
      <StateCard
        v-if="runways.kind === 'loading'"
        kind="loading"
        :title="t('common.loading')"
        compact
      />
      <StateCard
        v-else-if="runways.kind === 'forbidden'"
        kind="forbidden"
        :title="t('airports.denied.title')"
        :body="t('airports.denied.body')"
        compact
      />
      <StateCard
        v-else-if="runways.kind === 'error'"
        kind="error"
        :title="t('airports.detail.runwaysFailed')"
        :retry-label="t('common.retry')"
        compact
        @retry="loadRunways"
      />
      <StateCard
        v-else-if="runways.kind === 'empty'"
        kind="empty"
        :title="t('airports.detail.noRunways')"
        compact
      />
      <ul v-else class="flex flex-wrap gap-2">
        <li
          v-for="rwy in runways.data"
          :key="rwy"
          class="rounded-control border border-subtle px-2 py-1 font-mono text-sm text-ink"
        >
          {{ rwy }}
        </li>
      </ul>
    </PanelSection>
  </div>
</template>
```

`runwayIdents` (`lib/procedures.ts` 206–225) returns the de-duplicated runway-end designators (`01L`, `01R`, `19R`, …) sorted by number, the same list ProcedurePicker's runway `<select>` shows.

- [ ] **Step 4: `AirportRow` in `src/lib/airports.ts`**

Append:

```ts
/**
 * 机场页列表的一行。和 `server/canDb.ts` 的 `AirportSummary` 逐字对齐 —— 两边读
 * 的是同一个接口。不直接 import 那个类型：那个文件服务端专用，岛屿一侧只留这一份。
 * 形状分叉了就会有一边悄悄读到 undefined，改一处就要改另一处。
 */
export interface AirportRow {
  icao: string;
  fir: string | null;
  name: string | null;
  lat: number;
  lon: number;
  elev: number | null;
  variation: number | null;
  airac: string;
  /** 机位数，不是机位本身 —— 详情接口才给数组。 */
  stands: number;
}
```

`Airports.vue` 21–30 (its local `interface Airport`) is deleted; the island uses this type.

- [ ] **Step 5: Rewrite `src/components/Airports.vue`**

Keep the script's doc comment 1–16 but replace its paragraph 4–8 (为什么是 props …) with:

```
 * **第一次由页面在服务端取好传进来**（`initial`）：SSR 时 `server/canDb.ts` 已经
 * 带着成员的 cookie 问过一次，打开页面不必再等一个往返。**重试在浏览器里做**，走
 * `/api/db/aip/airports` —— 那条本来就在本站反代白名单上（地面图层的机场索引也读
 * 它），重试不多开任何一条路。
```

Keep `filtered`, `matchCount`, `MAX_RESULTS` and their comments (40–81) with `props.airports` replaced by `airports.value`. Replace the rest of the script and the whole template:

```vue
<script setup lang="ts">
/* ── 文件头注释：见上 ── */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import { focusMap, publishToMap } from "@/lib/mapBus";
import { unwrapList } from "@/lib/aip";
import { fromDbResponse, LOADING, type RequestState } from "@/lib/requestState";
import StateCard from "@/components/ui/StateCard.vue";
import AirportDetail from "./AirportDetail.vue";
import type { AirportRow as Airport } from "@/lib/airports";

const props = defineProps<{
  initial: RequestState<Airport[]>;
  messages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

const state = ref<RequestState<Airport[]>>(props.initial);
const airports = computed(() =>
  state.value.kind === "data" ? state.value.data : [],
);

async function reload() {
  state.value = LOADING;
  const response = await fetch("/api/db/aip/airports").catch(() => null);
  if (!response) {
    state.value = { kind: "error", status: 0 };
    return;
  }
  const list = response.ok
    ? unwrapList<Airport>(await response.json().catch(() => null))
    : null;
  state.value = fromDbResponse(response.ok, response.status, list, (l) => !l.length);
}

const query = ref("");
const selected = ref<Airport | null>(null);

/* Airports.vue 40–81 原样：MAX_RESULTS、filtered、matchCount 及其注释，
   `props.airports` 改成 `airports.value`。 */

/**
 * 挑中一个机场：**只推那一个**，不铺全量（Airports.vue 91–100 的理由原样保留）。
 * 镜头走 `map:focus` 而不是 payload 里的 focus：推送只管画什么，镜头是另一件事。
 */
function show(airport: Airport) {
  selected.value = airport;
  publishToMap({
    markers: [
      { ident: airport.icao, lat: airport.lat, lon: airport.lon, kind: "airport" },
    ],
    label: airport.name ? `${airport.icao} · ${airport.name}` : airport.icao,
  });
  focusMap({ kind: "point", lat: airport.lat, lon: airport.lon, zoom: 10 });
}
</script>

<template>
  <StateCard
    v-if="state.kind === 'loading'"
    kind="loading"
    :title="t('common.loading')"
  />
  <!-- 没权限是大多数飞行员的常态，不是故障：说清楚谁能开通。 -->
  <StateCard
    v-else-if="state.kind === 'forbidden'"
    kind="forbidden"
    :title="t('airports.denied.title')"
    :body="t('airports.denied.body')"
  />
  <StateCard
    v-else-if="state.kind === 'error'"
    kind="error"
    :title="t('airports.error.title')"
    :body="t('airports.error.body')"
    :retry-label="t('common.retry')"
    @retry="reload"
  />
  <StateCard
    v-else-if="state.kind === 'empty'"
    kind="empty"
    :title="t('airports.empty')"
  />

  <AirportDetail
    v-else-if="selected"
    :airport="selected"
    :messages="messages"
    @back="selected = null"
  />

  <div v-else class="flex flex-col gap-4">
    <!-- Airports.vue 112–177 的搜索框、提示、截断说明和列表原样，改两处：
         `props.airports.length` → `airports.length`；
         列表按钮的 `selected === airport.icao` → `selected?.icao === airport.icao`。 -->
  </div>
</template>
```

Returning from the detail keeps `query`, so the list comes back as it was.

- [ ] **Step 6: `src/pages/airports.astro` lines 17–72**

```astro
import AppLayout from "@/layouts/AppLayout.astro";
import Airports from "@/components/Airports.vue";
import { getLocale, getMessages, useTranslations } from "@/lib/i18n";
import { fromDbResponse } from "@/lib/requestState";
import { listAirports } from "@/server/canDb";

const locale = getLocale(Astro.cookies);
const t = useTranslations(locale, "efb");
const title = t("pages.airports.title");
const description = t("pages.airports.description");

// 401/403、别的失败、空、有数据 —— 四种结果在 fromDbResponse 里分开，岛屿各说各的。
const result = await listAirports(Astro);
const initial = fromDbResponse(
  result.ok,
  result.status,
  result.data,
  (list) => !list.length,
);
---

<AppLayout title={title} description={description}>
  <Airports
    initial={initial}
    messages={getMessages(locale, "efb")}
    client:load
  />
</AppLayout>
```

The frontmatter doc comment 1–16 stays; its "三种结果" list gains a fourth line: `成功但为空 → 资料库里没有机场（不是失败，也不是权限）`.

- [ ] **Step 7: `src/pages/404.astro` lines 9–24**

```astro
import AppLayout from "@/layouts/AppLayout.astro";
import StateCard from "@/components/ui/StateCard.vue";
import { getLocale, useTranslations } from "@/lib/i18n";

const t = useTranslations(getLocale(Astro.cookies), "efb");
---

<AppLayout title={t("notFound.title")}>
  {/* 不加 client: —— 这一页没有要在浏览器里做的事，StateCard 只渲染一次 HTML。 */}
  <StateCard kind="empty" title={t("notFound.title")} body={t("notFound.body")}>
    <a slot="action" href="/" class="btn btn-primary">{t("notFound.home")}</a>
  </StateCard>
</AppLayout>
```

Astro passes a named slot to a Vue component through `slot="action"`.

- [ ] **Step 8: Proxy allow-list comments**

In `src/pages/api/db/[...path].ts`: line 60 `who` becomes `"lib/airports.ts，地面图层的机场索引；Airports.vue 的重试"`; the detail route's `who` (line 118, `lib/procedures.ts，进离场程序与跑道的选择器`) becomes `"lib/procedures.ts：进离场程序选择器、机场详情的跑道"`.

- [ ] **Step 9: Gate**

Run: `bunx prettier --write src/components/Airports.vue src/components/AirportDetail.vue src/lib/airports.ts src/pages/airports.astro src/pages/404.astro "src/pages/api/db/[...path].ts" language && bun test && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 10: Browser check**

`bun run dev`, `/airports` and `/nowhere` at ≥1152px, ~900px, ~390px, light and dark:
- Nothing listed until typing; `Z` shows 12 and the truncation line.
- Select ZBAA: one marker, the camera flies to zoom 10 and clears the panel (the airport sits in the visible map area, not under the panel); the detail shows runways. 返回列表 restores the query.
- As a member without `aipAccess`: the forbidden card, not an error.
- Stop can-db (or point `CAN_DB_ORIGIN` at a dead port) and reload: error card with 重试; start it again and press 重试: the list loads without a page reload.
- Block `/api/db/aip/airports/*` then open a detail: 没能读取跑道 with 重试.
- `/nowhere`: the 404 card inside the panel with 回到概览; the rail and map are present.

- [ ] **Step 11: Commit**

```bash
git add src/components/Airports.vue src/components/AirportDetail.vue src/lib/airports.ts src/pages/airports.astro src/pages/404.astro "src/pages/api/db/[...path].ts" language
perl -e 'alarm 40; exec @ARGV' git commit -m "机场页加上详情与跑道，失败可重试；404 用状态卡" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: Settings

**Files:**
- Modify: `src/components/Settings.vue` (template 123–276 rewritten; script gains sign-out and props)
- Modify: `src/pages/settings.astro` lines 1–30
- Modify: `src/styles/globals.css` (append `.phone-hidden` beside `.phone-only`)
- Modify: `language/*.json` (`efb.settings.local.theme`, `efb.settings.local.themeHint` reworded)

**Interfaces:**
- Consumes: `PanelSection`, `StateCard` (Task 10); `ThemeLangControls`, `Icon` from can-ui; `NavSection` from `lib/nav.ts`; `effectiveRail` (already wired in Task 8).
- Produces: `Settings.vue` props
  ```ts
  { messages: Record<string, unknown>; userName: string; userId: string; email: string; rating: number; crossLinks: NavSection; locale: string }
  ```

**Behaviour that must survive (Settings.vue at `29b690d`):**
- Account is read-only and rendered from the session; the page never fetches `/pilot/data`, settings.astro 11–14; Settings.vue 4–5.
- SimBrief read failure ≠ not linked; a failed read never shows the link input, 32–53, 188–200.
- Linking echoes the numeric ID can-api stored, not the typed alias, 6–8, 70.
- Rail preference is written to `data-rail` and `localStorage` only; the switch follows the attribute through a `MutationObserver`, 93–119 (as changed by Task 8).
- Sign-out always navigates, even on failure (AppRail.vue 165–179; copied here for the phone).

**Phone.** There is no rail on the phone (Task 8), so the account name, sign-out, theme/language and cross-site links have no home there. They go in a `.phone-only` block at the end of this page. The rail switch is meaningless on the phone and is hidden with `.phone-hidden`.

- [ ] **Step 1: Dictionaries**

| Key | zh-cn | zh-tw | en-us | ja-jp |
| --- | --- | --- | --- | --- |
| `settings.local.theme` | `主题与语言` | `主題與語言` | `Theme and language` | `テーマと言語` |
| `settings.local.themeHint` (reworded) | `只影响这台设备。` | `只影響這台裝置。` | `Applies to this device only.` | `この端末にのみ適用されます。` |

The old `themeHint` said theme and language live at the bottom of the rail. They are on this page now.

- [ ] **Step 2: CSS**

Append to the `.phone-only` block in `src/styles/globals.css` (added in Task 7):

```css
/* 反过来：手机上没有意义的东西（比如「默认收起侧栏」—— 手机上没有侧栏）。 */
@media (max-width: 767.98px) {
  .phone-hidden {
    display: none !important;
  }
}
```

- [ ] **Step 3: Script changes in `Settings.vue`**

Doc comment 1–12: add a fourth item.

```
 * 4. **手机上的账户与跨站链接** —— 手机没有侧栏，退出登录、主题语言、去主站和
 *    别的卫星站的链接没有别的家，放在这一页最底下，只在手机上出现（`.phone-only`）。
```

Imports (13–16) become:

```ts
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { effectiveRail } from "@/lib/panelLayout";
import type { NavSection } from "@/lib/nav";
import { Icon, ThemeLangControls } from "@jianyuelab-org/can-ui";
import PanelSection from "@/components/ui/PanelSection.vue";
import StateCard from "@/components/ui/StateCard.vue";
```

Props (18–24) gain `crossLinks: NavSection;` and `locale: string;`.

After `unlink()` add:

```ts
/* ------------------------------------------------------------ 退出登录 */

/**
 * 和轨上那颗按钮是同一件事（AppRail.vue 的 handleSignOut）：清 cookie 是 can-api
 * 的活，跳转是我们的，**无论成败都跳**。手机上没有轨，这是唯一的入口。
 */
const signingOut = ref(false);
function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  api("/api/v1/auth/signout", { method: "POST" }).finally(() => {
    window.location.assign("/");
  });
}
```

In `loadSimbrief()` the failure branch no longer sets `notice` (the StateCard says it now); delete `notice.value = { kind: "error", text: describeFailure(t, result) };` there and keep the failure for the card body:

```ts
/** 读绑定失败时那一句具体原因，给状态卡的正文。 */
const loadFailure = ref("");
```

and in the failure branch: `loadFailed.value = true; loadFailure.value = describeFailure(t, result);`.

- [ ] **Step 4: Template (replaces 122–276)**

```vue
<template>
  <div class="space-y-8">
    <PanelSection
      :title="t('settings.account.title')"
      :description="t('settings.account.hint')"
    >
      <dl class="grid gap-4 @sm:grid-cols-2">
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.name") }}
          </dt>
          <dd class="mt-0.5 truncate text-sm font-medium text-ink">
            {{ userName }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.id") }}
          </dt>
          <dd class="mt-0.5 font-mono text-sm text-ink">{{ userId }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.email") }}
          </dt>
          <dd class="mt-0.5 truncate text-sm text-ink">{{ email }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.rating") }}
          </dt>
          <dd class="mt-0.5 text-sm text-ink">{{ rating }}</dd>
        </div>
      </dl>
    </PanelSection>

    <PanelSection
      :title="t('settings.local.title')"
      :description="t('settings.local.hint')"
    >
      <div class="space-y-4">
        <!-- 手机上没有侧栏，这个开关在那里什么都不做，不摆出来。 -->
        <div class="phone-hidden flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p :id="railLabelId" class="text-sm font-medium text-ink">
              {{ t("settings.local.rail") }}
            </p>
            <p class="text-xs text-muted">{{ t("settings.local.railHint") }}</p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="railCollapsed"
            :aria-labelledby="railLabelId"
            :class="[
              'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
              railCollapsed ? 'bg-can' : 'bg-surface-sunken',
            ]"
            @click="toggleRail(!railCollapsed)"
          >
            <span
              :class="[
                'my-0.5 size-5 rounded-full bg-white shadow-card transition-transform',
                railCollapsed ? 'translate-x-5' : 'translate-x-0.5',
              ]"
            ></span>
          </button>
        </div>

        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium text-ink">
              {{ t("settings.local.theme") }}
            </p>
            <p class="text-xs text-muted">{{ t("settings.local.themeHint") }}</p>
          </div>
          <ThemeLangControls :locale="locale" />
        </div>
      </div>
    </PanelSection>

    <PanelSection
      :title="t('settings.simbrief.title')"
      :description="t('settings.simbrief.hint')"
    >
      <div
        v-if="notice"
        :class="[
          'mb-4 flex items-start gap-2 rounded-control px-3 py-2 text-sm',
          notice.kind === 'ok'
            ? 'bg-success-bg text-success-fg'
            : 'bg-danger-bg text-danger-fg',
        ]"
        role="status"
      >
        <Icon
          :name="notice.kind === 'ok' ? 'checkCircle' : 'exclamationTriangle'"
          class="mt-px size-4 shrink-0"
        />
        <span>{{ notice.text }}</span>
      </div>

      <StateCard
        v-if="loading"
        kind="loading"
        :title="t('common.loading')"
        compact
      />
      <!-- **读失败不等于没绑定**：这一支必须排在「未绑定」前面，见 loadSimbrief()。 -->
      <StateCard
        v-else-if="loadFailed"
        kind="error"
        :title="t('settings.simbrief.loadFailed')"
        :body="loadFailure || undefined"
        :retry-label="t('common.retry')"
        compact
        @retry="loadSimbrief"
      />

      <div
        v-else-if="simbriefId"
        class="flex flex-wrap items-center gap-3 text-sm"
      >
        <span class="badge badge-success">
          <Icon name="checkCircle" class="size-3" />
          {{ t("settings.simbrief.bound") }}
        </span>
        <span class="font-mono text-ink">{{ simbriefId }}</span>
        <button
          type="button"
          class="btn btn-danger ml-auto"
          :disabled="busy"
          @click="unlink"
        >
          {{ t("settings.simbrief.unlink") }}
        </button>
      </div>

      <form v-else class="flex flex-col gap-2 @sm:flex-row" @submit.prevent="link">
        <label :for="simbriefInputId" class="sr-only">{{
          t("settings.simbrief.placeholder")
        }}</label>
        <input
          :id="simbriefInputId"
          v-model="identifier"
          class="input @sm:max-w-xs"
          autocomplete="off"
          :placeholder="t('settings.simbrief.placeholder')"
        />
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="busy || !identifier.trim()"
        >
          {{ t("settings.simbrief.link") }}
        </button>
      </form>
    </PanelSection>

    <!-- 手机专用：轨上那几样的家。平板和桌面上它们在轨里，这里不重复。 -->
    <div class="phone-only space-y-8">
      <PanelSection :title="crossLinks.label ?? ''">
        <ul class="divide-y divide-subtle">
          <li v-for="link in crossLinks.items" :key="link.href">
            <a
              :href="link.href"
              class="flex items-center gap-3 py-3 text-sm text-ink"
              :target="link.external ? '_blank' : undefined"
              :rel="link.external ? 'noopener' : undefined"
            >
              <Icon :name="link.icon" class="size-5 text-muted" />
              <span class="flex-1">{{ link.name }}</span>
              <Icon
                v-if="link.external"
                name="arrowTopRight"
                class="size-4 text-faint"
              />
            </a>
          </li>
        </ul>
      </PanelSection>

      <button
        type="button"
        class="btn btn-secondary w-full"
        :disabled="signingOut"
        @click="signOut"
      >
        <Icon name="arrowRightOnRectangle" class="size-4" />
        {{ t("account.signOut") }}
      </button>
    </div>
  </div>
</template>
```

Add to the script, next to the rail state:

```ts
const railLabelId = useId();
const simbriefInputId = useId();
```

The Enter-key handler on the input (old 225) is replaced by the `<form>`'s submit.

- [ ] **Step 5: `src/pages/settings.astro`**

```astro
---
import AppLayout from "@/layouts/AppLayout.astro";
import Settings from "@/components/Settings.vue";
import { getLocale, getMessages, useTranslations } from "@/lib/i18n";
import { buildCrossLinks } from "@/lib/nav";

const locale = getLocale(Astro.cookies);
const t = useTranslations(locale, "efb");
const title = t("pages.settings.title");
const description = t("pages.settings.description");

// 账户那一块是**只读**的，所以直接从会话渲染，不再向 can-api 要一次
// /pilot/data —— 那个接口会带回 FSD 网络密码，一个只想显示名字和评级的页面不
// 该把它取到进程里来。
const session = Astro.locals.user;
---

<AppLayout title={title} description={description} panel="wide">
  <Settings
    messages={getMessages(locale, "efb")}
    userName={session?.name ?? session?.username ?? ""}
    userId={session?.username ?? ""}
    email={session?.email ?? ""}
    rating={session?.rating ?? 0}
    crossLinks={buildCrossLinks(t)}
    locale={locale}
    client:load
  />
</AppLayout>
```

(`panel="wide"` was set in Task 7; keep it.)

- [ ] **Step 6: Gate**

Run: `bunx prettier --write src/components/Settings.vue src/pages/settings.astro src/styles/globals.css language && bun run lint && bun run build`
Expected: exit 0.

- [ ] **Step 7: Browser check**

`bun run dev`, `/settings` at ≥1152px, ~900px, ~390px, light and dark:
- ≥1152px: wide panel, account in two columns; the rail switch reflects the rail and flips it; the rail's own button flips the switch.
- ~900px with nothing stored: the switch reads collapsed (the tablet default, `auto`); flipping it stores a choice.
- ~390px: no rail switch; theme/language control works; the links block and 退出登录 are at the bottom; sign-out lands on `/` even with `/api/v1/auth/signout` blocked.
- Block `/api/v1/pilot/simbrief`: error card with 重试, never the link input. Unblock, 重试: bound or input.
- Link with an alias: the echoed value is the numeric ID.

- [ ] **Step 8: Commit**

```bash
git add src/components/Settings.vue src/pages/settings.astro src/styles/globals.css language
perl -e 'alarm 40; exec @ARGV' git commit -m "设置页：三组分区、主题语言搬进来；手机上补上退出登录和跨站链接" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Hydration audit and dead code

**Files:**
- Delete: `src/components/Placeholder.astro`
- Modify: `language/*.json` (delete the `efb.placeholder` object)
- Modify: `src/lib/nav.ts` line 60 (comment naming `Placeholder`)
- Modify: every file `grep` below still lists

**Interfaces:** none.

**Why this is an audit.** The spec's step 7 is "only the rail, the map and one page island hydrate". After Tasks 7–16 that is already true: each page renders one `client:load` island, and `FloatingPanel` is Astro plus a module script. This task proves it and removes what the redesign left behind.

- [ ] **Step 1: Hydration count**

Run: `grep -rn "client:" src --include=*.astro | grep -v "^\s*\*" | grep -v "不加 \`client:"`
Expected, and nothing else:

```
src/layouts/AppLayout.astro:…  <AppRail … client:load
src/layouts/AppLayout.astro:…  <MapStage … client:load
src/pages/index.astro:…        client:load   (Dashboard)
src/pages/flightplan.astro:…   client:load   (FlightPlan)
src/pages/route.astro:…        client:load   (RouteTabs)
src/pages/airports.astro:…     client:load   (Airports)
src/pages/settings.astro:…     client:load   (Settings)
```

Any extra line is a second island on a page; fold it into that page's island before continuing.

- [ ] **Step 2: Placeholder**

`Placeholder.astro` has no importer at `29b690d` (`grep -rn "Placeholder" src` finds only itself and the comment in `nav.ts`).

```bash
git rm src/components/Placeholder.astro
```

Delete the `placeholder` object (`title`, `body`, `reasons`) from all four `language/*.json`. `lib/nav.ts` 58–62: reword the comment's `Placeholder` mention to "一个只有占位说明的页面" so it no longer names a file that is gone.

- [ ] **Step 3: Leaflet leftovers**

Run: `grep -rn -e Leaflet -e invalidateSize src`

At `29b690d` this prints nine lines; Tasks 4 and 7 remove five (MapSurface is deleted; AppLayout.astro and globals.css 64–280 are rewritten). Expected leftovers and their fixes:

| File:line | Replace with |
| --- | --- |
| `src/components/map/RouteMap.vue` 3 | `* 地图画布，MapLibre GL。` |
| `src/components/map/RouteMap.vue` 8 | delete the Leaflet comparison; keep the sentence that labels need collision detection and GPU rendering |
| `src/components/map/RouteMap.vue` 25 | `* 规矩：`maplibre-gl` 在模块顶层就摸` (drop "和 Leaflet 那一版同一条规矩，理由一样硬") |
| `src/components/RoutePlanner.vue` 15 | `* 地图那一百多 KB 的 chunk 由外壳加载，这个组件不碰它。` |

Run the grep again. Expected: no output.

- [ ] **Step 4: Old names**

Run: `grep -rn -e MapSurface -e "app-map\b" -e PageHeader -e "\.app-panel" -e "map-fab\|rail-drawer" src`
Expected: no output. `PageHeader.astro` is now rendered only inside `FloatingPanel.astro` — if that is the only hit, it is correct; everything else is a leftover to fix.

- [ ] **Step 5: Gate**

Run: `bunx prettier --write src language && bun run lint && bun run build`
Expected: exit 0; `check:i18n` reports four aligned dictionaries with the `placeholder` keys gone.

- [ ] **Step 6: Browser check**

`bun run dev`, every page at ≥1152px, ~900px, ~390px, light and dark. In devtools → Network, filter JS: a cold load of `/route` fetches the RouteTabs chunk and no RoutePlanner/RouteGenerator chunk of its own (they are inside it). Navigating between pages keeps the map instance (the airways do not reload) and does not re-hydrate the rail.

- [ ] **Step 7: Commit**

```bash
git add -A src language
perl -e 'alarm 40; exec @ARGV' git commit -m "删掉占位组件和词条；清掉 Leaflet 时代的注释" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: AGENTS.md

**Files:**
- Modify: `AGENTS.md` (`CLAUDE.md` is a symlink to it — edit `AGENTS.md`, never replace the link)

**Interfaces:** none.

Apply bottom-up. Line numbers are at `29b690d`.

- [ ] **Step 1: Key count, line 647**

`四本今天是齐的（各 247 个键）` → the real number. Get it from `bun run check:i18n` output after Task 17, or:

```bash
bun -e 'const f=(o,p="")=>Object.entries(o).flatMap(([k,v])=>typeof v==="object"?f(v,p+k+"."):[p+k]);console.log(f((await Bun.file("language/zh-cn.json").json()).efb).length)'
```

- [ ] **Step 2: Line 589**

`（`Weather.vue` 顶上有说明）` → `（`Dashboard.vue` 的天气卡片只摆原文）`. `Weather.vue` has not existed since the weather page was folded into the dashboard.

- [ ] **Step 3: 〈图层没有数据的时候必须说出来〉, 547–560**

Replace every `MapSurface.vue` with the file that now holds the thing:
- `DEFAULT_PREFS` → `lib/mapPrefs.ts`
- `notice` → `components/map/useLayerNotice.ts`, rendered by `MapControls.vue`

After the list of three "没东西" add a fourth:

```
4. **请求失败** 现在除了退回关，还会在地图上留一条带「重试」的提示（`useLayerNotice`
   的 `failure`，`MapControls.vue` 画它）。退回关的规矩不变 —— 开关要说真话；提示
   是为了让人知道**为什么**关了，而不是只在控制台里留一行。
```

In the "一条通用判据" table add a row:

```
| 概览的 METAR    | 「暂无报文」           | 可能只是没读上；现在说「没能读取」并给重试                       |
```

- [ ] **Step 4: 〈还在占位的页面〉, 519–540**

The section's first bullet (航图 `/charts`) is stale: `/charts` has no page and no nav entry. Replace the section heading and body with:

```
## 没有占位页面

**这一节以前列着四个，现在一个都没有。** `Placeholder.astro` 连同 `efb.placeholder.*`
一起删了。三条各有各的结局，记下来：

- **航图 `/charts`** —— 没有页面、没有入口。有版权的数据，网络里没有任何一处提供
  它；要么授权，要么自建图源，那之前不摆一个打不开的入口。
- **机场 `/airports`** —— 做了，数据来自 can-db。
- **性能 / 检查单** —— 删了。要机型手册数据、要按机型逐条录入，两样都不存在。

**别用假数据填页面。** 摆着占位数字的仪表盘会被当成坏掉的真页面 —— 飞行员会照着它
做决定。同一条规矩也是**图层为空要说话**的由来，见下。
```

- [ ] **Step 5: 〈这个站自己的〉 and 〈RouteMap〉, 294–323**

The file list becomes:

```
**这个站自己的**：外壳（`AppRail.vue`、`SidebarNav.vue`、`RailScript.astro`、
`FloatingPanel.astro` + `lib/panelController.ts`、两个 layout、`PageHeader.astro`）、
数据层（`lib/canApi.ts`、`server/canApi.ts`、`lib/config.ts`、`lib/session.ts`、
`middleware.ts`、`pages/api/v1/[...path].ts`、`pages/api/db/[...path].ts`）、页面
岛屿（每页一个：`Dashboard`、`flightplan/FlightPlan`、`RouteTabs`、`Airports`、
`Settings`）、共用的状态与表单件（`components/ui/`：`StateCard`、`PanelSection`、
`Field`、`FieldGrid`）、地图（`components/map/`：`MapStage.vue` 是外壳侧的常驻显示
面，四个 `use*Layer` 各管一类图层，`RouteMap.vue` 是画布），以及 `lib/nav.ts`、
`language/*.json`。
```

In the RouteMap paragraph (313–323): `MapSurface.vue` → `MapStage.vue` (three places), and `MapSurface` → `MapStage` in "守法仍然是同一条". Delete the first bullet (库是 MapLibre，不是 Leaflet …): after Task 17 nothing in the tree mentions Leaflet, and a rule about a library that is gone is noise.

Line 336 (`ZOOM` row of the chartStyle table): `MapSurface` → `useChartLayers`.

- [ ] **Step 6: 〈折叠状态为什么不在组件的 state 里〉, 105–125**

Replace "轨可以在 17rem 和 4.75rem 之间折叠。" with:

```
轨可以在 17rem 和 4.75rem 之间折叠。`data-rail` 有三个值：`expanded`、`collapsed`、
`auto`。`auto` 是**没存过偏好**：桌面展开、平板（768–1151px）收起，由 CSS 在媒体
查询里给 `--rail-auto` 赋值。JS 要知道此刻实际是哪一种，用 `lib/panelLayout.ts`
的 `effectiveRail(data-rail, --rail-auto)`，不自己写断点。手机上没有轨，换成底部
标签栏。
```

In the RailScript bullet: "从 localStorage 读出来写好" → "从 localStorage 读出来写好，没存过就写 `auto`".

Replace the last paragraph (123–125, 手机抽屉 …) with:

```
那两条折叠规则的选择器里保留 `.app-rail` 限定：`data-rail` 挂在 `<html>` 上，这一层
让规则只作用于轨本身，别处出现的 `.rail-*` 不受折叠态影响。
```

- [ ] **Step 7: 〈这个站没有站头〉, 83–98**

Line 85: `src/components/ui/AppRail.vue` → `src/components/AppRail.vue`.

Replace consequence 1 (91–92, the FAB and drawer) with:

```
1. **手机上没有轨**，换成底部标签栏：五个导航项一行，拇指够得着。主题、语言、账
   户和跨站链接在设置页最底下（`.phone-only`），那是它们在手机上唯一的家。
```

Line 97 onward: `PageHeader.astro` is rendered by `FloatingPanel.astro`, not by pages. Change "页面自己的标题、说明和动作按钮走 `src/components/PageHeader.astro`" to "页面的标题和说明由 `FloatingPanel.astro` 用 `PageHeader.astro` 渲染，页面只传 `title` / `description`".

- [ ] **Step 8: 〈三栏的宽度分配〉, 33–80**

Replace the whole section (heading through the end of 〈断点只有一个定义处〉) with:

```
## 外壳：地图铺满，面板浮在上面

外壳是**一张铺满窗口的地图**，轨和面板都是浮在它上面的玻璃（`.glass`，材质取
can-ui 的 `--material-regular` / `--material-blur-regular`）。以前是**轨 | 面板 |
地图**三栏，地图只拿剩下的宽度 —— 1280 上四成，1024 上比轨还窄。现在地图永远是整
个窗口，面板挡住的那一块用**内边距**让出来：

- 面板每次改变位置或大小，`lib/panelController.ts` 发一条 `panel:layout`（`mapBus`
  上，新订阅者会收到上一条）。`MapStage` 用 `lib/panelLayout.ts` 的 `mapPaddingFor`
  算出内边距交给 MapLibre，所以「居中」「框住航路」都是对**没被挡住的那一块**说的。
- 面板宽度由页面声明：`standard`（26rem，列表和短表单）或 `wide`（44rem，飞行计划、
  设置）。平板上 wide 退回 standard。
- 面板可以收起成一条（`inert` 挡住里面的 Tab），地图跟着把内边距收回去。

### 三种排布，断点只写在 CSS 里

| 宽度 | `--shell-mode` | 轨 | 面板 |
| --- | --- | --- | --- |
| ≥1152px | `desktop` | 展开（或按偏好） | 左侧浮卡，standard / wide |
| 768–1151px | `tablet` | 默认收起（`auto`） | 左侧浮卡，恒为 standard |
| <768px | `phone` | 没有，换底部标签栏 | 底部抽屉：收起 72px / 半屏 / 全屏 |

768 和 1152 **只写在 `globals.css` 的媒体查询里**。JS 要知道当前排布就读
`--shell-mode`（`parseShellMode`），要知道轨的默认就读 `--rail-auto`
（`effectiveRail`）—— 不写 `matchMedia`。以前 RouteMap 自己写过一份
`matchMedia("(min-width: 1024px)")`，改断点时两份分叉，那是没人查得到的毛病。

手机的抽屉按 can-ui 的 `projectToDetent` 吸附到三档之一，拖动时越界有阻尼
（`rubberbandClamp`），焦点进入抽屉时展开到全屏，免得输入框被键盘和地图夹住。

### 面板里的多列排布按容器判，不按视口判

面板声明成 `container-type: inline-size`（容器名 `efb-panel`），里面的网格用
`@sm:` / `@md:` 这种容器前缀，表单用 `FieldGrid`（面板 ≥36rem 才分两列）。用视口
前缀的话，1440 的屏上 standard 面板也会被排成两列，每列不到 200px。
```

- [ ] **Step 9: Check**

Run: `grep -n -e MapSurface -e "ui/AppRail" -e Weather.vue -e Placeholder -e "三栏" AGENTS.md`
Expected: only the historical mention in the new 〈外壳〉 section ("以前是**轨 | 面板 | 地图**三栏"). Run `bunx prettier --write AGENTS.md && bun run lint`. Expected: exit 0. Confirm `ls -l CLAUDE.md` still shows `CLAUDE.md -> AGENTS.md`.

- [ ] **Step 10: Commit**

```bash
git add AGENTS.md
perl -e 'alarm 40; exec @ARGV' git commit -m "AGENTS.md：浮动面板外壳、地图拆分、状态卡；删掉占位页和 Leaflet 的旧说法" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

### Spec coverage

| Spec item | Task |
| --- | --- |
| Shell layers: MapStage full-viewport + `transition:persist`, glass rail, FloatingPanel 12px inset | 4, 7, 8 |
| MapStage split: layer registry, traffic, route (magenta), controls | 4, 5, 6 |
| Panel width per page, `wide` for `/flightplan` and `/settings`, animated width | 7 |
| `map.setPadding` from the panel | 1, 3, 5, 7 |
| Collapse to a thin bar | 7 |
| Breakpoints only in `globals.css`; tablet rail collapsed by default; `wide` → `standard` on tablet | 1, 7, 8 |
| Phone: 5-item tab bar; bottom sheet with three snaps, draggable; form pages full, map pages half | 2, 7, 8 |
| `.glass` from can-ui tokens, fallback under `prefers-reduced-transparency` / no `backdrop-filter`, light/dark | 4 |
| `StateCard`, `PanelSection`, `Field` / `FieldGrid` | 10 |
| Dashboard: user summary, plan card, METARs, map shows the filed plan | 3 (`map:plan`), 11 |
| Flight plan: two-column form, live route on the map, SimBrief at the top, 409 lock banner, split into form / import / status | 12, 13 |
| Route: one page, two tabs, forbidden StateCard on Generate | 14 |
| Airports: list + detail, fly to airport, states in the island | 5, 15 |
| Settings: account / preferences / SimBrief | 16 |
| 404 on StateCard | 15 |
| `mapBus`: `panel:layout`, `map:focus`; map sends nothing to panels | 3 |
| Every island request → `data | empty | error | forbidden` via StateCard | 9, 11, 13–16 |
| Failed map layer: corner notice with retry | 4 |
| Hydration: rail, map, one page island | 17 |
| Delete Placeholder, Leaflet comments, AGENTS.md fixes | 17, 18 |
| Tests: panel width → padding, result → state, sheet snaps | 1, 9, 2 |
| Gate on every commit; manual check at three widths × two themes | every task |

### Placeholder scan

Searched this file for `TBD`, `TODO`, `FIXME`, `…`, "similar to", "as needed", "appropriate". The remaining `…` are inside quoted UI strings and in the key-count `bun -e` step, where the number is produced by the command. Where a step says 原样 / "unchanged", it names the exact line range of the original file at `29b690d` that is pasted; it is a move, not an unwritten part.

### Type consistency

- `RequestState<T>` (Task 9) is used unchanged in Tasks 11, 12, 13, 15; `error` carries `status` and optional `failure`, `forbidden` carries `status`.
- `MapFocus` (Task 3) is the only focus shape; `MapPayload.focus` is removed in Task 5 and no later task sets it (Task 15 uses `focusMap`).
- `Plan` / `StoredPlan` live only in `lib/flightPlan.ts` from Task 12; Tasks 13's three children import them from there.
- `StateCard` props (`kind`, `title`, `body?`, `retryLabel?`, `compact?`, `@retry`, `#action`) match every call site in Tasks 11–16.
- `Field` slot props (`id`, `describedby`, `invalid`, `labelledby`) match PlanForm.
- `AirportRow` (Task 15) mirrors `server/canDb.ts` `AirportSummary` field for field.
- `effectiveRail(dataRail, railAuto)` has the same argument order in Tasks 1, 8, 16.

### Spec ambiguities and how they were resolved

1. **Dashboard map "shows the current plan"** — impossible today once any page has published (`MapSurface.vue` 1125–1128). Added a third bus message, `map:plan`, sent by the dashboard. The map still sends nothing to panels.
2. **"Generate stays gated by `aipAccess`"** — there is no client gate, and a client gate would lock out instructors (rating ≥ 8) whom can-db admits. Resolved as reactive: can-db's 401/403 → forbidden StateCard. `aipAccess` still only controls the tier switch.
3. **"Form pages open at full; map pages open at half"** — resolved by width: `wide` pages (flight plan, settings) open full, `standard` pages half. `/route` opens half.
4. **Failed layer: "notice with retry, instead of disappearing"** vs AGENTS.md "失败才退回关" — both kept: the toggle still reverts to off, and a notice with retry explains why.
5. **Phone has no rail** — the spec says "contents unchanged" for the rail. Theme/language, sign-out and cross-site links move into a `.phone-only` block on Settings.
6. **FloatingPanel as a component** — built as Astro + module script, not a Vue island, so it adds no hydration (spec's hydration rule).
7. **"Other islands use `client:idle` / `client:visible`"** — no secondary islands exist; Task 17 is an audit.
8. **Dashboard METAR failure** showed "暂无报文". Changed to a distinct error with retry, per the error-handling rule.
9. **Route tabs vs "PanelSection replaces the bare `<h2>`"** — the tabs carry the navigation; each tab's content keeps a PanelSection heading.

### Conflicts between the spec and the code

1. The checkout is on `feat/ground-sector-only`; the spec is only on `feat/efb-redesign` (`29b690d`). The plan starts with `git switch feat/efb-redesign`.
2. `feat/ground-sector-only` (`843f331`) edits `MapSurface.vue`, `RouteMap.vue`, the ground layer and `chartStyle.ts`. Merging it after Tasks 4–6 will conflict; land or rebase it first.
3. The spec says Generate "stays" gated; no client gate exists (see ambiguity 2).
4. AGENTS.md cites `ui/AppRail.vue`, `Weather.vue` and a `/charts` placeholder; none exist. Task 18 fixes all three.
5. `Placeholder.astro` is already unused; deleting it only removes dead code.
