<script setup lang="ts">
/**
 * 航路展开。把飞行计划里那一串航路字符串解析成航路点序列。
 *
 * can-api 的 `/api/v1/route` 返回的是坐标点（`ident`/`lat`/`lon`/`kind`/`via`），
 * 它本来是给雷达画线用的。这里要的是**航段表**。
 * 表回答「每段多远、一共多远」；「这条航路长什么样、绕不绕」由外壳右边那块常
 * 驻地图回答 —— 两件事仍然都要，只是图不再画在这个组件里了。
 *
 * 距离在前端算而不是找后端要：那边根本没有这个字段，而大圆距离是一个封闭的公
 * 式，不依赖任何数据。**它不是航程计算** —— 没有风、没有 SID/STAR 的实际展开
 * 长度，所以标签写的是「大圆」，不要在别处把它当计划燃油的依据。
 *
 * 解出来的航段会**发布**给外壳里那块常驻地图（`lib/mapBus.ts`），而不是在这里
 * 渲染一个 `<RouteMap>`。Leaflet 那一百多 KB 的加载时机没有变松：仍然要等真的
 * 有点可画，只是守门的地方从这个组件搬到了 `MapSurface.vue`。
 *
 * `503 navDataUnavailable` 是常态而不是故障：导航数据是 AIRAC 商业数据，按仓库
 * 的规矩不进公开镜像，某个环境上没挂它完全正常。所以这一支单独给一句人话，而
 * 不是塌进通用错误。
 */
import { ref, watch } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { Icon } from "@jianyuelab-org/can-ui";
import { distanceNm } from "@/lib/geo";
import { publishToMap } from "@/lib/mapBus";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

interface Point {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
}

interface Leg extends Point {
  /** 从上一个点飞到这个点的大圆距离，海里。第一个点是 0。 */
  legNm: number;
  cumulativeNm: number;
}

const departure = ref("");
const arrival = ref("");
const route = ref("");

const legs = ref<Leg[]>([]);

/**
 * 航段一变就交给外壳右边那块常驻地图。
 *
 * 离开这一页时**不清空**：地图是常驻的显示面，切到气象或日志时上一条航路仍然
 * 摆在那儿 —— 那正是这一版外壳想要的效果，而不是遗留状态。真要清空，应该有一
 * 个明确的入口（比如「新建航路」），而不是靠组件卸载顺手做掉。
 */
watch(legs, (value) => {
  publishToMap({ points: value, label: t("route.map.label") });
});
const total = ref(0);
const loading = ref(false);
const error = ref("");
const unavailable = ref(false);
const resolved = ref(false);

/** 大圆距离，海里。公式和地图画弧用的是同一个（`@/lib/geo`），不另开一份。 */
function legDistance(a: Point, b: Point): number {
  return distanceNm([a.lat, a.lon], [b.lat, b.lon]);
}

/** 把已提交的计划填进来，省得再抄一遍。 */
async function fromPlan() {
  const result = await api<{
    departure: string;
    arrival: string;
    route: string;
  } | null>("/api/v1/pilot/flightplan");
  if (!result.ok || !result.data) {
    error.value = t("route.noPlan");
    return;
  }
  departure.value = result.data.departure;
  arrival.value = result.data.arrival;
  route.value = result.data.route;
  error.value = "";
}

async function resolve() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  unavailable.value = false;
  resolved.value = false;
  legs.value = [];
  total.value = 0;

  const params = new URLSearchParams({
    departure: departure.value.trim().toUpperCase(),
    arrival: arrival.value.trim().toUpperCase(),
    route: route.value.trim(),
  });
  const result = await api<{ points: Point[] }>(`/api/v1/route?${params}`);
  loading.value = false;

  if (!result.ok) {
    if (result.error === "navDataUnavailable") {
      unavailable.value = true;
      return;
    }
    error.value = result.message;
    return;
  }

  const points = result.data.points ?? [];
  let running = 0;
  legs.value = points.map((point, index) => {
    const previous = points[index - 1];
    const legNm = previous ? legDistance(previous, point) : 0;
    running += legNm;
    return { ...point, legNm, cumulativeNm: running };
  });
  total.value = running;
  resolved.value = true;
}
</script>

<template>
  <div class="space-y-5">
    <div class="card space-y-4 p-5">
      <div class="grid gap-4 @xs:grid-cols-2 @2xl:grid-cols-4">
        <label class="block">
          <span class="mb-1 block text-sm font-medium text-ink">{{
            t("route.departure")
          }}</span>
          <input
            v-model="departure"
            class="input font-mono uppercase"
            maxlength="4"
            placeholder="ZBAA"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium text-ink">{{
            t("route.arrival")
          }}</span>
          <input
            v-model="arrival"
            class="input font-mono uppercase"
            maxlength="4"
            placeholder="ZSSS"
          />
        </label>
        <label class="block sm:col-span-2">
          <span class="mb-1 block text-sm font-medium text-ink">{{
            t("route.route")
          }}</span>
          <input
            v-model="route"
            class="input font-mono uppercase"
            placeholder="ELKUR A461 SASAN"
          />
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="loading"
          @click="resolve"
        >
          <Icon name="map" class="size-4" />
          {{ loading ? t("common.loading") : t("route.resolve") }}
        </button>
        <button type="button" class="btn btn-secondary" @click="fromPlan">
          <Icon name="paperAirplane" class="size-4" />
          {{ t("route.fromPlan") }}
        </button>
      </div>
    </div>

    <div
      v-if="unavailable"
      class="rounded-card border border-subtle bg-warning-bg px-4 py-3 text-sm text-warning-fg"
    >
      {{ t("route.navdataUnavailable") }}
    </div>

    <div
      v-else-if="error"
      class="rounded-card border border-subtle bg-danger-bg px-4 py-3 text-sm text-danger-fg"
    >
      {{ error }}
    </div>

    <template v-else-if="resolved">
      <p
        v-if="!legs.length"
        class="surface-grid rounded-card border border-dashed border-subtle px-6 py-12 text-center text-sm text-muted"
      >
        {{ t("route.noPoints") }}
      </p>

      <template v-else>
        <div class="card flex items-baseline justify-between gap-3 p-4">
          <span class="text-sm text-muted">{{ t("route.total") }}</span>
          <span class="font-mono text-2xl font-semibold text-ink">
            {{ total.toFixed(0) }}
            <span class="text-sm font-normal text-muted">nm</span>
          </span>
        </div>

        <div class="card table-scroll">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-subtle text-left">
                <th class="px-4 py-3 font-medium text-muted">
                  {{ t("route.table.ident") }}
                </th>
                <th class="px-4 py-3 font-medium text-muted">
                  {{ t("route.table.via") }}
                </th>
                <th class="px-4 py-3 font-medium text-muted">
                  {{ t("route.table.position") }}
                </th>
                <th class="px-4 py-3 text-right font-medium text-muted">
                  {{ t("route.table.leg") }}
                </th>
                <th class="px-4 py-3 text-right font-medium text-muted">
                  {{ t("route.table.cumulative") }}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-subtle">
              <tr v-for="(leg, index) in legs" :key="`${leg.ident}-${index}`">
                <td class="whitespace-nowrap px-4 py-2 font-mono text-ink">
                  {{ leg.ident }}
                </td>
                <td class="whitespace-nowrap px-4 py-2 font-mono text-muted">
                  {{ leg.via || "—" }}
                </td>
                <td
                  class="whitespace-nowrap px-4 py-2 font-mono text-xs text-faint"
                >
                  {{ leg.lat.toFixed(3) }}, {{ leg.lon.toFixed(3) }}
                </td>
                <td
                  class="whitespace-nowrap px-4 py-2 text-right font-mono text-muted"
                >
                  {{ index === 0 ? "—" : leg.legNm.toFixed(0) }}
                </td>
                <td
                  class="whitespace-nowrap px-4 py-2 text-right font-mono text-ink"
                >
                  {{ leg.cumulativeNm.toFixed(0) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="text-xs text-faint">{{ t("route.disclaimer") }}</p>
      </template>
    </template>
  </div>
</template>
