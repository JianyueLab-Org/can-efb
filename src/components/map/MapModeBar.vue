<script setup lang="ts">
/**
 * 地图可见区左上的模式条：机组、管制、天气、钉板。一条玻璃，四个带字的开关；手机
 * 上只剩图标，字留在 aria-label 和 title 里。
 *
 * 机组、管制是实时那两层（useTrafficLayer），天气是降水（useWeatherLayer），钉板管
 * 底部那条钉住航图的栏。手机上没有那条栏，钉板按钮打开全部航图列表，所以它报的是
 * `aria-expanded` 而不是 `aria-pressed`。
 *
 * 实时和降水没取到时的那句话和重试挂在这里：它们不在工具栏的图层菜单里。
 *
 * 只收已经翻好的字符串、只往外发事件。
 */
import { Icon } from "@jianyuelab-org/can-ui";
import type { IconName } from "@jianyuelab-org/can-ui/icons";
import type { LayerId } from "@/components/map/useLayerNotice";

export type ModeToggle = "traffic" | "atcLive" | "weather" | "pinboard";

export interface MapModeBarText {
  /** 整条的名字（`role="group"`）。 */
  label: string;
  traffic: string;
  atc: string;
  weather: string;
  pinboard: string;
  /** 降水图例两端。 */
  weatherLight: string;
  weatherHeavy: string;
  /** 带 `{layer}`。 */
  layerFailed: string;
  retry: string;
}

const props = defineProps<{
  on: Record<ModeToggle, boolean>;
  /** 在线管制席位数，挂在管制按钮上。 */
  atcCount: number;
  phone: boolean;
  /** 全部航图列表开着。手机上钉板按钮开的是它。 */
  listOpen: boolean;
  /** 实时或降水没取到。别的层的失败在工具栏的图层菜单里。 */
  failure: "live" | "weather" | null;
  text: MapModeBarText;
}>();

const emit = defineEmits<{
  toggle: [ModeToggle];
  retry: [LayerId];
}>();

const MODES: { id: ModeToggle; icon: IconName }[] = [
  { id: "traffic", icon: "paperAirplane" },
  { id: "atcLive", icon: "signal" },
  { id: "weather", icon: "cloud" },
  { id: "pinboard", icon: "star" },
];

function label(id: ModeToggle): string {
  if (id === "traffic") return props.text.traffic;
  if (id === "atcLive") return props.text.atc;
  if (id === "weather") return props.text.weather;
  return props.text.pinboard;
}

/** 手机上的钉板按钮开列表，不是开关。 */
function opensList(id: ModeToggle): boolean {
  return props.phone && id === "pinboard";
}

function isOn(id: ModeToggle): boolean {
  return opensList(id) ? props.listOpen : props.on[id];
}

/** 没取到的是哪一层。`live` 是机组和管制共用的那一次取数，两个名字都报。 */
function failureText(): string {
  const layer =
    props.failure === "live"
      ? `${props.text.traffic} · ${props.text.atc}`
      : props.text.weather;
  return props.text.layerFailed.replace("{layer}", layer);
}
</script>

<template>
  <div class="map-modebar">
    <div class="map-modebar-strip glass" role="group" :aria-label="text.label">
      <button
        v-for="m in MODES"
        :key="m.id"
        type="button"
        class="map-mode-btn"
        :data-mode="m.id"
        :class="isOn(m.id) ? 'is-on' : ''"
        :aria-pressed="opensList(m.id) ? undefined : on[m.id]"
        :aria-expanded="opensList(m.id) ? listOpen : undefined"
        :aria-controls="opensList(m.id) ? 'map-chart-pins' : undefined"
        :aria-label="phone ? label(m.id) : undefined"
        :title="label(m.id)"
        @click="emit('toggle', m.id)"
      >
        <Icon :name="m.icon" class="size-4" />
        <span v-if="!phone">{{ label(m.id) }}</span>
        <span
          v-if="m.id === 'atcLive' && on.atcLive && atcCount"
          class="map-layer-count"
          >{{ atcCount }}</span
        >
      </button>
    </div>

    <!-- 降水图例：开着才有。颜色是 can-api 重新着色后的那条绿 → 黄 → 红。 -->
    <div v-if="on.weather" class="map-weather-legend glass" aria-hidden="true">
      <span>{{ text.weatherLight }}</span>
      <span class="map-weather-ramp"></span>
      <span>{{ text.weatherHeavy }}</span>
    </div>

    <!--
      没取到的那一层。它已经退回关了 —— 没有这一句，它就是安静地从图上消失，和
      「这一带没有数据」长得一模一样。
    -->
    <div v-if="failure" class="map-layer-failure glass" role="status">
      <span>{{ failureText() }}</span>
      <button
        type="button"
        class="link shrink-0"
        @click="emit('retry', failure)"
      >
        {{ text.retry }}
      </button>
    </div>
  </div>
</template>
