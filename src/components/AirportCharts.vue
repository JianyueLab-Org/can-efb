<script setup lang="ts">
/**
 * 机场详情的「航图」标签：类别、搜索、列表，点一行打开 ChartViewer。
 *
 * 数据是 can-db 的 `aip/airports/{icao}/charts`，走 `dbFetch`（「不使用受限汇编」
 * 开着时带 `unrestricted=1`）。航图全是 NAIP，所以那个开关开着时 3 级起的成员会
 * 拿到空列表 —— 那时说「被隐藏了」，不说「没有」（`chartsEmptyReason`）。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import StateCard from "@/components/ui/StateCard.vue";
import ChartViewer from "./ChartViewer.vue";
import { createTranslator } from "@/lib/i18n";
import { dbFetch, hideNaip } from "@/lib/naip";
import { LOADING } from "@/lib/requestState";
import {
  chartChips,
  chartIndexPath,
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

const props = defineProps<{
  icao: string;
  aipAccess: number;
  messages: Record<string, unknown>;
}>();
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

const TAG_CLASS: Record<ChartCategory, string> = {
  STAR: "text-emerald-700 dark:text-emerald-300",
  APP: "text-orange-700 dark:text-orange-300",
  TAXI: "text-blue-700 dark:text-blue-300",
  SID: "text-pink-700 dark:text-pink-300",
  REF: "text-violet-700 dark:text-violet-300",
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
    :title="t('airports.charts.empty.title')"
    :body="t('airports.charts.empty.body')"
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
      <li v-for="c in visible" :key="c.id">
        <button
          type="button"
          class="card flex w-full items-center gap-3 p-3 text-left"
          :aria-current="selected?.id === c.id ? 'true' : undefined"
          :ref="(el) => setRowRef(c.id, el as Element | null)"
          @click="openChart(c)"
        >
          <span
            v-if="searching"
            class="w-10 shrink-0 font-mono text-xs font-semibold"
            :class="TAG_CLASS[c.category]"
          >
            {{ c.category }}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-ink">{{ c.name }}</span>
            <span
              v-if="c.page || c.isSup"
              class="mt-0.5 flex items-center gap-2 text-xs text-muted"
            >
              <span v-if="c.page" class="font-mono">{{ c.page }}</span>
              <span v-if="c.isSup" class="badge badge-warning">
                {{ t("airports.charts.sup") }}
              </span>
            </span>
          </span>
          <Icon name="chevronRight" class="size-4 shrink-0 text-faint" />
        </button>
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
