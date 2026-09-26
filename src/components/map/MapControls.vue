<script setup lang="ts">
/**
 * 压在地图上的那几样东西：图层菜单、两条提示、没取到的那一层和它的重试、「定位
 * 到我」。
 *
 * 放在地图上而不是面板里：地图跨页面常驻，面板每换一页整个换掉 —— 开关跟着面板
 * 走的话，切一页图层状态就没人管了。
 *
 * 原来是一排九颗按钮压在左下角。地图铺满视口之后那一排在手机上要折成三行，把能
 * 看的那一小块图盖掉一半，所以收进一个菜单。
 *
 * 只收已经翻好的字符串、只往外发事件；取数和状态都在 MapStage 的几个 use* 里。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { LayerId } from "@/components/map/useLayerNotice";
import type { LayerToggle } from "@/components/map/useChartLayers";

const props = defineProps<{
  labels: Record<LayerToggle, string>;
  text: { menu: string; retry: string; locate: string; layerFailed: string };
  on: Record<LayerToggle, boolean>;
  busy: { airways: boolean; other: boolean };
  /** 在线管制席位数，只给管制那一项挂角标（模板里 `id === 'atcLive'` 那一段）。 */
  atcCount: number;
  notice: { layer: string; text: string } | null;
  failure: LayerId | null;
  /** 自己连着线时才有；「定位到我」按钮只在那时出现。 */
  own: { callsign: string } | null;
}>();

const emit = defineEmits<{
  toggle: [LayerToggle];
  retry: [LayerId];
  locate: [];
}>();

/** 菜单里的顺序，和原来那一排按钮一致。 */
const ORDER: LayerToggle[] = [
  "airways",
  "firs",
  "navaids",
  "mora",
  "traffic",
  "atcLive",
  "ctr",
  "app",
  "restricted",
];

const menuOpen = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);

/** 打开时焦点落到第一个能按的开关上；Esc 关掉时回到按钮（见 onKeydown）。 */
async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (!menuOpen.value) return;
  await nextTick();
  menu.value
    ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ?.focus();
}

function isBusy(id: LayerToggle): boolean {
  if (id === "airways") return props.busy.airways;
  // 实时两层从来不禁用：取数途中再点一次是合法的，见 useTrafficLayer 的 liveAgain。
  if (id === "traffic" || id === "atcLive") return false;
  return props.busy.other;
}

/** 没取到的是哪一层。`live` 是机组和管制共用的那一次取数，两个名字都报。 */
function failureLabel(id: LayerId): string {
  if (id === "live") return `${props.labels.traffic} · ${props.labels.atcLive}`;
  return props.labels[id];
}

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) menuOpen.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !menuOpen.value) return;
  menuOpen.value = false;
  trigger.value?.focus();
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
  <div class="map-overlay">
    <!-- 「这一层没有数据」/「你没有航行资料库权限」。 -->
    <p v-if="notice" class="map-notice glass" :data-notice="notice.layer">
      {{ notice.text }}
    </p>

    <!-- 只在自己真的连着线时出现；按下去没反应的按钮比没有更让人怀疑。 -->
    <button
      v-if="own"
      type="button"
      class="map-locate glass"
      :aria-label="text.locate"
      :title="text.locate"
      @click="emit('locate')"
    >
      <span aria-hidden="true">✈</span>
      <span class="font-mono">{{ own.callsign }}</span>
    </button>

    <div ref="root" class="map-layers">
      <!--
        没取到的那一层。它已经退回关了 —— 没有这一句，它就是安静地从图上消失，和
        「这一带没有数据」长得一模一样。
      -->
      <div v-if="failure" class="map-layer-failure glass" role="status">
        <span>{{
          text.layerFailed.replace("{layer}", failureLabel(failure))
        }}</span>
        <button
          type="button"
          class="link shrink-0"
          @click="emit('retry', failure)"
        >
          {{ text.retry }}
        </button>
      </div>

      <button
        ref="trigger"
        type="button"
        class="map-layer-trigger glass"
        :aria-expanded="menuOpen"
        aria-controls="map-layer-menu"
        @click="toggleMenu"
      >
        <Icon name="squaresPlus" class="size-4" />
        <span>{{ text.menu }}</span>
      </button>
      <!--
        菜单排在按钮**后面**：打开后 Tab 从按钮直接走进菜单。画面上它仍在按钮上方
        （CSS 的 order）。v-show 而不是 v-if：aria-controls 要指得到一个真实的元素。
      -->
      <div
        v-show="menuOpen"
        id="map-layer-menu"
        ref="menu"
        class="map-layer-menu glass"
        role="group"
        :aria-label="text.menu"
      >
        <button
          v-for="id in ORDER"
          :key="id"
          type="button"
          class="map-layer-btn"
          :class="on[id] ? 'is-on' : ''"
          :aria-pressed="on[id]"
          :disabled="isBusy(id)"
          @click="emit('toggle', id)"
        >
          {{ labels[id]
          }}<span
            v-if="id === 'atcLive' && on.atcLive && atcCount"
            class="map-layer-count"
            >{{ atcCount }}</span
          >
        </button>
      </div>
    </div>
  </div>
</template>
