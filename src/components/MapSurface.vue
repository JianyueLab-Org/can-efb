<script setup lang="ts">
/**
 * 常驻的显示面。轨在最左，中间是当前菜单项的面板，这一块占住右边。
 *
 * **它和 `RouteMap.vue` 不是一回事。** RouteMap 是画图的那一层（Leaflet、底图、
 * 大圆弧、主题跟随）；这一层负责「什么时候有东西可画」——订阅面板发来的点、在
 * 没有点的时候给出一个说人话的空状态、并且把 Leaflet 的加载时机压到最后。
 *
 * 三件事必须一起成立，少一件这个组件就会以不同的方式坏掉：
 *
 * 1. **绝不服务端渲染 Leaflet。** 它在模块顶层就摸 `window`。所以这里用
 *    `defineAsyncComponent` 引 RouteMap，并且用 `mounted` 守住 —— 静态 import
 *    或者去掉 `v-if`，`/route` 会直接 500。这条是 RoutePlanner 原本就有的写法，
 *    搬到这里之后适用范围从一个页面变成了整站，所以更不能松。
 *
 * 2. **没有点的时候不加载那 152 KB。** 空状态是纯 HTML，异步 chunk 只在第一次
 *    真的有航路时才下载。EFB 可能是在机上用平板打开的，没用到地图的人一个字节
 *    都不该付 —— 把地图变成常驻的显示面之后，这一点比以前更要紧，因为现在**每
 *    一页**都带着这块地图。
 *
 * 3. **空状态要说清楚为什么空，而不是摆一张空地图。** 这个网络今天只有一个地理
 *    数据源（`/api/v1/route`）：气象只有 METAR 原文没有坐标，实时流量被本站的
 *    反代白名单特意排除（那是 can-radar 的活），航图是版权数据。一张画不出东西
 *    的空地图会被当成坏掉的地图，而不是还没有数据的地图 —— 和那四个占位页不填
 *    假数据是同一条规矩。
 */
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  ref,
} from "vue";
import { subscribeToMap, type MapPoint } from "@/lib/mapBus";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
  /** 空状态标题，已翻译。 */
  emptyTitle: string;
  /** 空状态正文——说明今天为什么没有东西可画，已翻译。 */
  emptyBody: string;
}>();

/**
 * 见文件顶上第 1 条。`mounted` 之前一律不渲染 RouteMap。
 */
const mounted = ref(false);

const RouteMap = defineAsyncComponent(
  () => import("@/components/RouteMap.vue"),
);

const points = ref<MapPoint[]>([]);
const label = ref(props.label);

const hasPoints = computed(() => points.value.length > 0);

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  mounted.value = true;
  unsubscribe = subscribeToMap((payload) => {
    points.value = payload.points ?? [];
    // 面板可以覆盖角标；没给就沿用外壳传进来的那一份。
    label.value = payload.label ?? props.label;
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});
</script>

<template>
  <section class="app-map" :aria-label="label">
    <RouteMap
      v-if="mounted && hasPoints"
      :points="points"
      :label="label"
      class="h-full"
    />

    <!-- 空状态。纯 HTML，不触发那个异步 chunk。 -->
    <div
      v-else
      class="surface-grid flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
    >
      <p class="text-sm font-medium text-ink">{{ emptyTitle }}</p>
      <p class="max-w-sm text-sm text-muted">{{ emptyBody }}</p>
    </div>
  </section>
</template>
