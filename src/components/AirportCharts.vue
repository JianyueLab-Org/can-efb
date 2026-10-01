<script setup lang="ts">
/**
 * 机场详情的「航图」标签：类别、搜索、列表，点一行打开 ChartViewer。
 *
 * 数据是 can-db 的 `aip/airports/{icao}/charts`，走 `dbFetch`（「不使用受限汇编」
 * 开着时带 `unrestricted=1`）。航图全是 NAIP，所以那个开关开着时 3 级起的成员会
 * 拿到空列表 —— 那时说「被隐藏了」，不说「没有」（`chartsEmptyReason`）。
 *
 * 计划里的机场（起飞、落地、备降）每行多一颗钉住按钮，和地图的航图弹出层写同一份存储
 * （lib/chartPins.ts）。别的机场没有：钉住按起降机场对存。
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
import ChartViewer from "./ChartViewer.vue";
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
import { createTranslator } from "@/lib/i18n";
import { dbFetch, hideNaip } from "@/lib/naip";
import { LOADING } from "@/lib/requestState";
import {
  chartChips,
  chartIndexPath,
  chartsEmptyBody,
  chartsEmptyReason,
  chartsState,
  defaultChip,
  errorCodeOf,
  filterCharts,
  parseChartIndex,
  type ChartCategory,
  type ChartEntry,
  type ChartsState,
} from "@/lib/charts";

const props = withDefaults(
  defineProps<{
    icao: string;
    aipAccess: number;
    /** 航图标签是不是当前标签。切走时关掉查看器。 */
    active?: boolean;
    messages: Record<string, unknown>;
  }>(),
  { active: true },
);
const t = createTranslator(props.messages);

/** 参考截图的配色。选中是实心胶囊。 */
const CHIP_CLASS: Record<ChartCategory, { idle: string; active: string }> = {
  STAR: {
    idle: "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
    active: "border-emerald-700 bg-emerald-700 text-white",
  },
  APP: {
    idle: "border-orange-500/50 text-orange-700 dark:text-orange-300",
    active: "border-orange-700 bg-orange-700 text-white",
  },
  TAXI: {
    idle: "border-blue-500/50 text-blue-700 dark:text-blue-300",
    active: "border-blue-600 bg-blue-600 text-white",
  },
  SID: {
    idle: "border-pink-500/50 text-pink-700 dark:text-pink-300",
    active: "border-pink-600 bg-pink-600 text-white",
  },
  REF: {
    idle: "border-violet-500/50 text-violet-700 dark:text-violet-300",
    active: "border-violet-600 bg-violet-600 text-white",
  },
};

const state = ref<ChartsState>(LOADING);
const category = ref<ChartCategory | null>(null);
const query = ref("");
const selected = ref<ChartEntry | null>(null);
const rowRefs = new Map<number, HTMLButtonElement>();
let seq = 0;

function setRowRef(id: number, el: Element | null) {
  if (el) rowRefs.set(id, el as HTMLButtonElement);
  else rowRefs.delete(id);
}

async function load() {
  const mine = ++seq;
  state.value = LOADING;
  selected.value = null;
  const response = await dbFetch(chartIndexPath(props.icao)).catch(() => null);
  if (mine !== seq) return;
  if (!response) {
    state.value = { kind: "error", status: 0 };
    return;
  }
  const body = await response.json().catch(() => null);
  if (mine !== seq) return;
  const index = response.ok ? parseChartIndex(body) : null;
  state.value = chartsState(
    response.ok,
    response.status,
    index,
    errorCodeOf(body),
  );
  category.value =
    state.value.kind === "data"
      ? defaultChip(chartChips(state.value.data.charts))
      : null;
}

onMounted(load);
watch(() => props.icao, load);
watch(hideNaip, load);
watch(
  () => props.active,
  (on) => {
    if (!on) selected.value = null;
  },
);

const index = computed(() =>
  state.value.kind === "data" ? state.value.data : null,
);
const chips = computed(() => chartChips(index.value?.charts ?? []));
const searching = computed(() => query.value.trim() !== "");
const visible = computed(() =>
  filterCharts(index.value?.charts ?? [], category.value, query.value),
);
const emptyReason = computed(() =>
  chartsEmptyReason(hideNaip.value, props.aipAccess),
);
const emptyBody = computed(() => chartsEmptyBody(props.aipAccess));

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
  writePins(
    p.departure,
    p.arrival,
    togglePin(stored.value, chart.id, auto.value),
  );
}

function pinLabel(chart: ChartEntry): string {
  return `${t("airports.charts.pins.pin")} ${chart.name}`;
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

function openChart(chart: ChartEntry) {
  selected.value = chart;
}

/** 关掉查看器：焦点回到打开它的那一行。 */
function closeViewer() {
  const id = selected.value?.id;
  selected.value = null;
  void nextTick(() => {
    if (id !== undefined) rowRefs.get(id)?.focus();
  });
}
</script>

<template>
  <StateCard
    v-if="state.kind === 'loading'"
    kind="loading"
    :title="t('common.loading')"
    compact
  />
  <StateCard
    v-else-if="state.kind === 'forbidden'"
    kind="forbidden"
    :title="t('airports.denied.title')"
    :body="t('airports.denied.body')"
    compact
  />
  <StateCard
    v-else-if="state.kind === 'unconfigured'"
    kind="error"
    :title="t('airports.charts.unconfigured.title')"
    :body="t('airports.charts.unconfigured.body')"
    :retry-label="t('common.retry')"
    compact
    @retry="load"
  />
  <StateCard
    v-else-if="state.kind === 'error'"
    kind="error"
    :title="t('airports.charts.failed')"
    :retry-label="t('common.retry')"
    compact
    @retry="load"
  />
  <StateCard
    v-else-if="state.kind === 'empty' && emptyReason === 'hidden'"
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
    v-else-if="state.kind === 'empty'"
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

  <div v-else-if="index" class="flex flex-col gap-3">
    <div
      class="flex flex-wrap gap-2"
      role="group"
      :aria-label="t('airports.charts.categories')"
    >
      <button
        v-for="chip in chips"
        :key="chip.category"
        type="button"
        class="rounded-full border px-3 py-1 font-mono text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        :class="
          category === chip.category && !searching
            ? CHIP_CLASS[chip.category].active
            : CHIP_CLASS[chip.category].idle
        "
        :disabled="chip.disabled"
        :aria-pressed="category === chip.category && !searching"
        @click="category = chip.category"
      >
        {{ chip.category }}
      </button>
    </div>

    <label class="relative block">
      <span class="sr-only">{{ t("airports.charts.search") }}</span>
      <Icon
        name="magnifyingGlass"
        class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
      />
      <input
        v-model="query"
        type="search"
        autocomplete="off"
        :placeholder="t('airports.charts.search')"
        class="input pl-9"
      />
    </label>

    <p class="font-mono text-xs text-faint">AIRAC {{ index.airac }}</p>

    <p v-if="!visible.length" class="text-sm text-muted" role="status">
      {{ t("airports.charts.none") }}
    </p>

    <ul v-else class="flex flex-col gap-1.5">
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
    </ul>
  </div>

  <ChartViewer
    v-if="selected"
    :chart="selected"
    :messages="messages"
    @close="closeViewer"
  />
</template>
