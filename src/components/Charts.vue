<script setup lang="ts">
/**
 * 航图：按机场翻图册，右边看图。
 *
 * ## 图是 can-api 的，而且要会话
 *
 * 这个站以前把航图页摆成占位，理由写在 CLAUDE.md 里 ——「有版权的数据，网络里没
 * 有任何一处提供它」。现在有了：图在 can-api 的 R2 桶里，索引和取图都是它的，三
 * 条路由都要会话而且**都不带 scope**（所以没有任何 OAuth 应用能拿到整个图库）。
 *
 * **会话是那三条路由的性质，不是那批对象的性质。** 图和题库配图共用一个挂了
 * cdn.airwaysn.org 的桶，而航图的键是能推出来的形状 —— 详见 can-api 的
 * `config.Config.Charts`。这里写清楚只为一件事：别在「反正要会话」这个前提上做
 * 判断。
 *
 * 这个页面上没有「下载全部」「导出」这类入口，也不该加 —— 那和上面那条无关，是
 * 因为这个界面不该主动帮人把一整份 AIP 打包带走。
 *
 * ## 起降场是预填的，不是猜的
 *
 * 打开航图页的人十有八九正在准备当前那班飞行，所以进来先读一次
 * `/api/v1/pilot/flightplan`，把起飞和落地机场放在最上面。这不用新的接口 ——
 * 那条路由这个站本来就在用（Dashboard 和 FlightPlan 都读它）。
 *
 * 没有计划、或者计划里的机场没有图，都不是错误：下面照常是全部机场的列表。
 *
 * ## 503 是常态，不是故障
 *
 * `charts_unavailable` 意思是这个部署没配航图桶（本地开发基本都是这样），和
 * RoutePlanner 里那条 navdata 的 503 是同一类东西。所以它单独给一句人话，而不
 * 是塌进通用的错误提示 —— 否则本地跑的人会以为自己把什么弄坏了。
 */
import { computed, defineAsyncComponent, onMounted, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import Icon from "@/components/ui/Icon.vue";

/**
 * pdf.js 在模块顶层就摸 `window`，静态 import 会让 `/charts` 的 SSR 直接抛 ——
 * 和 RoutePlanner 引 RouteMap 是同一件事，同一个理由。异步引它顺带把那一兆多的
 * chunk 挪到「真的点开了某张图的人」身上。
 */
const ChartViewer = defineAsyncComponent(
  () => import("@/components/ChartViewer.vue"),
);

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const RECENT_KEY = "efb.charts.recent";
const RECENT_MAX = 6;
const ICAO = /^[A-Za-z]{4}$/;

interface Airport {
  icao: string;
  airac: string;
  count: number;
}
interface ChartItem {
  id: number;
  title: string;
  bytes: number;
  content_type: string;
}
interface ChartGroup {
  category: string;
  charts: ChartItem[];
}
interface ChartIndex {
  icao: string;
  airac: string;
  groups: ChartGroup[];
}

const airports = ref<Airport[]>([]);
const airportsLoading = ref(true);
/** 整个航图库都不可用时的那句话；空 = 可用。 */
const unavailable = ref("");
const loadError = ref("");

const query = ref("");
const selectedIcao = ref("");
const index = ref<ChartIndex | null>(null);
const indexLoading = ref(false);

const selected = ref<ChartItem | null>(null);
const recent = ref<string[]>([]);

/** 计划里的起降场，预填用。没有计划就是空的。 */
const planAirports = ref<string[]>([]);

const filtered = computed(() => {
  const q = query.value.trim().toUpperCase();
  if (!q) return airports.value;
  return airports.value.filter((a) => a.icao.includes(q));
});

/**
 * 排在最前面的那几个：先是当前计划的起降场，然后是最近看过的。
 *
 * 去重之后只保留真的有图的那些 —— 列一个点进去空空如也的机场，比不列更糟。
 */
const pinned = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ airport: Airport; reason: "plan" | "recent" }> = [];
  for (const icao of planAirports.value) {
    const airport = airports.value.find((a) => a.icao === icao);
    if (airport && !seen.has(icao)) {
      seen.add(icao);
      out.push({ airport, reason: "plan" });
    }
  }
  for (const icao of recent.value) {
    const airport = airports.value.find((a) => a.icao === icao);
    if (airport && !seen.has(icao)) {
      seen.add(icao);
      out.push({ airport, reason: "recent" });
    }
  }
  return out;
});

function rememberRecent(icao: string) {
  recent.value = [icao, ...recent.value.filter((c) => c !== icao)].slice(
    0,
    RECENT_MAX,
  );
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value));
  } catch {
    // 隐私模式下会抛。本次会话内仍然可用，只是下次打开要重新找。
  }
}

async function loadAirports() {
  airportsLoading.value = true;
  const result = await api<{ airports: Airport[] }>("/api/v1/charts/airports");
  airportsLoading.value = false;

  if (!result.ok) {
    if (result.error === "charts_unavailable") {
      unavailable.value = t("charts.unavailable");
    } else {
      loadError.value = result.message;
    }
    return;
  }
  airports.value = result.data.airports ?? [];
}

async function open(icao: string) {
  const code = icao.trim().toUpperCase();
  if (!ICAO.test(code)) return;

  selectedIcao.value = code;
  selected.value = null;
  index.value = null;
  indexLoading.value = true;
  loadError.value = "";

  const result = await api<ChartIndex>(
    `/api/v1/charts?icao=${encodeURIComponent(code)}`,
  );
  indexLoading.value = false;

  if (!result.ok) {
    loadError.value = result.message;
    return;
  }
  index.value = result.data;
  rememberRecent(code);
}

/**
 * 当前这张图的取图地址。
 *
 * 这个地址是给 pdf.js 的，走本站同源反代 —— 反代的白名单里有一条专门锚定这个
 * 形状的规则。见 `src/pages/api/v1/[...path].ts`。
 */
const chartSrc = computed(() =>
  selected.value ? `/api/v1/charts/${selected.value.id}/file` : "",
);

const viewerLabels = computed(() => ({
  loading: t("charts.viewer.loading"),
  failed: t("charts.viewer.failed"),
  page: t("charts.viewer.page"),
  zoomIn: t("charts.viewer.zoomIn"),
  zoomOut: t("charts.viewer.zoomOut"),
  rotate: t("charts.viewer.rotate"),
  invert: t("charts.viewer.invert"),
  fitWidth: t("charts.viewer.fitWidth"),
  prev: t("charts.viewer.prev"),
  next: t("charts.viewer.next"),
}));

onMounted(() => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    recent.value = (Array.isArray(saved) ? saved : [])
      .filter((c): c is string => typeof c === "string" && ICAO.test(c))
      .map((c) => c.toUpperCase());
  } catch {
    recent.value = [];
  }

  void loadAirports();

  // 计划是**顺带**读的：拿不到就当没有，不显示错误也不拦着翻图。航图页的主线
  // 是「找机场看图」，一份读不到的飞行计划不该挡在前面。
  void api<{ departure?: string; arrival?: string } | null>(
    "/api/v1/pilot/flightplan",
  ).then((result) => {
    if (!result.ok || !result.data) return;
    planAirports.value = [result.data.departure, result.data.arrival]
      .filter((c): c is string => typeof c === "string" && ICAO.test(c))
      .map((c) => c.toUpperCase());
  });
});
</script>

<template>
  <!-- 航图库整个不可用：一句人话，别的什么都不显示。 -->
  <div
    v-if="unavailable"
    class="surface-grid flex flex-col items-center justify-center rounded-card border border-dashed border-subtle px-6 py-16 text-center"
  >
    <Icon name="documentText" class="size-6 text-faint" />
    <p class="mt-3 max-w-md text-sm text-muted">{{ unavailable }}</p>
  </div>

  <!--
    两栏：左边选机场和图，右边看图。手机上折成一栏，选中一张图之后列表让位 ——
    在 390px 宽的屏幕上同时摆列表和图，两样都看不清。
  -->
  <div v-else class="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
    <div :class="selected ? 'hidden lg:block' : ''">
      <div class="card p-4">
        <label class="block">
          <span class="sr-only">{{ t("charts.searchLabel") }}</span>
          <div class="relative">
            <Icon
              name="magnifyingGlass"
              class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint"
            />
            <input
              v-model="query"
              class="input pl-9 font-mono uppercase"
              maxlength="4"
              :placeholder="t('charts.searchPlaceholder')"
              @keydown.enter.prevent="open(query)"
            />
          </div>
        </label>

        <p v-if="airportsLoading" class="skeleton mt-3 h-5 w-full"></p>
        <p v-else-if="loadError && !index" class="mt-3 text-sm text-danger">
          {{ loadError }}
        </p>
        <p v-else-if="!airports.length" class="mt-3 text-sm text-muted">
          {{ t("charts.emptyLibrary") }}
        </p>

        <!-- 计划的起降场和最近看过的，钉在最上面。 -->
        <ul v-if="pinned.length && !query" role="list" class="mt-3 space-y-1">
          <li v-for="entry in pinned" :key="entry.airport.icao">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken"
              :class="
                selectedIcao === entry.airport.icao ? 'bg-surface-sunken' : ''
              "
              @click="open(entry.airport.icao)"
            >
              <Icon
                :name="entry.reason === 'plan' ? 'paperAirplane' : 'clock'"
                class="size-4 shrink-0 text-faint"
              />
              <span class="font-mono text-sm font-semibold text-ink">{{
                entry.airport.icao
              }}</span>
              <span class="ml-auto shrink-0 text-xs text-faint">{{
                entry.airport.count
              }}</span>
            </button>
          </li>
        </ul>

        <ul
          v-if="filtered.length"
          role="list"
          class="mt-3 max-h-96 space-y-1 overflow-y-auto border-t border-subtle pt-3"
        >
          <li v-for="airport in filtered" :key="airport.icao">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-surface-sunken"
              :class="selectedIcao === airport.icao ? 'bg-surface-sunken' : ''"
              @click="open(airport.icao)"
            >
              <span class="font-mono text-sm text-ink">{{ airport.icao }}</span>
              <span class="ml-auto shrink-0 text-xs text-faint">{{
                airport.count
              }}</span>
            </button>
          </li>
        </ul>
      </div>

      <!-- 选中机场的图册。 -->
      <div v-if="indexLoading" class="card mt-4 space-y-2 p-4">
        <p class="skeleton h-5 w-2/3"></p>
        <p class="skeleton h-5 w-full"></p>
        <p class="skeleton h-5 w-1/2"></p>
      </div>

      <div v-else-if="index" class="card mt-4 p-4">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="font-mono text-lg font-semibold tracking-tight text-ink">
            {{ index.icao }}
          </h2>
          <!--
            周期要看得见。一张不知道是哪一期的进近图，比没有图更危险 ——
            飞行员会照着它做决定。
          -->
          <span class="font-mono text-xs text-faint"
            >AIRAC {{ index.airac }}</span
          >
        </div>

        <p v-if="!index.groups.length" class="mt-3 text-sm text-muted">
          {{ t("charts.noCharts") }}
        </p>

        <div
          v-for="group in index.groups"
          :key="group.category"
          class="mt-4 first:mt-3"
        >
          <h3 class="text-xs font-semibold uppercase tracking-wide text-faint">
            {{ t(`charts.categories.${group.category}`) }}
          </h3>
          <ul role="list" class="mt-1 space-y-0.5">
            <li v-for="chart in group.charts" :key="chart.id">
              <button
                type="button"
                class="w-full rounded-control px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-sunken"
                :class="
                  selected?.id === chart.id
                    ? 'bg-surface-sunken font-medium text-ink'
                    : 'text-muted'
                "
                @click="selected = chart"
              >
                {{ chart.title }}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 阅读器。 -->
    <div class="card flex min-h-[28rem] flex-col overflow-hidden lg:min-h-0">
      <div
        v-if="selected"
        class="flex items-center gap-2 border-b border-subtle px-3 py-2"
      >
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:bg-surface-sunken hover:text-ink lg:hidden"
          :aria-label="t('common.back')"
          @click="selected = null"
        >
          <Icon name="arrowLeft" class="size-4" />
        </button>
        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {{ selected.title }}
        </h2>
      </div>

      <ChartViewer
        v-if="selected"
        :key="selected.id"
        :src="chartSrc"
        :labels="viewerLabels"
      />

      <div
        v-else
        class="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center"
      >
        <Icon name="documentText" class="size-6 text-faint" />
        <p class="mt-3 max-w-xs text-sm text-muted">
          {{ index ? t("charts.pickChart") : t("charts.pickAirport") }}
        </p>
      </div>
    </div>
  </div>
</template>
