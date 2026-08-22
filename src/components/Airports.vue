<script setup lang="ts">
/**
 * 机场索引。数据来自 **can-db**（航行资料库），由页面在服务端取好传进来。
 *
 * **为什么是 props 而不是自己 fetch**：这个岛屿从不直连 can-db。SSR 时
 * `server/canDb.ts` 已经带着成员的 cookie 问过一次了，再在浏览器里问一次，就得
 * 给 can-db 开 CORS、或者在本站反代白名单上多开一条 —— 两样都是为一个只读列表
 * 付的结构性代价。搜索是本地过滤，几百个机场不值得一个往返。
 *
 * **整张列表都推给地图，走 `markers` 而不是 `points`。** 那两个字段的区别不是样
 * 式：`points` 会被顺次连成一条航路线（那是 RouteMap 的用途），几百个机场塞进去
 * 就是一团面条。`markers` 只画点。
 *
 * 点某一行时**不重推整层**，只多带一个 `focus`：地图把镜头对过去，不重新框住全
 * 国 —— 否则用户刚才的缩放会被每一次点击丢掉一遍。
 */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import { publishToMap } from "@/lib/mapBus";

interface Airport {
  icao: string;
  fir: string | null;
  name: string | null;
  lat: number;
  lon: number;
  elev: number | null;
  airac: string;
  stands: number;
}

const props = defineProps<{
  airports: Airport[];
  messages: Record<string, unknown>;
}>();

const t = createTranslator(props.messages);

const query = ref("");
const selected = ref<string | null>(null);

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
  return props.airports
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
  return props.airports.filter(
    (a) =>
      a.icao.includes(q) ||
      (a.name ?? "").toUpperCase().includes(q) ||
      (a.fir ?? "").toUpperCase().includes(q),
  ).length;
});

/** 机场 → 地图上的一个点。`kind` 决定 RouteMap 把它画成方块而不是小圆点。 */
function toMarker(airport: Airport) {
  return {
    ident: airport.icao,
    lat: airport.lat,
    lon: airport.lon,
    kind: "airport",
  };
}

/**
 * 挑中一个机场：**只推那一个**，不铺全量。
 *
 * 从前这里推的是 433 个机场的全量点集，而且一进页面就推。两个后果：地图变成一片
 * 麻点，看不出任何东西；更要紧的是它**盖掉了成员自己那条飞行计划** —— 地图是常
 * 驻的，打开机场页等于把手上正在飞的那件事从图上抹掉。
 *
 * 现在这一页不主动往图上放任何东西。选中一个机场才推它一个，并把视野对过去。
 */
function showOnMap(airport: Airport) {
  publishToMap({
    markers: [toMarker(airport)],
    focus: toMarker(airport),
    label: airport.name ? `${airport.icao} · ${airport.name}` : airport.icao,
  });
}

function show(airport: Airport) {
  selected.value = airport.icao;
  showOnMap(airport);
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <label class="sr-only" for="airport-search">{{
      t("airports.search")
    }}</label>
    <input
      id="airport-search"
      v-model="query"
      type="search"
      autocomplete="off"
      :placeholder="t('airports.search')"
      class="input"
    />

    <p v-if="!query.trim()" class="text-sm text-muted">
      {{ t("airports.prompt", { count: String(props.airports.length) }) }}
    </p>

    <p v-else-if="!filtered.length" class="text-sm text-muted">
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

    <ul v-if="filtered.length" class="flex flex-col gap-2">
      <li v-for="airport in filtered" :key="airport.icao">
        <button
          type="button"
          class="card w-full p-3 text-left"
          :class="selected === airport.icao ? 'ring-2 ring-accent' : ''"
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
