<script setup lang="ts">
/**
 * 一张航图的 PDF。pdf.js 第一次打开时才加载（lib/pdfjs.ts）。
 *
 * 平板和桌面上贴在面板右边，盖住地图；手机上盖满全屏。位置由 `viewerPlacement`
 * 按面板此刻的矩形算（mapBus 的 panel:layout）。盖满时是对话框，贴在旁边时只是
 * 一块区域 —— 面板还能继续选别的航图。贴在旁边时底边是 `--chart-viewer-bottom`
 * （MapStage 在底部钉板露着时写在根元素上），没有就是 `--shell-inset`。
 *
 * `chart` 换了就重载（`watch(() => props.chart.id)`）：地图上只有一个查看器，钉板
 * 上点另一张是换 `chart`，不是重开。
 *
 * 缩放：ctrl+滚轮（触控板捏合，浏览器报成带 ctrlKey 的 wheel）、两指捏合、按钮、
 * 键盘 + / - / 0。普通滚轮滚动，拖动平移。缩放先改画布的 CSS 尺寸（立刻有反馈），停 150 ms 再按新倍率重画（变清晰）。
 * 夜间模式是把画布反色再转 180° 色相，颜色编码的色相不变。
 */
import {
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import StateCard from "@/components/ui/StateCard.vue";
import { createTranslator } from "@/lib/i18n";
import { dbFetch } from "@/lib/naip";
import { subscribePanelLayout } from "@/lib/mapBus";
import type { PanelLayout } from "@/lib/panelLayout";
import {
  loadPdfJs,
  type PdfDocument,
  type PdfPage,
  type PdfRenderTask,
} from "@/lib/pdfjs";
import {
  anchoredScroll,
  chartFilePath,
  clampPage,
  errorCodeOf,
  fileFailure,
  nextRotation,
  pinchZoom,
  renderScale,
  stepZoom,
  viewerPlacement,
  viewerShortcut,
  wheelZoom,
  wrapFocusIndex,
  type ChartEntry,
  type FileFailure,
  type Rotation,
  type ViewerPlacement,
} from "@/lib/charts";

const props = defineProps<{
  chart: ChartEntry;
  messages: Record<string, unknown>;
}>();
const emit = defineEmits<{ close: [] }>();
const t = createTranslator(props.messages);

type ViewerState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: FileFailure };

const NIGHT_KEY = "efb.chartNight";

function readNight(): boolean {
  try {
    return localStorage.getItem(NIGHT_KEY) === "1";
  } catch {
    return false;
  }
}

const state = ref<ViewerState>({ kind: "loading" });
const doc = shallowRef<PdfDocument | null>(null);
const pageCount = ref(0);
const page = ref(1);
const zoom = ref(1);
const rotation = ref<Rotation>(0);
const night = ref(readNight());
const cssSize = ref({ width: 0, height: 0 });
const placement = ref<ViewerPlacement>({ mode: "overlay" });

const root = ref<HTMLDivElement | null>(null);
const scroller = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

let currentPage: PdfPage | null = null;
let renderTask: PdfRenderTask | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let baseScale = 1;
let loadSeq = 0;
let lastLayout: PanelLayout | null = null;
let unsubscribeLayout: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let opener: HTMLElement | null = null;

watch(night, (on) => {
  try {
    localStorage.setItem(NIGHT_KEY, on ? "1" : "0");
  } catch {
    // 存不下也不中断，本次照样生效。
  }
});

/* ------------------------------------------------------------ 位置 */

function place() {
  placement.value = viewerPlacement(lastLayout, window.innerWidth);
}

/* ------------------------------------------------------------ 载入 */

async function closeDocument() {
  renderTask?.cancel();
  renderTask = null;
  currentPage = null;
  const old = doc.value;
  doc.value = null;
  // 释放画布的后备存储（iOS Safari 对画布总量有上限），也不让上一张图留在加载提示后面。
  if (canvas.value) {
    canvas.value.width = 0;
    canvas.value.height = 0;
  }
  cssSize.value = { width: 0, height: 0 };
  if (old) await old.loadingTask.destroy().catch(() => undefined);
}

async function open() {
  const seq = ++loadSeq;
  state.value = { kind: "loading" };
  await closeDocument();

  let response: Response;
  try {
    response = await dbFetch(chartFilePath(props.chart.id));
  } catch {
    if (seq === loadSeq) state.value = { kind: "error" };
    return;
  }
  if (!response.ok) {
    const code = errorCodeOf(await response.json().catch(() => null));
    if (seq === loadSeq) {
      state.value = { kind: fileFailure(response.status, code) };
    }
    return;
  }

  try {
    const [pdfjs, bytes] = await Promise.all([
      loadPdfJs(),
      response.arrayBuffer(),
    ]);
    // 失败时也要销毁加载任务：每个任务带一个专用 worker，只有 destroy() 才会收掉。
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    let loaded: PdfDocument;
    try {
      loaded = await task.promise;
    } catch (error) {
      void task.destroy();
      throw error;
    }
    if (seq !== loadSeq) {
      void loaded.loadingTask.destroy();
      return;
    }
    doc.value = loaded;
    pageCount.value = loaded.numPages;
    page.value = 1;
    zoom.value = 1;
    rotation.value = 0;
    state.value = { kind: "ready" };
    await nextTick();
    await showPage();
  } catch (error) {
    console.error(`chart ${props.chart.id}: cannot open`, error);
    if (seq === loadSeq) state.value = { kind: "error" };
  }
}

/* ------------------------------------------------------------ 渲染 */

function viewportAt(scale: number) {
  const p = currentPage!;
  return p.getViewport({ scale, rotation: (p.rotate + rotation.value) % 360 });
}

function applyCssSize() {
  if (!currentPage) return;
  const unit = viewportAt(1);
  cssSize.value = {
    width: unit.width * baseScale * zoom.value,
    height: unit.height * baseScale * zoom.value,
  };
}

/** 倍率 1 = 整页放进滚动区。 */
function measureBase() {
  const box = scroller.value;
  if (!currentPage || !box) return;
  const unit = viewportAt(1);
  baseScale = Math.max(
    0.01,
    Math.min(box.clientWidth / unit.width, box.clientHeight / unit.height),
  );
  applyCssSize();
}

async function render() {
  const c = canvas.value;
  if (!currentPage || !c) return;
  renderTask?.cancel();
  const unit = viewportAt(1);
  const scale = renderScale(
    baseScale * zoom.value,
    window.devicePixelRatio || 1,
    unit.width,
    unit.height,
  );
  const viewport = viewportAt(scale);
  c.width = Math.floor(viewport.width);
  c.height = Math.floor(viewport.height);
  const task = currentPage.render({ canvas: c, viewport });
  renderTask = task;
  try {
    await task.promise;
  } catch (error) {
    if ((error as Error)?.name !== "RenderingCancelledException") {
      console.error(`chart ${props.chart.id}: render failed`, error);
    }
  } finally {
    if (renderTask === task) renderTask = null;
  }
}

function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    void render();
  }, 150);
}

async function showPage() {
  const d = doc.value;
  if (!d) return;
  page.value = clampPage(page.value, d.numPages);
  currentPage = await d.getPage(page.value);
  measureBase();
  await render();
}

/* ------------------------------------------------------------ 操作 */

function setZoom(next: number, anchor?: { x: number; y: number }) {
  const box = scroller.value;
  if (!box || !currentPage) return;
  const ratio = next / zoom.value;
  if (ratio === 1) return;
  const ax = anchor?.x ?? box.clientWidth / 2;
  const ay = anchor?.y ?? box.clientHeight / 2;
  const left = box.scrollLeft;
  const top = box.scrollTop;
  zoom.value = next;
  applyCssSize();
  void nextTick(() => {
    box.scrollLeft = anchoredScroll(left, ax, ratio);
    box.scrollTop = anchoredScroll(top, ay, ratio);
  });
  scheduleRender();
}

function fit() {
  zoom.value = 1;
  applyCssSize();
  scroller.value?.scrollTo({ left: 0, top: 0 });
  void render();
}

function rotate() {
  rotation.value = nextRotation(rotation.value);
  zoom.value = 1;
  measureBase();
  void render();
}

function goPage(delta: 1 | -1) {
  const next = clampPage(page.value + delta, pageCount.value);
  if (next === page.value) return;
  page.value = next;
  zoom.value = 1;
  void showPage();
}

/**
 * 只有 ctrl+滚轮（触控板捏合，浏览器报成带 ctrlKey 的 wheel）缩放；普通滚轮
 * 留给浏览器，在放大后的航图上滚动。
 */
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  const box = scroller.value;
  if (!box) return;
  const rect = box.getBoundingClientRect();
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  setZoom(wheelZoom(zoom.value, delta), {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  });
}

/* 拖动平移、两指捏合。滚动区 `touch-action: none`，手势全在这里。 */
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { distance: number; zoom: number } | null = null;
let pan: { x: number; y: number; left: number; top: number } | null = null;

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

function startGesture() {
  const box = scroller.value;
  const pts = [...pointers.values()];
  pinch = null;
  pan = null;
  if (!box) return;
  if (pts.length >= 2) {
    pinch = { distance: distance(pts[0], pts[1]), zoom: zoom.value };
  } else if (pts.length === 1) {
    pan = { ...pts[0], left: box.scrollLeft, top: box.scrollTop };
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  scroller.value?.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  startGesture();
}

function onPointerMove(event: PointerEvent) {
  const box = scroller.value;
  if (!box || !pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const pts = [...pointers.values()];
  if (pinch && pts.length >= 2) {
    const rect = box.getBoundingClientRect();
    setZoom(pinchZoom(pinch.zoom, pinch.distance, distance(pts[0], pts[1])), {
      x: (pts[0].x + pts[1].x) / 2 - rect.left,
      y: (pts[0].y + pts[1].y) / 2 - rect.top,
    });
  } else if (pan) {
    box.scrollLeft = pan.left - (event.clientX - pan.x);
    box.scrollTop = pan.top - (event.clientY - pan.y);
  }
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId);
  startGesture();
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  return root.value
    ? [...root.value.querySelectorAll<HTMLElement>(FOCUSABLE)]
    : [];
}

/** 盖满时是模态：Tab 在里面循环。 */
function trapTab(event: KeyboardEvent) {
  if (placement.value.mode !== "overlay") return;
  const items = focusables();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = wrapFocusIndex(index, items.length, event.shiftKey);
  if (next === null) return;
  event.preventDefault();
  items[next].focus();
}

/** 盖满时焦点跑到了外面（点了背后的东西、脚本抢焦点）：拉回来。 */
function keepFocusInside(event: FocusEvent) {
  if (placement.value.mode !== "overlay") return;
  const target = event.target as Node | null;
  if (target && root.value && !root.value.contains(target)) {
    root.value.focus();
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === "Tab") {
    trapTab(event);
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  } else {
    const action = viewerShortcut(event.key, event);
    if (action === "zoomIn") setZoom(stepZoom(zoom.value, 1));
    else if (action === "zoomOut") setZoom(stepZoom(zoom.value, -1));
    else if (action === "fit") fit();
  }
}

/* ------------------------------------------------------------ 生命周期 */

watch(
  () => props.chart.id,
  () => void open(),
);

onMounted(() => {
  unsubscribeLayout = subscribePanelLayout((layout) => {
    lastLayout = layout;
    place();
  });
  window.addEventListener("resize", place);
  place();
  if (scroller.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      measureBase();
      scheduleRender();
    });
    resizeObserver.observe(scroller.value);
  }
  opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  document.addEventListener("focusin", keepFocusInside);
  root.value?.focus();
  void open();
});

onBeforeUnmount(() => {
  loadSeq += 1;
  unsubscribeLayout?.();
  window.removeEventListener("resize", place);
  document.removeEventListener("focusin", keepFocusInside);
  // 焦点回到打开它的那个控件（它还在文档里的话）。
  if (opener?.isConnected) opener.focus();
  opener = null;
  resizeObserver?.disconnect();
  if (renderTimer) clearTimeout(renderTimer);
  void closeDocument();
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="chart-viewer"
      :class="
        placement.mode === 'overlay'
          ? 'chart-viewer-overlay'
          : 'chart-viewer-beside glass'
      "
      :style="
        placement.mode === 'beside'
          ? { left: `${placement.left}px` }
          : undefined
      "
      :role="placement.mode === 'overlay' ? 'dialog' : 'region'"
      :aria-modal="placement.mode === 'overlay' ? 'true' : undefined"
      :aria-label="chart.name"
      tabindex="-1"
      @keydown="onKey"
    >
      <header class="chart-viewer-bar">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-ink">
            {{ chart.name }}
          </p>
          <p class="font-mono text-xs text-muted">
            {{ chart.category
            }}<template v-if="chart.page"> · {{ chart.page }}</template>
          </p>
        </div>
        <button
          type="button"
          class="btn btn-ghost chart-viewer-icon"
          :aria-label="t('airports.charts.viewer.close')"
          :title="t('airports.charts.viewer.close')"
          @click="emit('close')"
        >
          <Icon name="xMark" class="size-5" />
        </button>
      </header>

      <div
        role="toolbar"
        :aria-label="t('airports.charts.viewer.toolbar')"
        class="chart-viewer-tools"
      >
        <button
          type="button"
          class="btn btn-ghost chart-viewer-icon"
          :disabled="state.kind !== 'ready'"
          :aria-label="t('airports.charts.viewer.zoomOut')"
          :title="t('airports.charts.viewer.zoomOut')"
          @click="setZoom(stepZoom(zoom, -1))"
        >
          <Icon name="minus" class="size-4" />
        </button>
        <span class="w-12 text-center font-mono text-xs text-muted">
          {{ Math.round(zoom * 100) }}%
        </span>
        <button
          type="button"
          class="btn btn-ghost chart-viewer-icon"
          :disabled="state.kind !== 'ready'"
          :aria-label="t('airports.charts.viewer.zoomIn')"
          :title="t('airports.charts.viewer.zoomIn')"
          @click="setZoom(stepZoom(zoom, 1))"
        >
          <Icon name="plus" class="size-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost chart-viewer-icon"
          :disabled="state.kind !== 'ready'"
          :aria-label="t('airports.charts.viewer.fit')"
          :title="t('airports.charts.viewer.fit')"
          @click="fit"
        >
          <Icon name="viewfinderCircle" class="size-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost chart-viewer-icon"
          :disabled="state.kind !== 'ready'"
          :aria-label="t('airports.charts.viewer.rotate')"
          :title="t('airports.charts.viewer.rotate')"
          @click="rotate"
        >
          <Icon name="arrowPath" class="size-4" />
        </button>
        <button
          type="button"
          class="btn btn-ghost chart-viewer-icon"
          :aria-pressed="night"
          :aria-label="t('airports.charts.viewer.night')"
          :title="t('airports.charts.viewer.night')"
          @click="night = !night"
        >
          <Icon :name="night ? 'sun' : 'moon'" class="size-4" />
        </button>

        <template v-if="pageCount > 1">
          <span class="flex-1" aria-hidden="true" />
          <button
            type="button"
            class="btn btn-ghost chart-viewer-icon"
            :disabled="page <= 1"
            :aria-label="t('airports.charts.viewer.prevPage')"
            :title="t('airports.charts.viewer.prevPage')"
            @click="goPage(-1)"
          >
            <Icon name="chevronLeft" class="size-4" />
          </button>
          <span class="font-mono text-xs text-muted" aria-live="polite">
            {{
              t("airports.charts.viewer.page", {
                page: String(page),
                total: String(pageCount),
              })
            }}
          </span>
          <button
            type="button"
            class="btn btn-ghost chart-viewer-icon"
            :disabled="page >= pageCount"
            :aria-label="t('airports.charts.viewer.nextPage')"
            :title="t('airports.charts.viewer.nextPage')"
            @click="goPage(1)"
          >
            <Icon name="chevronRight" class="size-4" />
          </button>
        </template>
      </div>

      <div class="relative min-h-0 flex-1">
        <div
          ref="scroller"
          class="chart-viewer-scroller"
          :data-night="night ? 'true' : 'false'"
          @wheel="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <canvas
            ref="canvas"
            class="chart-viewer-canvas"
            :style="{
              width: `${cssSize.width}px`,
              height: `${cssSize.height}px`,
            }"
          />
        </div>

        <div
          v-if="state.kind !== 'ready'"
          class="absolute inset-0 grid place-items-center p-4"
        >
          <StateCard
            v-if="state.kind === 'loading'"
            kind="loading"
            :title="t('airports.charts.viewer.loading')"
          />
          <StateCard
            v-else-if="state.kind === 'forbidden'"
            kind="forbidden"
            :title="t('airports.denied.title')"
            :body="t('airports.denied.body')"
          />
          <StateCard
            v-else-if="state.kind === 'notFound'"
            kind="empty"
            :title="t('airports.charts.viewer.notFound')"
          />
          <StateCard
            v-else-if="state.kind === 'unconfigured'"
            kind="error"
            :title="t('airports.charts.unconfigured.title')"
            :body="t('airports.charts.unconfigured.body')"
            :retry-label="t('common.retry')"
            @retry="open"
          />
          <StateCard
            v-else
            kind="error"
            :title="t('airports.charts.viewer.failed')"
            :retry-label="t('common.retry')"
            @retry="open"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>
