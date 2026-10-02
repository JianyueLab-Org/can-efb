<script setup lang="ts">
/**
 * 模式条下面那一列图标按钮：IFR 高 / 低空、图层、3D、定位到我。
 *
 * 图层按钮向右弹出静态那几层（航路、情报区、导航台、MORA、区域、进近、限制区）。
 * 哪一层没取到，就在那一层下面说，带重试；菜单关着时图层按钮挂一个警示点，失败不
 * 安静地藏在菜单里。实时和降水的失败在模式条上。
 *
 * 手机上 3D 收进图层菜单。「定位到我」只在自己连着线时出现。
 *
 * 只收已经翻好的字符串、只往外发事件。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { LayerId } from "@/components/map/useLayerNotice";
import type { ChartLayerToggle } from "@/components/map/useChartLayers";
import type { IfrChart } from "@/lib/ifrChart";

export interface MapToolbarText {
  /** 整列的名字（`role="group"`）。 */
  label: string;
  /** 图层按钮和菜单的名字。 */
  layers: string;
  /** 带 `{layer}`。 */
  layerFailed: string;
  retry: string;
  view3d: string;
  locate: string;
  /** 按钮上那两行的第一行。 */
  high: string;
  low: string;
  /** 两张航图的全名，读屏和 title 用。 */
  chartHigh: string;
  chartLow: string;
  /** 带 `{current}`、`{next}`。 */
  chartSwitch: string;
}

const props = defineProps<{
  labels: Record<ChartLayerToggle, string>;
  on: Record<ChartLayerToggle, boolean>;
  /** 当前航图：管航路、航路点和禁区一族画哪些。 */
  chart: IfrChart;
  busy: { airways: boolean; other: boolean };
  failure: LayerId | null;
  /** 地图此刻倾斜着。 */
  view3d: boolean;
  /** 自己连着线时才有。 */
  own: { callsign: string } | null;
  phone: boolean;
  text: MapToolbarText;
}>();

const emit = defineEmits<{
  toggle: [ChartLayerToggle];
  chart: [IfrChart];
  retry: [LayerId];
  view3d: [];
  locate: [];
}>();

/** 菜单里的顺序，和原来图层菜单里静态那几层一致。 */
const LAYERS: ChartLayerToggle[] = [
  "airways",
  "firs",
  "navaids",
  "mora",
  "ctr",
  "app",
  "restricted",
];

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const flyout = ref<HTMLElement | null>(null);

/** 静态那几层里没取到的那一层。 */
const staticFailure = computed<ChartLayerToggle | null>(() => {
  const f = props.failure;
  return f && f !== "live" && f !== "weather" ? f : null;
});

/** 图层按钮的名字。有一层没取到时把那句话接在后面，菜单关着也读得到。 */
const layersName = computed(() =>
  staticFailure.value
    ? `${props.text.layers} · ${props.text.layerFailed.replace(
        "{layer}",
        props.labels[staticFailure.value],
      )}`
    : props.text.layers,
);

const nextChart = computed<IfrChart>(() =>
  props.chart === "high" ? "low" : "high",
);

function chartTitle(c: IfrChart): string {
  return c === "high" ? props.text.chartHigh : props.text.chartLow;
}

const chartName = computed(() =>
  props.text.chartSwitch
    .replace("{current}", chartTitle(props.chart))
    .replace("{next}", chartTitle(nextChart.value)),
);

const locateName = computed(() =>
  props.own ? `${props.text.locate} ${props.own.callsign}` : props.text.locate,
);

function isBusy(id: ChartLayerToggle): boolean {
  return id === "airways" ? props.busy.airways : props.busy.other;
}

/** 打开时焦点落到第一个能按的开关上；Esc 关掉时回到按钮（见 onKeydown）。 */
async function toggleFlyout() {
  open.value = !open.value;
  if (!open.value) return;
  await nextTick();
  flyout.value
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false;
}

/** 只管焦点在工具栏里的 Esc：列表、查看器各有自己的 Esc。 */
function onKeydown(event: KeyboardEvent) {
  if (
    event.key !== "Escape" ||
    !open.value ||
    !root.value?.contains(document.activeElement)
  )
    return;
  open.value = false;
  trigger.value?.focus();
}

/** 焦点离开工具栏（Tab 出去）就收起菜单。 */
function onFocusout(event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  if (open.value && next && !root.value?.contains(next)) open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div
    ref="root"
    class="map-toolbar glass"
    role="group"
    :aria-label="text.label"
    @focusout="onFocusout"
  >
    <!-- IFR 高空 / 低空：按一下换到另一张。航路关着也管禁区一族，所以一直在。 -->
    <button
      type="button"
      class="map-tool-btn map-tool-chart"
      :aria-label="chartName"
      :title="chartName"
      @click="emit('chart', nextChart)"
    >
      <span>{{ chart === "high" ? text.high : text.low }}</span>
      <span>IFR</span>
    </button>

    <div class="map-tool-wrap">
      <button
        ref="trigger"
        type="button"
        class="map-tool-btn"
        :class="open ? 'is-on' : ''"
        :aria-expanded="open"
        aria-controls="map-layer-flyout"
        :aria-label="layersName"
        :title="layersName"
        @click="toggleFlyout"
      >
        <Icon name="squaresPlus" class="size-5" />
        <span v-if="staticFailure" class="map-tool-alert" aria-hidden="true" />
      </button>
      <!-- v-show 而不是 v-if：aria-controls 要指得到一个真实的元素。 -->
      <div
        v-show="open"
        id="map-layer-flyout"
        ref="flyout"
        class="map-layer-flyout glass"
        role="group"
        :aria-label="text.layers"
      >
        <template v-for="id in LAYERS" :key="id">
          <button
            type="button"
            class="map-layer-btn"
            :class="on[id] ? 'is-on' : ''"
            :aria-pressed="on[id]"
            :disabled="isBusy(id)"
            @click="emit('toggle', id)"
          >
            {{ labels[id] }}
          </button>
          <div
            v-if="staticFailure === id"
            class="map-layer-failure"
            role="status"
          >
            <span>{{ text.layerFailed.replace("{layer}", labels[id]) }}</span>
            <button
              type="button"
              class="link shrink-0"
              @click="emit('retry', id)"
            >
              {{ text.retry }}
            </button>
          </div>
        </template>
        <!-- 手机上 3D 在这里，不占工具栏的一格。 -->
        <button
          v-if="phone"
          type="button"
          class="map-layer-btn"
          :class="view3d ? 'is-on' : ''"
          :aria-pressed="view3d"
          @click="emit('view3d')"
        >
          {{ text.view3d }}
        </button>
      </div>
    </div>

    <!-- 倾斜视角：空域立体块、航线高度剖面、机组高度柱。手势倾斜也会让它亮起来。 -->
    <button
      v-if="!phone"
      type="button"
      class="map-tool-btn"
      :class="view3d ? 'is-on' : ''"
      :aria-pressed="view3d"
      :title="text.view3d"
      @click="emit('view3d')"
    >
      <span class="text-xs font-semibold">{{ text.view3d }}</span>
    </button>

    <!-- 只在自己真的连着线时出现；按下去没反应的按钮比没有更让人怀疑。 -->
    <button
      v-if="own"
      type="button"
      class="map-tool-btn"
      :aria-label="locateName"
      :title="locateName"
      @click="emit('locate')"
    >
      <span aria-hidden="true">✈</span>
    </button>
  </div>
</template>
