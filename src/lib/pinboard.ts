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
