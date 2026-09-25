<script setup lang="ts">
/**
 * 机场索引。数据来自 **can-db**（航行资料库），由页面在服务端取好传进来。
 *
 * **第一次由页面在服务端取好传进来**（`initial`）：SSR 时 `server/canDb.ts` 已经
 * 带着成员的 cookie 问过一次，打开页面不必再等一个往返。**重试在浏览器里做**，走
 * `/api/db/aip/airports` —— 那条本来就在本站反代白名单上（地面图层的机场索引也读
 * 它），重试不多开任何一条路。
 *
 * **整张列表都推给地图，走 `markers` 而不是 `points`。** 那两个字段的区别不是样
 * 式：`points` 会被顺次连成一条航路线（那是 RouteMap 的用途），几百个机场塞进去
 * 就是一团面条。`markers` 只画点。
 *
 * 点某一行时**不重推整层**，只多带一个 `focus`：地图把镜头对过去，不重新框住全
 * 国 —— 否则用户刚才的缩放会被每一次点击丢掉一遍。
 */
import { computed, nextTick, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import { focusMap, publishToMap } from "@/lib/mapBus";
import { unwrapList } from "@/lib/aip";
import { dbFetch } from "@/lib/naip";
import { fromDbResponse, LOADING, type RequestState } from "@/lib/requestState";
import StateCard from "@/components/ui/StateCard.vue";
import Field from "@/components/ui/Field.vue";
import AirportDetail from "./AirportDetail.vue";
import type { AirportRow as Airport } from "@/lib/airports";

const props = defineProps<{
  initial: RequestState<Airport[]>;
  messages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

const state = ref<RequestState<Airport[]>>(props.initial);
const airports = computed(() =>
  state.value.kind === "data" ? state.value.data : [],
);

/**
 * **走 `dbFetch`，不是裸 `fetch`。** SSR 那次（`server/canDb.ts`）看不见
 * localStorage，本来就没法按「隐藏 NAIP」过滤 —— 这是已知的 SSR 缺口，不是这里要
 * 补的。但**浏览器里的每一次 `/api/db/*` 都必须走 `dbFetch`**：它按当下的开关状态
 * 加 `?unrestricted=1`。裸 `fetch` 会漏掉这个参数，于是重试这一条路就会一直无视
 * 成员刚在设置页打开的「隐藏 NAIP」，和这张图上其余每一次浏览器发起的请求都不一致
 * （`lib/naip.ts`）。
 */
async function reload() {
  state.value = LOADING;
  const response = await dbFetch("aip/airports").catch(() => null);
  if (!response) {
    state.value = { kind: "error", status: 0 };
    return;
  }
  const list = response.ok
    ? unwrapList<Airport>(await response.json().catch(() => null))
    : null;
  state.value = fromDbResponse(
    response.ok,
    response.status,
    list,
    (l) => !l.length,
  );
  // 重试成功时 StateCard 的「重试」按钮跟着 error 状态一起消失，焦点会掉回
  // <body>——只有 `data` 换来搜索框；`empty` 没有可聚的输入框，留给下一段代码
  // 处理不到也不报错（`searchInput.value` 那时是 null）。
  if (state.value.kind === "data") {
    await nextTick();
    searchInput.value?.focus();
  }
}

const query = ref("");
const selected = ref<Airport | null>(null);

/** 搜索框的元素引用，重试成功和从详情返回都要把焦点收回这里。 */
const searchInput = ref<HTMLInputElement | null>(null);

/**
 * 列表里每一行的按钮引用，按 ICAO 存。**只会留下当前渲染着的那些** —— Vue 在元
 * 素卸载时把函数式 ref 调成 `null`，所以从详情返回时不必自己清理旧条目。
 */
const resultRefs = new Map<string, HTMLButtonElement>();

function setResultRef(icao: string, el: Element | null) {
  if (el) resultRefs.set(icao, el as HTMLButtonElement);
  else resultRefs.delete(icao);
}

/**
 * 从详情返回列表：焦点必须跟着走，否则「返回列表」按钮随 AirportDetail 一起卸
 * 载，焦点会静静地掉回 `<body>` —— 读屏用户和纯键盘用户都感觉不到自己回到了哪
 * 里。优先落回刚才选中的那一行（多半还在原地：`query` 没变），它已经不在筛选结
 * 果里就退回搜索框——那是这个视图里恒在的东西。
 */
function back() {
  const icao = selected.value?.icao;
  selected.value = null;
  nextTick(() => {
    const item = icao ? resultRefs.get(icao) : undefined;
    (item ?? searchInput.value)?.focus();
  });
}

/** 一次最多列这么多条。见 `filtered`。 */
const MAX_RESULTS = 12;

/**
 * **不打字就不列。**
 *
 * 从前空查询返回的是全量 433 个机场，于是这一页打开就是一面墙 —— 要找一个场得先
 * 滚过几百张卡片，而搜索框本来就是为这件事存在的。现在空查询给空列表，输入才出
 * 结果，并且截到 12 条：再多就又变回那面墙了，而超过 12 条通常意味着该多打一个
 * 字母，不是该往下滚。
 *
 * 截断要**说出来**（见模板里那句），否则「我搜的场明明有，怎么不在里面」是查不
 * 出原因的 —— 悄悄截断和没有那条数据在屏幕上长得一模一样。
 */
const filtered = computed(() => {
  const q = query.value.trim().toUpperCase();
  if (!q) return [];
  return airports.value
    .filter(
      (a) =>
        a.icao.includes(q) ||
        (a.name ?? "").toUpperCase().includes(q) ||
        (a.fir ?? "").toUpperCase().includes(q),
    )
    .slice(0, MAX_RESULTS);
});

/** 命中总数，用来判断有没有被截断。 */
const matchCount = computed(() => {
  const q = query.value.trim().toUpperCase();
  if (!q) return 0;
  return airports.value.filter(
    (a) =>
      a.icao.includes(q) ||
      (a.name ?? "").toUpperCase().includes(q) ||
      (a.fir ?? "").toUpperCase().includes(q),
  ).length;
});

/**
 * 挑中一个机场：**只推那一个**，不铺全量，再把镜头对过去。
 *
 * 从前这里推的是 433 个机场的全量点集，而且一进页面就推。两个后果：地图变成一片
 * 麻点，看不出任何东西；更要紧的是它**盖掉了成员自己那条飞行计划** —— 地图是常
 * 驻的，打开机场页等于把手上正在飞的那件事从图上抹掉。
 *
 * 现在这一页不主动往图上放任何东西。选中一个机场才推它一个，并把视野对过去。
 *
 * 先推点、再对焦，顺序是要紧的：地图收到新的点会把旧焦点作废（否则它不框选新内
 * 容），对焦要落在那之后。
 */
function show(airport: Airport) {
  selected.value = airport;
  publishToMap({
    markers: [
      {
        ident: airport.icao,
        lat: airport.lat,
        lon: airport.lon,
        kind: "airport",
      },
    ],
    label: airport.name ? `${airport.icao} · ${airport.name}` : airport.icao,
  });
  focusMap({ kind: "point", lat: airport.lat, lon: airport.lon, zoom: 10 });
}
</script>

<template>
  <StateCard
    v-if="state.kind === 'loading'"
    kind="loading"
    :title="t('common.loading')"
  />
  <!-- 没权限是大多数飞行员的常态，不是故障：说清楚谁能开通。 -->
  <StateCard
    v-else-if="state.kind === 'forbidden'"
    kind="forbidden"
    :title="t('airports.denied.title')"
    :body="t('airports.denied.body')"
  />
  <StateCard
    v-else-if="state.kind === 'error'"
    kind="error"
    :title="t('airports.error.title')"
    :body="t('airports.error.body')"
    :retry-label="t('common.retry')"
    @retry="reload"
  />
  <StateCard
    v-else-if="state.kind === 'empty'"
    kind="empty"
    :title="t('airports.empty')"
  />

  <AirportDetail
    v-else-if="selected"
    :airport="selected"
    :messages="messages"
    @back="back"
  />

  <div v-else class="flex flex-col gap-4">
    <Field :label="t('airports.search')">
      <template #default="{ id, describedby }">
        <input
          :id="id"
          ref="searchInput"
          v-model="query"
          type="search"
          autocomplete="off"
          :placeholder="t('airports.search')"
          :aria-describedby="describedby"
          class="input"
        />
      </template>
    </Field>

    <p v-if="!query.trim()" class="text-sm text-muted" role="status">
      {{ t("airports.prompt", { count: String(airports.length) }) }}
    </p>

    <p v-else-if="!filtered.length" class="text-sm text-muted" role="status">
      {{ t("airports.none") }}
    </p>

    <p v-if="matchCount > filtered.length" class="text-xs text-faint">
      {{
        t("airports.truncated", {
          shown: String(filtered.length),
          total: String(matchCount),
        })
      }}
    </p>

    <!--
      选中一个机场就切到 AirportDetail（上面 v-else-if="selected"），这个列表和
      详情互斥 —— 走到这里 `selected` 必是 null，列表里不再需要一个「哪条被选
      中」的高亮态。返回列表时 `selected` 重置为 null，`query` 原样保留。

      每个按钮挂一个 `:ref`，`back()` 靠它把焦点还给刚才选中的那一行。
    -->
    <ul v-if="filtered.length" class="flex flex-col gap-2">
      <li v-for="airport in filtered" :key="airport.icao">
        <button
          type="button"
          class="card w-full p-3 text-left"
          :ref="(el) => setResultRef(airport.icao, el as Element | null)"
          @click="show(airport)"
        >
          <span class="flex items-baseline justify-between gap-3">
            <span class="font-mono text-base font-semibold text-ink">
              {{ airport.icao }}
            </span>
            <span v-if="airport.fir" class="font-mono text-xs text-muted">
              {{ airport.fir }}
            </span>
          </span>

          <span v-if="airport.name" class="mt-1 block text-sm text-muted">
            {{ airport.name }}
          </span>

          <span class="mt-1 flex flex-wrap gap-x-4 text-xs text-muted">
            <span v-if="airport.elev !== null">
              {{ t("airports.elev") }} {{ airport.elev }} ft
            </span>
            <span>{{ t("airports.stands") }} {{ airport.stands }}</span>
            <span class="font-mono">AIRAC {{ airport.airac }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
