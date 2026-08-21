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
 * **这里曾经还有一块飞行统计，删掉了。** 它显示的是
 * `logbook.stats.flights` 这样的**键名本身** —— 删飞行日志那一页时词典里的
 * `logbook` 命名空间跟着没了，模板却还在调它，而翻译器查不到键就回退成显示键名。
 * 排版正常、旁边还有一个真的数字，所以它看起来完全像一个真的标签。
 * `scripts/check-i18n-keys.mjs` 现在盯着这一类。
 */
import { computed, onMounted, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
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

const props = defineProps<{
  messages: Record<string, unknown>;
  userName: string;
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
const plan = ref<Plan | null>(null);
const planLoading = ref(true);
const metars = ref<Record<string, string | null>>({});

async function loadMetar(icao: string) {
  if (!icao) return;
  const result = await api<{ icao: string; metar: string | null }>(
    `/api/v1/metar?icao=${encodeURIComponent(icao)}`,
  );
  // 失败和「没有报文」在这一页上是同一件事：都显示成没有。天气是辅助信息，
  // 不值得为它在概览上摆一个错误框。
  metars.value[icao] = result.ok ? result.data.metar : null;
}

/**
 * 计划**没取到**，和**没有计划**，是两件事。
 *
 * 以前这里失败是静默 return —— `plan` 留在 null，于是这一段显示「还没有提交飞行
 * 计划」，而那是一句**假话**：成员可能明明交了，只是这一次没读上。按钮跟着变成
 * 「去提交」，于是它还在**劝人再交一份**。
 *
 * 和地图那些空图层是同一类坏法：**把失败画成了「没有」**。区别是这一处更贵 ——
 * 地图上少一层线是看得出来的，而「你没有计划」是一句读起来完全正常的话。
 */
const planFailed = ref(false);

async function loadPlan() {
  const result = await api<Plan | null>("/api/v1/pilot/flightplan");
  planLoading.value = false;
  if (!result.ok) {
    planFailed.value = true;
    return;
  }
  planFailed.value = false;
  plan.value = result.data ?? null;
  if (plan.value) {
    void loadMetar(plan.value.departure);
    void loadMetar(plan.value.arrival);
  }
}

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
  try {
    const feed = await fetchDatafeed();
    groups.value = groupControllers(onlineControllers(feed));
    // ATIS 单独一份，不混进上面 —— 见 datafeed.ts 里 onlineAtis 的注释。
    atis.value = onlineAtis(feed);
    fetchedAt.value = Date.now();
  } catch (error) {
    // 静默退回空列表：一个连不上实时数据源的仪表盘不该在飞行计划上面压一条
    // 红条 —— 它和这一页的其余部分完全无关。
    console.error("[efb] 在线管制加载失败:", error);
    groups.value = [];
    atis.value = [];
  } finally {
    atcLoading.value = false;
  }
}

onMounted(() => {
  void loadPlan();
  void loadControllers();
});
</script>

<template>
  <div class="space-y-5">
    <p class="text-sm text-muted">
      {{ t("dashboard.greeting", { name: userName }) }}
    </p>

    <!-- 当前计划 -->
    <section class="card p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold text-ink">
          {{ t("dashboard.plan.title") }}
        </h2>
        <!--
          没读到计划时按钮说「查看 / 修改」而不是「去提交」。
          我们不知道他有没有计划，而「去提交」是在替他假设没有 —— 那正是可能让他
          交出第二份的那句话。「查看 / 修改」在两种情形下都说得通。
        -->
        <a href="/flightplan" class="link text-sm">{{
          plan || planFailed
            ? t("dashboard.plan.edit")
            : t("dashboard.plan.file")
        }}</a>
      </div>

      <p v-if="planLoading" class="skeleton mt-3 h-6 w-2/3"></p>

      <!--
        **失败要排在「没有」前面。** 两句话占同一个位置，而如果先判 `!plan`，读取
        失败会落进「还没有提交飞行计划」—— 那正是要修的那句假话。
      -->
      <p v-else-if="planFailed" class="mt-3 text-sm text-danger">
        {{ t("dashboard.plan.failed") }}
      </p>

      <p v-else-if="!plan" class="mt-3 text-sm text-muted">
        {{ t("dashboard.plan.none") }}
      </p>

      <template v-else>
        <div class="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="font-mono text-xl font-semibold text-ink">{{
            plan.callsign
          }}</span>
          <span class="font-mono text-xl text-ink">
            {{ plan.departure }}
            <Icon name="arrowRight" class="inline size-4 text-faint" />
            {{ plan.arrival }}
          </span>
          <span v-if="plan.alternate" class="font-mono text-sm text-muted">
            {{ t("dashboard.plan.alternate") }} {{ plan.alternate }}
          </span>
        </div>
        <dl class="mt-3 grid gap-3 text-sm @sm:grid-cols-3">
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.aircraft") }}
            </dt>
            <dd class="truncate font-mono text-ink">{{ plan.aircraft }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.off") }}
            </dt>
            <dd class="font-mono text-ink">{{ plan.departureTime }}Z</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.level") }}
            </dt>
            <dd class="font-mono text-ink">{{ plan.cruisingAltitude }}</dd>
          </div>
        </dl>
        <p
          v-if="plan.route"
          class="mt-3 break-words font-mono text-xs text-muted"
        >
          {{ plan.route }}
        </p>
      </template>
    </section>

    <!-- 起降天气 -->
    <section v-if="plan" class="grid gap-3 @md:grid-cols-2">
      <div
        v-for="icao in [plan.departure, plan.arrival]"
        :key="icao"
        class="card p-4"
      >
        <h3 class="font-mono text-sm font-semibold text-ink">{{ icao }}</h3>
        <p
          v-if="metars[icao]"
          class="mt-2 break-words font-mono text-xs leading-relaxed text-muted"
        >
          {{ metars[icao] }}
        </p>
        <p v-else class="mt-2 text-xs text-faint">
          {{ t("dashboard.weather.none") }}
        </p>
      </div>
    </section>

    <!-- 在线管制。频率是这一段存在的理由，见 loadControllers 上面的注释。 -->
    <section class="card p-5">
      <div class="mb-3 flex items-baseline justify-between">
        <h2 class="text-sm font-semibold text-ink">
          {{ t("dashboard.atc.title") }}
        </h2>
        <span v-if="!atcLoading" class="text-xs text-muted">{{
          t("dashboard.atc.count", { count: String(controllerCount) })
        }}</span>
      </div>

      <p v-if="atcLoading" class="text-sm text-muted">
        {{ t("dashboard.atc.loading") }}
      </p>
      <p v-else-if="!groups.length" class="text-sm text-muted">
        {{ t("dashboard.atc.none") }}
      </p>
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
    </section>

    <!--
      ATIS 通播。**和上面那段分开**，因为它不是能呼叫的席位 —— 混进去会让人对着
      一个没人的频率喊。但正文本身是放行前和进场前要听的东西，对飞行包来说是最有
      用的实时文本之一，所以是分开摆而不是丢掉。见 datafeed.ts 的 onlineAtis。
    -->
    <section v-if="atis.length" class="card p-5">
      <h2 class="mb-3 text-sm font-semibold text-ink">
        {{ t("dashboard.atis.title") }}
      </h2>
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
    </section>
  </div>
</template>
