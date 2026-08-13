<script setup lang="ts">
/**
 * 一张航图的阅读器。
 *
 * **这个组件和 RouteMap.vue 一样不能被服务端渲染**，而且理由更硬：pdf.js 在模
 * 块顶层就摸 `window`、`document` 和 `Worker`。它由 `Charts.vue` 用
 * `defineAsyncComponent` 引入，静态 import 它会让 `/charts` 直接 500。代价换来
 * 的是那一兆多的 chunk 只落在真的打开了某张图的人身上。
 *
 * ## 为什么不是一个 <iframe>
 *
 * 塞进 iframe 让浏览器自带的 PDF 阅读器去画，是零依赖的做法，桌面上也确实能
 * 用。但这个站的目标设备是**平板** —— 站里没有顶栏就是为了给横放的平板省竖直
 * 空间 —— 而 Android Chrome 在 iframe 里根本不渲染 PDF，只给一个下载按钮，
 * iOS Safari 多半只画第一页。在一个飞行中要用的东西上，那不是退化，是不能用。
 *
 * 自己画还多拿到三件在座舱里真的要紧的事：**夜间反色**（下降到最后关灯的时候
 * 一张全白的进近图会晃眼）、**旋转**（航路图和机场图的朝向对不上是常态）、以及
 * **按宽度贴合**，因为进近图是竖的、机场图多半是横的。
 *
 * ## 渲染的两条规矩
 *
 * 一、`renderTask` 必须能取消。翻页比一页画完快是正常操作，两个 render 打同一
 * 张 canvas 的话 pdf.js 会抛 "Cannot use the same canvas"，而且画出来的是两页
 * 叠在一起。所以每次开画之前先 cancel 上一次。
 *
 * 二、按 devicePixelRatio 放大 canvas 的像素、再用 CSS 缩回去。不这么做的话，
 * 视网膜屏上一张进近图的跑道号和频率会糊到读不出来 —— 这是这类阅读器最常见的
 * 一个「看起来能用」的 bug。
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import * as pdfjs from "pdfjs-dist";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import Icon from "@/components/ui/Icon.vue";

/**
 * worker 走 Vite 的 `?url`，不走 CDN。
 *
 * pdf.js 的文档里那个 `cdnjs` 的写法在这里是错的两次：这个站的页面有 CSP，而且
 * 一个飞行中要用的东西不该在第三方 CDN 上有依赖 —— 图能取到、阅读器打不开，是
 * 最难查的那种故障。
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const props = defineProps<{
  /** 取图的地址，本站同源反代。 */
  src: string;
  /** 出错时显示什么，由父组件从词典里取好传进来。 */
  labels: {
    loading: string;
    failed: string;
    page: string;
    zoomIn: string;
    zoomOut: string;
    rotate: string;
    invert: string;
    fitWidth: string;
    prev: string;
    next: string;
  };
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
const viewport = ref<HTMLDivElement | null>(null);

/**
 * `shallowRef`，不是 `ref`。
 *
 * PDFDocumentProxy 是一个带 worker 句柄和内部缓存的活对象，让 Vue 深度代理它
 * 会踩到 pdf.js 自己的私有字段上，症状是渲染随机失败而不是报一个错。
 */
const doc = shallowRef<PDFDocumentProxy | null>(null);
let renderTask: RenderTask | null = null;
/**
 * 关掉文档要通过 loading task，不是通过文档本身。
 *
 * pdf.js 6 把 `PDFDocumentProxy.destroy()` 拿掉了 —— 现在能中止网络请求、并且真
 * 的把 worker 收掉的是 `PDFDocumentLoadingTask.destroy()`。留着文档上那个旧写法
 * 只会是一个类型错误；更糟的情况是它还在别的版本上编得过，然后 worker 一个都不
 * 回收。
 */
let loadingTask: PDFDocumentLoadingTask | null = null;

const pages = ref(0);
const page = ref(1);
const scale = ref(1);
const rotation = ref(0);
const inverted = ref(false);
const loading = ref(true);
const error = ref("");

/** 贴合宽度算出来的基准倍率；用户的缩放是乘在它上面的。 */
const fitScale = ref(1);

const effectiveScale = computed(() => fitScale.value * scale.value);

async function load() {
  destroy();
  loading.value = true;
  error.value = "";
  page.value = 1;
  scale.value = 1;
  rotation.value = 0;

  try {
    // `withCredentials`：图是要会话的，而这是一个同源请求，所以只要让 pdf.js
    // 别把 cookie 丢掉就行。少了它每一次取图都是 401。
    loadingTask = pdfjs.getDocument({ url: props.src, withCredentials: true });
    const loaded = await loadingTask.promise;
    doc.value = loaded;
    pages.value = loaded.numPages;
    await render();
  } catch (e) {
    error.value = props.labels.failed;
    loading.value = false;
    // 控制台留一行英文，和全网的规矩一致：界面文案是中文，日志是英文。
    console.error("[charts] failed to open the document", e);
  }
}

async function render() {
  const document_ = doc.value;
  const element = canvas.value;
  if (!document_ || !element) return;

  // 见文件头第一条：上一次没画完就翻页，两个 render 打同一张 canvas 会抛。
  renderTask?.cancel();
  renderTask = null;

  const pdfPage = await document_.getPage(page.value);

  // 先按 1 倍量一次原始尺寸，才知道要缩放多少才贴合容器宽度。
  const natural = pdfPage.getViewport({ scale: 1, rotation: rotation.value });
  const available = viewport.value?.clientWidth ?? natural.width;
  fitScale.value = available / natural.width;

  const view = pdfPage.getViewport({
    scale: effectiveScale.value,
    rotation: rotation.value,
  });

  // 见文件头第二条：canvas 的像素按 DPR 放大，CSS 尺寸维持逻辑像素。上限 2 是
  // 因为 3 倍屏上一张 A4 的 canvas 会到几千万像素，平板上会直接掉帧。
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  element.width = Math.floor(view.width * dpr);
  element.height = Math.floor(view.height * dpr);
  element.style.width = `${Math.floor(view.width)}px`;
  element.style.height = `${Math.floor(view.height)}px`;

  const context = element.getContext("2d");
  if (!context) return;

  renderTask = pdfPage.render({
    canvas: element,
    canvasContext: context,
    viewport: view,
    transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
  });

  try {
    await renderTask.promise;
  } catch (e) {
    // 取消是正常的翻页路径，不是错误。
    if ((e as { name?: string })?.name !== "RenderingCancelledException") {
      error.value = props.labels.failed;
      console.error("[charts] failed to render a page", e);
    }
  } finally {
    loading.value = false;
  }
}

function destroy() {
  renderTask?.cancel();
  renderTask = null;
  // worker 是一条真的线程，不销毁就每开一张图漏一个。翻十几张图之后平板会开始
  // 发烫，而这类泄漏在桌面上几乎看不出来。销毁 loading task 同时会中止还没下完
  // 的那次请求 —— 快速连点几张图的时候，这是唯一会真的取消掉前几次下载的地方。
  void loadingTask?.destroy();
  loadingTask = null;
  doc.value = null;
  pages.value = 0;
}

function go(delta: number) {
  const next = page.value + delta;
  if (next < 1 || next > pages.value) return;
  page.value = next;
  void render();
}

function zoom(factor: number) {
  scale.value = Math.min(6, Math.max(0.25, scale.value * factor));
  void render();
}

function fitWidth() {
  scale.value = 1;
  void render();
}

function rotate() {
  rotation.value = (rotation.value + 90) % 360;
  void render();
}

watch(() => props.src, load, { immediate: true });
onBeforeUnmount(destroy);

/**
 * 容器宽度变了要重画（转屏、拉开侧栏、折叠导航轨）。
 *
 * 监听 resize 而不是 ResizeObserver 会漏掉后两种 —— 窗口没变，容器变了，而轨
 * 折叠正是这个站每天都会发生的事。
 */
let observer: ResizeObserver | null = null;
watch(viewport, (element) => {
  observer?.disconnect();
  observer = null;
  if (!element) return;
  let width = element.clientWidth;
  observer = new ResizeObserver(() => {
    // 只在宽度真的变了的时候重画：ResizeObserver 也会因为高度变化触发，而画完
    // 一页本身就会改变高度 —— 不比一下就是一个渲染死循环。
    if (element.clientWidth === width) return;
    width = element.clientWidth;
    void render();
  });
  observer.observe(element);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div
      class="flex flex-wrap items-center gap-1 border-b border-subtle px-2 py-1.5"
    >
      <button
        type="button"
        class="viewer-btn"
        :disabled="page <= 1"
        :aria-label="labels.prev"
        :title="labels.prev"
        @click="go(-1)"
      >
        <Icon name="chevronLeft" class="size-4" />
      </button>
      <span class="px-1 font-mono text-xs tabular-nums text-muted">
        {{ page }} / {{ pages || "–" }}
      </span>
      <button
        type="button"
        class="viewer-btn"
        :disabled="page >= pages"
        :aria-label="labels.next"
        :title="labels.next"
        @click="go(1)"
      >
        <Icon name="chevronRight" class="size-4" />
      </button>

      <span class="mx-1 h-5 w-px bg-subtle"></span>

      <button
        type="button"
        class="viewer-btn"
        :aria-label="labels.zoomOut"
        :title="labels.zoomOut"
        @click="zoom(1 / 1.25)"
      >
        <Icon name="minus" class="size-4" />
      </button>
      <button
        type="button"
        class="viewer-btn"
        :aria-label="labels.fitWidth"
        :title="labels.fitWidth"
        @click="fitWidth"
      >
        <span class="font-mono text-xs tabular-nums"
          >{{ Math.round(scale * 100) }}%</span
        >
      </button>
      <button
        type="button"
        class="viewer-btn"
        :aria-label="labels.zoomIn"
        :title="labels.zoomIn"
        @click="zoom(1.25)"
      >
        <Icon name="plus" class="size-4" />
      </button>

      <span class="mx-1 h-5 w-px bg-subtle"></span>

      <button
        type="button"
        class="viewer-btn"
        :aria-label="labels.rotate"
        :title="labels.rotate"
        @click="rotate"
      >
        <Icon name="arrowPath" class="size-4" />
      </button>
      <button
        type="button"
        class="viewer-btn"
        :class="inverted ? 'bg-surface-sunken text-ink' : ''"
        :aria-pressed="inverted"
        :aria-label="labels.invert"
        :title="labels.invert"
        @click="inverted = !inverted"
      >
        <Icon name="moon" class="size-4" />
      </button>
    </div>

    <div
      ref="viewport"
      class="min-h-0 flex-1 overflow-auto bg-surface-sunken p-3"
    >
      <p v-if="error" class="py-12 text-center text-sm text-danger">
        {{ error }}
      </p>
      <p v-else-if="loading" class="py-12 text-center text-sm text-muted">
        {{ labels.loading }}
      </p>
      <!--
        canvas 一直挂着，不用 v-if 换掉：render() 拿的是它的引用，把它从 DOM 里
        摘掉再放回来会让正在进行的那次渲染画到一张已经没人看的画布上。
      -->
      <div
        class="flex justify-center"
        :class="loading || error ? 'hidden' : ''"
      >
        <canvas
          ref="canvas"
          class="max-w-full bg-white shadow-sm"
          :class="inverted ? 'chart-inverted' : ''"
        ></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer-btn {
  display: flex;
  height: 1.75rem;
  min-width: 1.75rem;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  padding-inline: 0.375rem;
  color: var(--color-faint);
  transition:
    color 0.15s,
    background-color 0.15s;
}
.viewer-btn:hover:not(:disabled) {
  background-color: var(--surface-sunken);
  color: var(--color-ink);
}
.viewer-btn:disabled {
  opacity: 0.35;
}

/*
 * 夜间反色。
 *
 * `hue-rotate(180deg)` 是配着 invert 用的：单独 invert 会把图上那些用颜色表意
 * 的东西（限制区的红、地形的褐）翻成对比色，转一圈色相能把它们大致转回去。这
 * 是所有 EFB 都在用的那一招，不完美，但比一张纯反色的图可读得多。
 */
.chart-inverted {
  filter: invert(1) hue-rotate(180deg);
}
</style>
