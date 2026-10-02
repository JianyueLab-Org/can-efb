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
  openChart: openedChart,
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

/** Esc 关列表，只管焦点在列表里时的按键。查看器开着时 Esc 是查看器的。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !props.open || openedChart.value) return;
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
