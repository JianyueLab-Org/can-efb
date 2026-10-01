<script setup lang="ts">
/**
 * 地图上的「航图」弹出层：本次飞行的起飞、落地、备降三个机场，钉住的在前，后面是
 * 折起来的全部航图。点一行打开 ChartViewer。
 *
 * 规则在 `lib/chartPins.ts`。第一次打开才取数，地图挂载时什么都不取。开着时计划、
 * 「不使用受限汇编」一变就重取；程序选择、钉住变了只重读本机存储，不重取。关着时
 * 计划和「不使用受限汇编」的变化只记一笔，下次打开再取。
 *
 * 每个机场的状态各管各的：一个机场没取到不影响另外两个，重试也只重试它。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
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
const sectionRef = ref<HTMLElement | null>(null);
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

/** 计划、「不使用受限汇编」变了。 */
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

function toggle(chart: ChartEntry, auto: ReadonlySet<number>, role: PinRole) {
  if (plan.value.kind !== "plan") return;
  const { departure, arrival } = plan.value.plan;
  writePins(departure, arrival, togglePin(stored.value, chart.id, auto));
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

/** Esc 关弹出层，只管弹出层里的按键。查看器开着时 Esc 是查看器的。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !props.open || selected.value) return;
  emit("close");
}

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

  <ChartViewer
    v-if="selected"
    :chart="selected"
    :messages="messages"
    @close="closeViewer"
  />
</template>
