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
 * 条渲染 —— 实时数据源连不上不该让人看不到自己的计划。
 *
 * **地图画的是已提交的计划。** 打开这一页时向地图要一次（`showPlanOnMap`）：别的
 * 页面推过东西之后地图就不再自己画计划，概览是那个要回来的地方（见
 * `components/map/useRouteLayer.ts` 里 `subscribePlanRequest` 那一段）。
 *
 * 每一块都走 `RequestState`：读到了、确实没有、没读到，各说各的话。METAR 以前把
 * 「没读到」和「没有报文」当成一回事，一律显示「暂无报文」——现在分开：没读到的
 * 时候「暂无报文」是一句假话，读的人会以为这一带真的没有报文。
 *
 * **这里曾经还有一块飞行统计，删掉了。** 它显示的是 `logbook.stats.flights` 这样
 * 的**键名本身** —— 删飞行日志那一页时词典里的 `logbook` 命名空间跟着没了，模板
 * 却还在调它。`scripts/check-i18n-keys.mjs` 现在盯着这一类。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { loadFlightPlan } from "@/lib/planStore";
import { createTranslator } from "@/lib/i18n";
import { showPlanOnMap } from "@/lib/mapBus";
import {
  EMPTY_SELECTION,
  PROCEDURES_CHANGED_EVENT,
  readSelection,
  type ProcedureSelection,
} from "@/lib/procedureSelection";
import { fromApiResult, LOADING, type RequestState } from "@/lib/requestState";
import {
  facilityLabel,
  fetchDatafeed,
  onlineAtis,
  onlineControllers,
  type DatafeedController,
} from "@/lib/datafeed";
import {
  atisForAirport,
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
  // 和地图那一层共用一次（`lib/planStore.ts`）：打开概览时两边同时要。
  const result = await loadFlightPlan<Plan>();
  plan.value = fromApiResult(result);
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

/**
 * 模板narrowing不跟着索引表达式走（`metars[card.icao]` 每次都是一次新的查表），
 * `v-if` 判过 `kind === 'data'` 之后再在正文里取 `.data`，TS 已经不认得那是同一
 * 个对象。查两遍表也不是办法：两次查表之间那个键可能被 `loadMetar` 改写。用一个
 * 函数把「查一次、判一次、要就给」收在一起。
 */
function metarText(icao: string): string | null {
  const state = metars.value[icao];
  return state?.kind === "data" ? state.data : null;
}

/**
 * 起降机场的 ATIS。**本网自己的 ATIS 在线就先给它**，METAR 只在没有时才取。
 *
 * ATIS 是管制员此刻在用的那一份：使用跑道、通播代号、天气都在里面，而 METAR 只是天
 * 气。先有 ATIS 的场不再去问 can-api 要 METAR —— 那条接口按 IP 限流，全站共用一个出
 * 口 IP，省下的每一次都算数。
 */
function airportAtis(icao: string): DatafeedController[] {
  return atisForAirport(atis.value, icao);
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

/**
 * 在线管制。
 *
 * **这里放的是列表而不是地图上那些点，因为飞行员要的是频率。** 「谁在线、我该
 * 呼叫哪个频率」是一句话能答完的问题，去图上找一个点、再读它旁边的小字是绕远。
 * 地图那一层管的是"在哪"，这一层管的是"呼谁"。
 *
 * 不轮询：仪表盘是打开时看一眼的页面，而地图那块常驻组件已经在每 30 秒刷新。
 * 这里再起一个定时器，等于同一份数据在同一个标签页里被取两遍。
 *
 * ## 按机场归堆、按席位顺序排，这两条都来自 can-radar
 *
 * 上一版是**按呼号字母排的一条平铺列表**，理由写着"同一个机场的席位呼号前缀相
 * 同，排出来自然是挨着的"。前半句对，后半句不完全：挨着不等于分得开 —— 二十个席
 * 位平铺下来，眼睛得自己去数哪几行是同一个场的。而且字母序会把 `ZSSS_APP` 排在
 * `ZSSS_DEL` 前面，那正好是**联系顺序的反面**。
 *
 * 现在按 can-radar 的两条规矩来（`lib/atc.ts`）：场面席位并进机场那一堆，进近和
 * 区域各自成堆；堆内按放行→地面→塔台→进近→区域排，也就是一架飞机依次要叫的那个
 * 顺序，于是这份列表读起来本身就是一条流程。
 */
const groups = ref<StationGroup[]>([]);
const atis = ref<DatafeedController[]>([]);
const atcLoading = ref(true);
/**
 * datafeed 没取到。和飞行计划那份 `RequestState` 同一个判断：以前失败退回空列
 * 表，于是这一段写着「当前没有管制员在线」—— 同样是把失败画成了「没有」，而人
 * 会照着它决定不去叫放行。
 */
const atcFailed = ref(false);
/**
 * 取数那一刻的时间，给"上席多久"用。
 *
 * **存下来而不是在模板里调 `Date.now()`** —— 模板里每次重渲染都会重算，而 Vue 无
 * 从知道那个值变了，于是显示的时长会在某些重渲染后跳、另一些不跳。取一次，跟着这
 * 批数据走。
 */
const fetchedAt = ref(Date.now());

/** 席位总数，标题右边那个数 —— 归堆之后不能再数堆数。 */
const controllerCount = computed(() =>
  groups.value.reduce((n, g) => n + g.stations.length, 0),
);

async function loadControllers() {
  // 重试时先回到载入中，而不是停在失败那句上——否则按下重试按钮之后屏幕上什么
  // 都没变，人会怀疑是不是没按上。
  atcLoading.value = true;
  try {
    const feed = await fetchDatafeed();
    groups.value = groupControllers(onlineControllers(feed));
    // ATIS 单独一份，不混进上面 —— 见 datafeed.ts 里 onlineAtis 的注释。
    atis.value = onlineAtis(feed);
    fetchedAt.value = Date.now();
    atcFailed.value = false;
  } catch (error) {
    // 失败只在这一段里说，不在飞行计划上面压一条红条 —— 实时数据源连不上和这
    // 一页的其余部分无关。但要说出来，见 atcFailed。
    console.error("[efb] 在线管制加载失败:", error);
    groups.value = [];
    atis.value = [];
    atcFailed.value = true;
  } finally {
    atcLoading.value = false;
  }
}

/**
 * 本机为这份计划选的跑道和程序（`lib/procedureSelection.ts`）。不是计划的一部分，
 * 卡片上标明「本机」。另一个标签页改了选择时跟着变。
 */
const selectionVersion = ref(0);
function onSelectionChanged() {
  selectionVersion.value++;
}
const selection = computed<ProcedureSelection>(() => {
  void selectionVersion.value;
  const f = filed.value;
  return f ? readSelection(f.departure, f.arrival) : { ...EMPTY_SELECTION };
});

/** 一端的摘要：`RWY 32L · ASUKA4 (ASUKA)`。什么都没选时为空串。 */
function withTransition(name: string, transition: string): string {
  if (!name) return "";
  return transition ? `${name} (${transition})` : name;
}
const departureSummary = computed(() =>
  [
    selection.value.depRunway ? `RWY ${selection.value.depRunway}` : "",
    withTransition(selection.value.sid, selection.value.sidTransition),
  ]
    .filter(Boolean)
    .join(" · "),
);
const arrivalSummary = computed(() =>
  [
    selection.value.arrRunway ? `RWY ${selection.value.arrRunway}` : "",
    withTransition(selection.value.star, selection.value.starTransition),
    withTransition(
      selection.value.approach,
      selection.value.approachTransition,
    ),
  ]
    .filter(Boolean)
    .join(" · "),
);

/**
 * 等 datafeed 回来再决定取不取 METAR：先取了再被 ATIS 盖掉，是白花一次限流额度。
 * datafeed 失败时 `atis` 是空的，于是照常取 METAR —— 天气卡不因为实时源挂了就空着。
 * 之后 ATIS 上线了卡片就换成 ATIS；下线了、又还没取过 METAR，这里补取。
 */
watch(
  () => [filed.value, atcLoading.value, atis.value] as const,
  ([plan, loading]) => {
    if (!plan || loading) return;
    for (const icao of [plan.departure, plan.arrival]) {
      if (icao && !metars.value[icao] && !airportAtis(icao).length) {
        void loadMetar(icao);
      }
    }
  },
);

onMounted(() => {
  window.addEventListener(PROCEDURES_CHANGED_EVENT, onSelectionChanged);
  window.addEventListener("storage", onSelectionChanged);
  showPlanOnMap();
  void loadPlan();
  void loadControllers();
});
onBeforeUnmount(() => {
  window.removeEventListener(PROCEDURES_CHANGED_EVENT, onSelectionChanged);
  window.removeEventListener("storage", onSelectionChanged);
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
        <dl
          v-if="departureSummary || arrivalSummary"
          class="mt-3 grid gap-3 border-t border-subtle pt-3 text-sm @sm:grid-cols-2"
        >
          <div v-if="departureSummary">
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.departureProcedures") }}
            </dt>
            <dd class="font-mono text-ink">{{ departureSummary }}</dd>
          </div>
          <div v-if="arrivalSummary">
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.arrivalProcedures") }}
            </dt>
            <dd class="font-mono text-ink">{{ arrivalSummary }}</dd>
          </div>
          <p class="text-xs text-muted @sm:col-span-2">
            {{ t("dashboard.plan.proceduresLocal") }}
          </p>
        </dl>
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
          <!-- 本网的 ATIS 在线就给它，不再摆 METAR。见 airportAtis。 -->
          <template v-if="airportAtis(card.icao).length">
            <div
              v-for="a in airportAtis(card.icao)"
              :key="a.callsign"
              class="mt-2"
            >
              <div class="flex items-baseline justify-between gap-3">
                <span class="flex min-w-0 items-baseline gap-2">
                  <span class="truncate font-mono text-xs text-ink">{{
                    a.callsign
                  }}</span>
                  <!-- 认不出来就不显示，不猜。 -->
                  <span
                    v-if="atisLetter(a)"
                    class="rounded bg-overlay px-1.5 font-mono text-xs font-semibold text-ink"
                    >{{ atisLetter(a) }}</span
                  >
                </span>
                <span
                  class="shrink-0 font-mono text-xs tabular-nums text-ink"
                  >{{ a.frequency }}</span
                >
              </div>
              <p
                v-if="atisText(a)"
                class="mt-1 break-words font-mono text-xs leading-relaxed text-muted"
              >
                {{ atisText(a) }}
              </p>
            </div>
          </template>
          <p
            v-else-if="metarText(card.icao) !== null"
            class="mt-2 break-words font-mono text-xs leading-relaxed text-muted"
          >
            {{ metarText(card.icao) }}
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
      <!--
        一堆一个小节：场面席位归到机场四字码下面，进近和区域各自成堆。
        堆内的顺序是"该按这个次序联系"，不是字母序 —— 见 loadControllers 上面。
      -->
      <div v-else class="space-y-3">
        <div v-for="g in groups" :key="g.code">
          <p
            class="mb-1 font-mono text-xs font-semibold tracking-wide text-muted"
          >
            {{ g.code }}
          </p>
          <ul class="divide-y divide-subtle">
            <li
              v-for="c in g.stations"
              :key="c.callsign"
              class="flex items-baseline justify-between gap-3 py-1.5"
            >
              <span class="flex min-w-0 items-baseline gap-2">
                <!--
                  席位色。一个小方块而不是给整行上色：颜色在这里是**分类**，
                  不是强调，染满一行会让二十行里每一行都在喊。
                -->
                <span
                  class="inline-block size-2 shrink-0 rounded-[2px]"
                  :style="{ background: facilityColor(c.facility) }"
                  aria-hidden="true"
                ></span>
                <span class="truncate font-mono text-sm text-ink">{{
                  c.callsign
                }}</span>
                <span class="shrink-0 text-xs text-muted">{{
                  facilityLabel(c.facility)
                }}</span>
              </span>
              <span class="flex shrink-0 items-baseline gap-2">
                <!--
                  上席多久。**必须走 parseFeedTime** —— logon_time 是不带时区标
                  记的 UTC 墙钟，直接 new Date() 在中国会多算八小时，而算出来的
                  仍然是一个看着合理的时长。见 lib/atc.ts。
                -->
                <span
                  v-if="onlineFor(c.logon_time, fetchedAt)"
                  class="text-xs tabular-nums text-muted"
                  >{{ onlineFor(c.logon_time, fetchedAt) }}</span
                >
                <span class="font-mono text-sm tabular-nums text-ink">{{
                  c.frequency
                }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </PanelSection>

    <!--
      ATIS 通播。**和上面那段分开**，因为它不是能呼叫的席位 —— 混进去会让人对着
      一个没人的频率喊。但正文本身是放行前和进场前要听的东西，对飞行包来说是最有
      用的实时文本之一，所以是分开摆而不是丢掉。见 datafeed.ts 的 onlineAtis。
    -->
    <PanelSection v-if="atis.length" :title="t('dashboard.atis.title')">
      <div class="card p-4">
        <ul class="space-y-3">
          <li v-for="a in atis" :key="a.callsign">
            <div class="flex items-baseline justify-between gap-3">
              <span class="flex min-w-0 items-baseline gap-2">
                <span class="truncate font-mono text-sm text-ink">{{
                  a.callsign
                }}</span>
                <!-- 通播代号认不出来就不显示，不猜：错一个字母就是让人按上一份天气做决定。 -->
                <span
                  v-if="atisLetter(a)"
                  class="rounded bg-overlay px-1.5 font-mono text-xs font-semibold text-ink"
                  >{{ atisLetter(a) }}</span
                >
              </span>
              <span class="shrink-0 font-mono text-sm tabular-nums text-ink">{{
                a.frequency
              }}</span>
            </div>
            <p
              v-if="atisText(a)"
              class="mt-1 font-mono text-xs leading-relaxed text-muted"
            >
              {{ atisText(a) }}
            </p>
          </li>
        </ul>
      </div>
    </PanelSection>
  </div>
</template>
