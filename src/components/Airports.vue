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
import { computed, onMounted, ref } from "vue";
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

const filtered = computed(() => {
  const q = query.value.trim().toUpperCase();
  if (!q) return props.airports;
  return props.airports.filter(
    (a) =>
      a.icao.includes(q) ||
      (a.name ?? "").toUpperCase().includes(q) ||
      (a.fir ?? "").toUpperCase().includes(q),
  );
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
 * 推给地图的是**全量**，不是筛选后的结果。
 *
 * 搜索框是用来在列表里找一行的，不是用来筛地图的 —— 边打字边让地图上的机场一批
 * 批消失，会让人以为数据在丢。真要做「只看某个 FIR」那种筛选，应该是一个明确的
 * 图层开关，不是搜索框的副作用。
 */
function publishAll(focus?: Airport) {
  publishToMap({
    markers: props.airports.map(toMarker),
    focus: focus ? toMarker(focus) : undefined,
    label: focus
      ? focus.name
        ? `${focus.icao} · ${focus.name}`
        : focus.icao
      : t("airports.mapLabel"),
  });
}

// 进页面就把机场铺上去，不用等用户点。这一页的主体就是那张图。
onMounted(() => publishAll());

function show(airport: Airport) {
  selected.value = airport.icao;
  publishAll(airport);
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

    <p v-if="!filtered.length" class="text-sm text-muted">
      {{ t("airports.none") }}
    </p>

    <ul v-else class="flex flex-col gap-2">
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
