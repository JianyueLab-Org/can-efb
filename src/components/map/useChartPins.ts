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
  nextTick,
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

/**
 * 焦点回到 `target`。它已经不在页面上或看不见（钉板收了、换到手机排布），就落到钉
 * 板的列表按钮，再没有就落到模式条的钉板按钮 —— 不让焦点掉到 body 上。
 */
export function restoreFocus(target: HTMLElement | null) {
  const usable =
    target !== null && target.isConnected && target.getClientRects().length > 0;
  const next = usable
    ? target
    : (document.querySelector<HTMLElement>(".map-pinboard .map-pin-list") ??
      document.querySelector<HTMLElement>(
        '.map-mode-btn[data-mode="pinboard"]',
      ));
  next?.focus();
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
    if (!openChart.value) {
      returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    openChart.value = chart;
  }

  function close() {
    openChart.value = null;
    const target = returnFocus;
    returnFocus = null;
    void nextTick(() => restoreFocus(target));
  }

  /**
   * Astro 换页时 body 整个换掉，Teleport 到 body 下的查看器跟着被摘掉，而 `openChart`
   * 还在：钉板上那一格一直亮着，再点只是往一个看不见的查看器里换图。换页前收掉。
   */
  function onBeforeSwap() {
    openChart.value = null;
    returnFocus = null;
  }

  watch(options.active, (on) => {
    if (on && (!loaded || stale)) void load();
  });
  watch(hideNaip, onSourceChange);

  onMounted(() => {
    window.addEventListener(PLAN_CHANGED_EVENT, onSourceChange);
    window.addEventListener(PROCEDURES_CHANGED_EVENT, rereadLocal);
    window.addEventListener(CHART_PINS_CHANGED_EVENT, rereadLocal);
    document.addEventListener("astro:before-swap", onBeforeSwap);
  });
  onBeforeUnmount(() => {
    window.removeEventListener(PLAN_CHANGED_EVENT, onSourceChange);
    window.removeEventListener(PROCEDURES_CHANGED_EVENT, rereadLocal);
    window.removeEventListener(CHART_PINS_CHANGED_EVENT, rereadLocal);
    document.removeEventListener("astro:before-swap", onBeforeSwap);
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
