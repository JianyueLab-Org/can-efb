<script setup lang="ts">
/**
 * 常驻的显示面。轨在最左，中间是当前菜单项的面板，这一块占住右边。
 *
 * **它和 `RouteMap.vue` 不是一回事。** RouteMap 是画图的那一层（Leaflet、底图、
 * 大圆弧、主题跟随）；这一层负责订阅面板发来的点、在没有点的时候把「为什么还
 * 没东西」说出来，以及守住 Leaflet 那条唯一不能松的规矩。
 *
 * **底图始终在。** 第一版不是这样：没有航路时整块地图被一段文字替掉，理由是
 * 「一张画不出东西的空地图会被当成坏掉的地图」。那个理由站不住 —— 底图本身是
 * 真实的地理数据，不是编出来的占位数字，显示它并不违反那条不填假数据的规矩；
 * 而把整块显示面换成一段文字，恰恰破坏了这一版外壳的前提（右边就是地图）。所
 * 以现在改成：底图永远画，说明缩成压在角上的一个小提示。
 *
 * 代价写在这里，别当它不存在：**Leaflet 那 152 KB 现在每一页都要加载**，不再是
 * 「解出航路才下载」。这是为「地图是主体」付的钱。如果哪天要把它省回来，正确的
 * 做法是让不可能画出东西的页面根本不渲染这一列，而不是把底图换成文字。
 *
 * 仍然不能松的那一条：**绝不服务端渲染 Leaflet。** 它在模块顶层就摸 `window`。
 * 所以这里用 `defineAsyncComponent` 引 RouteMap，并且用 `mounted` 守住 —— 改成
 * 静态 import、或者去掉 `v-if`，每一个页面都会 500（不再只是 `/route`，因为这
 * 块地图现在挂在外壳上）。
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
  /** 没东西可画时那条提示的标题，已翻译。 */
  emptyTitle: string;
  /** 没东西可画时那条提示的正文，已翻译。 */
  emptyBody: string;
}>();

/** 见文件顶上最后一段。`mounted` 之前一律不渲染 RouteMap。 */
const mounted = ref(false);

const RouteMap = defineAsyncComponent(
  () => import("@/components/RouteMap.vue"),
);

const points = ref<MapPoint[]>([]);
const markers = ref<MapPoint[]>([]);
const focus = ref<MapPoint | null>(null);
const label = ref(props.label);

/** 有任何一种可画的东西，就不该再显示那条「还没有东西」的提示。 */
const hasPoints = computed(
  () => points.value.length > 0 || markers.value.length > 0,
);

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  mounted.value = true;
  unsubscribe = subscribeToMap((payload) => {
    points.value = payload.points ?? [];
    markers.value = payload.markers ?? [];
    focus.value = payload.focus ?? null;
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
    <!--
      `points` 为空也照样渲染：RouteMap 的 render() 里有 `if (!points.length)
      return`，空点集只画底图，不会抛。
    -->
    <RouteMap
      v-if="mounted"
      :points="points"
      :markers="markers"
      :focus="focus"
      :label="label"
      class="h-full"
    />

    <!--
      水合之前的占位。不能在这里放 Leaflet（SSR 会抛），但也不能什么都不放 ——
      否则首屏这一整列是空的，等 JS 到了才突然出现一块地图。
    -->
    <div v-else class="surface-grid h-full"></div>

    <!--
      没东西可画时的提示。压在地图**上角**而不是替掉整块：这一版外壳的前提就是
      右边是地图，把它整个换成文字等于把前提拿掉。
    -->
    <div v-if="!hasPoints" class="map-hint card">
      <p class="font-medium text-ink">{{ emptyTitle }}</p>
      <p class="mt-1 text-muted">{{ emptyBody }}</p>
    </div>
  </section>
</template>
