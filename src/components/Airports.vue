<script setup lang="ts">
/**
 * 机场索引。数据来自 **can-db**（航行资料库），由页面在服务端取好传进来。
 *
 * **为什么是 props 而不是自己 fetch**：这个岛屿从不直连 can-db。SSR 时
 * `server/canDb.ts` 已经带着成员的 cookie 问过一次了，再在浏览器里问一次，就得
 * 给 can-db 开 CORS、或者在本站反代白名单上多开一条 —— 两样都是为一个只读列表
 * 付的结构性代价。搜索是本地过滤，几百个机场不值得一个往返。
 *
 * **点一个机场只推**那一个点给地图，不是整张列表。`RouteMap` 会把连续的点连成
 * 航路线 —— 那是它的用途 —— 所以把一百个机场推过去会连成一团面条。单点走的是
 * `drawLine` 里 `points.length < 2` 那条提前返回，只落一个方块，再由 fitBounds
 * 框住（maxZoom 9 挡住一头扎到街道级）。
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

function show(airport: Airport) {
  selected.value = airport.icao;
  publishToMap({
    points: [
      {
        ident: airport.icao,
        lat: airport.lat,
        lon: airport.lon,
        kind: "airport",
      },
    ],
    label: airport.name ? `${airport.icao} · ${airport.name}` : airport.icao,
  });
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
