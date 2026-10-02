<script setup lang="ts">
/**
 * 地图底部的钉板（平板和桌面）：钉住的航图按机场排成一行标签。点一个在查看器里
 * 打开；查看器开着时点另一个直接换。最左是「全部航图」按钮。
 *
 * 状态是 MapStage 建的那一份（`useChartPins`），这里不取数。分组和每个机场那颗小牌
 * 子在 `lib/pinboard.ts`。
 *
 * 键盘：整条是一个 toolbar，只有一个 Tab 停点；左右方向键、Home、End 在按钮之间
 * 走，Enter 打开。右键、长按或菜单键弹出「取消钉住」。
 *
 * 自己的高度经 `height` 报给 MapStage：地图内边距和查看器底边按它让。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  shallowRef,
} from "vue";
import { Icon, Spinner } from "@jianyuelab-org/can-ui";
import { CHART_STRIP_CLASS } from "@/components/chartTags";
import { injectChartPins } from "@/components/map/useChartPins";
import type { ChartEntry } from "@/lib/charts";
import {
  chipRetries,
  pinboardGroups,
  pinboardView,
  toolbarIndex,
  type AirportChip,
} from "@/lib/pinboard";

export interface MapPinboardText {
  /** 整条的名字（`role="toolbar"`）。 */
  label: string;
  list: string;
  noPlan: string;
  noPlanAction: string;
  planFailed: string;
  noPins: string;
  unpin: string;
  auto: string;
  retry: string;
  loading: string;
  chip: Record<AirportChip, string>;
}

defineProps<{
  text: MapPinboardText;
  /** 全部航图列表开着。 */
  listOpen: boolean;
}>();
const emit = defineEmits<{ list: []; height: [number] }>();

const {
  plan,
  groups,
  emptyReason,
  emptyBody,
  openChart,
  load,
  retry,
  toggle,
  open,
} = injectChartPins();

const view = computed(() =>
  pinboardView(
    plan.value.kind,
    pinboardGroups(groups.value, emptyReason.value, emptyBody.value),
  ),
);

const bar = ref<HTMLElement | null>(null);
const listButton = ref<HTMLButtonElement | null>(null);
const menuItem = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

/* ------------------------------------------------------------ 一个 Tab 停点 */

/** 栏里能按的东西，按 DOM 顺序。菜单项不算：它有自己的焦点。 */
function stops(): HTMLElement[] {
  return bar.value
    ? [
        ...bar.value.querySelectorAll<HTMLElement>(
          "button:not([role='menuitem']), a[href]",
        ),
      ]
    : [];
}

/** 上次停在哪一个。重画后它还在就还是它，不在就是打开着的那张，再不然是第一个。 */
let current: HTMLElement | null = null;

function syncStops() {
  const items = stops();
  if (!items.length) return;
  const active =
    (current && items.includes(current) ? current : null) ??
    items.find((el) => el.getAttribute("aria-current") === "true") ??
    items[0];
  for (const el of items) el.tabIndex = el === active ? 0 : -1;
}

function onFocusin(event: FocusEvent) {
  const target = event.target as HTMLElement;
  if (!stops().includes(target)) return;
  current = target;
  syncStops();
}

function onKeydown(event: KeyboardEvent) {
  if (menu.value) return;
  const items = stops();
  const next = toolbarIndex(
    event.key,
    items.indexOf(document.activeElement as HTMLElement),
    items.length,
  );
  if (next === null) return;
  event.preventDefault();
  items[next].focus();
  items[next].scrollIntoView({ block: "nearest", inline: "nearest" });
}

/* ------------------------------------------------------------ 取消钉住 */

interface PinMenu {
  chart: ChartEntry;
  auto: ReadonlySet<number>;
  /** 菜单左边缘，相对栏。 */
  x: number;
  /** 弹出它的标签，Esc 时焦点回去。 */
  tab: HTMLElement;
}

const menu = shallowRef<PinMenu | null>(null);

async function openMenu(
  tab: HTMLElement,
  chart: ChartEntry,
  auto: ReadonlySet<number>,
) {
  const barLeft = bar.value?.getBoundingClientRect().left ?? 0;
  const x = Math.max(0, tab.getBoundingClientRect().left - barLeft);
  menu.value = { chart, auto, x, tab };
  await nextTick();
  menuItem.value?.focus();
}

function closeMenu(returnFocus: boolean) {
  const m = menu.value;
  menu.value = null;
  if (returnFocus) m?.tab.focus();
}

function unpin() {
  const m = menu.value;
  if (!m) return;
  closeMenu(false);
  toggle(m.chart, m.auto);
  // 那个标签没了，焦点落到 body：交给列表按钮。
  void nextTick(() => {
    const active = document.activeElement;
    if (!active || active === document.body) listButton.value?.focus();
  });
}

/* 长按（触屏）。iOS Safari 长按不发 contextmenu，所以自己计时。 */
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 8;
let press: {
  timer: ReturnType<typeof setTimeout>;
  x: number;
  y: number;
} | null = null;
/** 长按弹出菜单后，松手那一下的 click 不算打开。 */
let suppressClick = false;

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function startPress(
  event: PointerEvent,
  chart: ChartEntry,
  auto: ReadonlySet<number>,
) {
  suppressClick = false;
  if (event.pointerType !== "touch") return;
  cancelPress();
  const tab = event.currentTarget as HTMLElement;
  press = {
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      press = null;
      suppressClick = true;
      void openMenu(tab, chart, auto);
    }, LONG_PRESS_MS),
  };
}

function movePress(event: PointerEvent) {
  if (
    press &&
    Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP_PX
  ) {
    cancelPress();
  }
}

function onTabClick(chart: ChartEntry) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  open(chart);
}

function onDocumentPointerdown(event: PointerEvent) {
  if (menu.value && !menuEl.value?.contains(event.target as Node)) {
    closeMenu(false);
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !menu.value) return;
  event.preventDefault();
  closeMenu(true);
}

/* ------------------------------------------------------------ 高度 */

let resizeObserver: ResizeObserver | null = null;

function reportHeight() {
  emit("height", bar.value?.offsetHeight ?? 0);
}

onMounted(() => {
  syncStops();
  document.addEventListener("pointerdown", onDocumentPointerdown);
  document.addEventListener("keydown", onDocumentKeydown);
  if (bar.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(reportHeight);
    resizeObserver.observe(bar.value);
  }
  reportHeight();
});
onUpdated(syncStops);
onBeforeUnmount(() => {
  cancelPress();
  resizeObserver?.disconnect();
  document.removeEventListener("pointerdown", onDocumentPointerdown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div
    ref="bar"
    class="map-pinboard glass"
    role="toolbar"
    :aria-label="text.label"
    @keydown="onKeydown"
    @focusin="onFocusin"
  >
    <button
      ref="listButton"
      type="button"
      class="map-pin-list"
      :class="listOpen ? 'is-on' : ''"
      :aria-expanded="listOpen"
      aria-controls="map-chart-pins"
      :aria-label="text.list"
      :title="text.list"
      @click="emit('list')"
    >
      <Icon name="documentText" class="size-4" />
    </button>

    <p v-if="view.kind === 'loading'" class="map-pin-state">
      <Spinner size="sm" :label="text.loading" />
    </p>
    <p
      v-else-if="view.kind === 'planFailed'"
      class="map-pin-state"
      role="status"
    >
      <span>{{ text.planFailed }}</span>
      <button type="button" class="link" @click="load()">
        {{ text.retry }}
      </button>
    </p>
    <p v-else-if="view.kind === 'noPlan'" class="map-pin-state">
      <span>{{ text.noPlan }}</span>
      <a href="/flightplan" class="link">{{ text.noPlanAction }}</a>
    </p>
    <p v-else-if="view.kind === 'noPins'" class="map-pin-state">
      {{ text.noPins }}
    </p>

    <div v-else class="map-pin-scroll">
      <template v-for="g in view.groups" :key="g.role">
        <!-- 机场分隔，不是按钮。没有标签可画时它就是那颗牌子，完整的话在列表里。 -->
        <span
          class="map-pin-sep"
          :class="g.chip && g.chip !== 'loading' ? 'is-warn' : ''"
          :role="g.chip ? 'status' : undefined"
          :title="g.chip ? `${g.icao} · ${text.chip[g.chip]}` : undefined"
        >
          <Spinner
            v-if="g.chip === 'loading'"
            size="sm"
            :label="text.chip.loading"
          />
          <Icon
            v-else-if="g.chip"
            name="exclamationTriangle"
            class="size-3.5"
          />
          <span class="font-mono">{{ g.icao }}</span>
          <span v-if="g.chip && g.chip !== 'loading'">{{
            text.chip[g.chip]
          }}</span>
        </span>
        <button
          v-if="chipRetries(g.chip)"
          type="button"
          class="link map-pin-retry"
          @click="retry(g)"
        >
          {{ text.retry }}
        </button>
        <button
          v-for="tab in g.tabs"
          :key="tab.chart.id"
          type="button"
          class="map-pin-tab"
          :class="[
            CHART_STRIP_CLASS[tab.colour],
            openChart?.id === tab.chart.id ? 'is-open' : '',
          ]"
          :aria-current="openChart?.id === tab.chart.id ? 'true' : undefined"
          :title="tab.chart.name"
          :data-chart="tab.chart.id"
          @click="onTabClick(tab.chart)"
          @contextmenu.prevent="
            openMenu($event.currentTarget as HTMLElement, tab.chart, g.auto)
          "
          @pointerdown="startPress($event, tab.chart, g.auto)"
          @pointermove="movePress"
          @pointerup="cancelPress"
          @pointercancel="cancelPress"
        >
          <span class="map-pin-name">{{ tab.chart.name }}</span>
          <span v-if="tab.auto" class="map-pin-auto" aria-hidden="true" />
          <span v-if="tab.auto" class="sr-only">{{ text.auto }}</span>
        </button>
      </template>
    </div>

    <div
      v-if="menu"
      ref="menuEl"
      class="map-pin-menu glass"
      role="menu"
      :style="{ left: `${menu.x}px` }"
    >
      <button ref="menuItem" type="button" role="menuitem" @click="unpin">
        {{ text.unpin }}
      </button>
    </div>
  </div>
</template>
