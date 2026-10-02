<script setup lang="ts">
/**
 * 一个机场的详情：标高、位置、机位数、METAR、跑道。
 *
 * METAR 走 can-api 的 `/api/v1/metar`（和概览天气卡同一条），只摆原文，不解码。
 *
 * 跑道走 can-db 的机场详情（和进离场程序选择器同一个接口、同一份缓存形状）。那个
 * 接口的门和列表一样，但**能看到列表不等于一定能看到详情** —— 两次请求之间权限可
 * 能变，所以 401/403 在这里也单独说。
 *
 * **挂载时把焦点移到标题上。** 列表和详情是互斥的两个视图（Airports.vue 的
 * `v-else-if="selected"`），切换不导航、不刷新页面 —— 读屏软件不会自己发现内容
 * 换了。焦点移到这个 `h2`（`tabindex="-1"` 让它可以接焦点但不进 Tab 顺序）才会把
 * 机场代号读出来，这是选中一个结果之后**唯一**会被读屏用户感知到的信号。
 *
 * 信息 / 航图两个标签用 can-ui 的 Segmented，选中那一段填品牌蓝（globals.css 的
 * .airport-tabs）。
 */
import { computed, onMounted, ref, useId, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import {
  fetchAirportProcedures,
  ProcedureError,
  runwayIdents,
} from "@/lib/procedures";
import { api } from "@/lib/canApi";
import {
  fromApiResult,
  isForbiddenStatus,
  LOADING,
  type RequestState,
} from "@/lib/requestState";
import StateCard from "@/components/ui/StateCard.vue";
import PanelSection from "@/components/ui/PanelSection.vue";
import { Icon, Segmented } from "@jianyuelab-org/can-ui";
import AirportCharts from "./AirportCharts.vue";
import type { AirportRow as Airport } from "@/lib/airports";

const props = defineProps<{
  airport: Airport;
  aipAccess: number;
  messages: Record<string, unknown>;
}>();
const emit = defineEmits<{ back: [] }>();
const t = createTranslator(props.messages);

type DetailTab = "info" | "charts";
const tab = ref<DetailTab>("info");
/** 航图第一次切过去才取，之后 v-show 保留（列表、搜索词、打开着的查看器都在）。 */
const chartsOpened = ref(false);
watch(tab, (value) => {
  if (value === "charts") chartsOpened.value = true;
});
const uid = useId();
const tabsEl = ref<{ $el: HTMLElement } | null>(null);
const tabId = (value: DetailTab) => `${uid}-tab-${value}`;
const panelId = (value: DetailTab) => `${uid}-panel-${value}`;
/** Segmented 不给标签设 id / aria-controls，挂载后按顺序（信息、航图）补上。 */
function wireTabs() {
  const els = tabsEl.value?.$el.querySelectorAll<HTMLElement>('[role="tab"]');
  const order: DetailTab[] = ["info", "charts"];
  els?.forEach((el, i) => {
    el.id = tabId(order[i]);
    el.setAttribute("aria-controls", panelId(order[i]));
  });
}
const tabs = computed(() => [
  { value: "info" as const, label: t("airports.detail.tabs.info") },
  { value: "charts" as const, label: t("airports.detail.tabs.charts") },
]);

const runways = ref<RequestState<string[]>>(LOADING);
const heading = ref<HTMLHeadingElement | null>(null);

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
    runways.value = isForbiddenStatus(status)
      ? { kind: "forbidden", status }
      : { kind: "error", status };
  }
}

const metar = ref<RequestState<string>>(LOADING);
/** 每次取数加一。切到别的机场时，上一个机场的报文晚到就丢掉。 */
let metarSeq = 0;

async function loadMetar() {
  const mine = ++metarSeq;
  metar.value = LOADING;
  const icao = props.airport.icao;
  const result = await api<{ icao: string; metar: string | null }>(
    `/api/v1/metar?icao=${encodeURIComponent(icao)}`,
  );
  if (mine !== metarSeq) return;
  metar.value = fromApiResult<string>(
    result.ok ? { ok: true, data: result.data.metar } : result,
    (text) => !text,
  );
}

onMounted(() => {
  void loadMetar();
  void loadRunways();
  wireTabs();
  heading.value?.focus();
});
watch(
  () => props.airport.icao,
  () => {
    void loadMetar();
    void loadRunways();
  },
);
</script>

<template>
  <div class="space-y-5">
    <button type="button" class="link text-sm" @click="emit('back')">
      <Icon name="arrowLeft" class="inline size-4" />
      {{ t("airports.detail.back") }}
    </button>

    <header>
      <h2
        ref="heading"
        tabindex="-1"
        class="font-mono text-2xl font-semibold text-ink outline-none"
      >
        {{ airport.icao }}
      </h2>
      <p v-if="airport.name" class="mt-1 text-sm text-muted">
        {{ airport.name }}
      </p>
    </header>

    <Segmented
      ref="tabsEl"
      v-model="tab"
      :segments="tabs"
      :label="t('airports.detail.tabs.label')"
      block
      class="airport-tabs"
    />

    <div
      v-show="tab === 'info'"
      :id="panelId('info')"
      role="tabpanel"
      :aria-labelledby="tabId('info')"
      class="space-y-5"
    >
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

      <PanelSection :title="t('airports.detail.metar.title')" :level="3">
        <p
          v-if="metar.kind === 'data'"
          class="break-words font-mono text-xs leading-relaxed text-ink"
        >
          {{ metar.data }}
        </p>
        <StateCard
          v-else-if="metar.kind === 'error'"
          kind="error"
          :title="t('airports.detail.metar.failed', { icao: airport.icao })"
          :retry-label="t('common.retry')"
          compact
          @retry="loadMetar"
        />
        <p v-else-if="metar.kind === 'empty'" class="text-xs text-faint">
          {{ t("airports.detail.metar.none", { icao: airport.icao }) }}
        </p>
        <p v-else class="skeleton h-4 w-3/4"></p>
      </PanelSection>

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

    <div
      v-if="chartsOpened"
      v-show="tab === 'charts'"
      :id="panelId('charts')"
      role="tabpanel"
      :aria-labelledby="tabId('charts')"
    >
      <AirportCharts
        :icao="airport.icao"
        :aip-access="aipAccess"
        :active="tab === 'charts'"
        :messages="messages"
      />
    </div>
  </div>
</template>
