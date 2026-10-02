<script setup lang="ts">
/**
 * 常驻的显示面。
 *
 * 从前的 MapSurface.vue（1,525 行）按它本来就有的几条缝拆开，这个文件只负责把
 * 它们接起来：
 *
 * - `useLayerNotice`  这一层为什么没东西、被拒过没有、哪一层没取到
 * - `useChartLayers`  图层登记处：航路、导航台、情报区、MORA、空域、机场与跑道
 * - `useGroundLayer`  机场地面，没有开关，由缩放决定
 * - `useTrafficLayer` 实时：在线机组、在线管制、自己那架和它的航迹
 * - `useRouteLayer`   航路：面板推来的点、已提交的计划、航路网上点亮的那几段
 * - `useWeatherLayer` 降水瓦片：开关、偏好、刷新、失败
 * - `useChartPins`    本次飞行的钉住航图，这里建一份，provide 给钉板和列表
 * - `MapModeBar.vue`  左上的模式条：机组、管制、天气、钉板
 * - `MapToolbar.vue`  模式条下面一列：IFR 高 / 低空、图层、3D、定位到我
 * - `MapPinboard.vue` 底部的钉板，平板和桌面上、钉板开着时
 * - `ChartPins.vue`   全部航图列表：钉板的列表按钮、手机上的钉板按钮打开
 * - `ChartViewer.vue` 唯一的航图查看器，按 `openChart` 渲染
 *
 * 缩放和指北针在右上，署名下面（RouteMap）。
 *
 * 横向依赖有两条。一条是航路网：登记处开关它，航路层要在它变了之后重算高亮。所以这
 * 份 ref 由这里持有，两边都拿到它，登记处在原来调 `refreshHighlight()` 的地方调
 * `onAirwaysChange`。
 *
 * 另一条是「不使用受限汇编」（`lib/naip.ts`）。它一变，图上每一层 can-db 数据都是
 * 按旧值取的，得一起作废、一起重取 —— 只重取一部分，图上就同时画着两个级别的资
 * 料，看起来完全正常。所以代号 `aip.gen` 和唯一那个 `watch(hideNaip)` 都在这里：
 * 登记处、地面、计划三处各管自己那一半，号只有一个。
 *
 * 外壳排布读 `--shell-mode`：挂载时读一次，之后跟着 panel:layout 的 `mode` 走（面
 * 板跨断点时会报一次）。不写 `matchMedia`。
 *
 * 仍然不能松的那一条：**绝不服务端渲染 MapLibre。** 它在模块顶层就摸 `window`。
 * 所以 RouteMap 用 `defineAsyncComponent` 引，并且用 `mounted` 守住 —— 改成静态
 * import、或者去掉那个 `v-if`，每一个页面都会 500。
 *
 * 代价照旧：MapLibre 那个 chunk 每一页都要加载，这是为「地图是主体」付的钱。
 */
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";
import type { FeatureCollection } from "geojson";
import MapModeBar, {
  type MapModeBarText,
  type ModeToggle,
} from "@/components/map/MapModeBar.vue";
import MapToolbar, {
  type MapToolbarText,
} from "@/components/map/MapToolbar.vue";
import MapPinboard, {
  type MapPinboardText,
} from "@/components/map/MapPinboard.vue";
import ChartPins from "@/components/map/ChartPins.vue";
import ChartViewer from "@/components/ChartViewer.vue";
import AtcDetails, {
  type AtcDetailsText,
} from "@/components/map/AtcDetails.vue";
import PilotDetails, {
  type PilotDetailsText,
} from "@/components/map/PilotDetails.vue";
import { useLayerNotice, type LayerId } from "@/components/map/useLayerNotice";
import {
  useChartLayers,
  type AipGeneration,
  type ChartLayerToggle,
  type LayerToggle,
  type Viewport,
} from "@/components/map/useChartLayers";
import { useGroundLayer } from "@/components/map/useGroundLayer";
import {
  useTrafficLayer,
  type MapSelection,
} from "@/components/map/useTrafficLayer";
import { hasPosition } from "@/lib/datafeed";
import { useRouteLayer } from "@/components/map/useRouteLayer";
import { useWeatherLayer } from "@/components/map/useWeatherLayer";
import {
  CHART_PINS_KEY,
  restoreFocus,
  useChartPins,
} from "@/components/map/useChartPins";
import {
  DEFAULT_PREFS,
  readPrefs,
  writePrefs,
  type LayerPrefs,
} from "@/lib/mapPrefs";
import { hideNaip } from "@/lib/naip";
import { subscribePanelLayout } from "@/lib/mapBus";
import { pinboardReserve, viewerBottom, withPinboard } from "@/lib/pinboard";
import {
  mapPaddingFor,
  parseShellMode,
  type MapPadding,
  type ShellMode,
} from "@/lib/panelLayout";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
  /** 自己的 CAN ID。没登录是 null。见 useTrafficLayer：按 CID 认自己。 */
  cid: string | null;
  /** 航行资料库级别。航图列表和钉板的空状态按它说话。 */
  aipAccess: number;
  /** 航图列表和查看器要的那几本词典（AppLayout 挑好）。 */
  chartMessages: Record<string, unknown>;
  /** 九个图层开关的文案，已翻译。降水的那个名字在 `t.mode.weather`。 */
  layerLabels: Record<Exclude<LayerToggle, "weather">, string>;
  /** 图层相关的几句话，已翻译。`planOnMap` 带 `{from}` / `{to}`，`layerFailed` 带 `{layer}`。 */
  t: {
    denied: string;
    emptyNavaids: string;
    emptyGeneric: string;
    planOnMap: string;
    layersMenu: string;
    layerFailed: string;
    retry: string;
    locate: string;
    /** 「3D」按钮，和倾斜时航线剖面的那句说明。 */
    view3d: string;
    view3dHint: string;
    /** IFR 高空 / 低空两张航图的全名。 */
    chartHigh: string;
    chartLow: string;
    /** 降水图例两端：小雨、大雨。 */
    weatherLight: string;
    weatherHeavy: string;
    /** 模式条：整条的名字、天气、钉板（机组、管制用 layerLabels）。 */
    mode: { label: string; weather: string; pinboard: string };
    /** 工具栏：整列的名字、HIGH / LOW、切换那句（带 `{current}`、`{next}`）。 */
    toolbar: { label: string; high: string; low: string; chartSwitch: string };
    /** 底部钉板。 */
    pinboard: MapPinboardText;
    /** 管制席位详情卡的文案。 */
    atc: AtcDetailsText;
    /** 飞机详情卡的文案。 */
    pilot: PilotDetailsText;
  };
  /** 地图整个起不来时那两句，转交给 RouteMap。 */
  failureText: { init: string; webgl: string };
}>();

/** 见文件顶上。`mounted` 之前一律不渲染 RouteMap。 */
const mounted = ref(false);

const RouteMap = defineAsyncComponent({
  loader: () => import("@/components/map/RouteMap.vue"),
  // chunk 拉不下来时说话。默认行为是安静地什么都不渲染 —— 那和「地图是空的」在
  // 屏幕上长得一模一样。
  onError(error) {
    console.error("[efb] 地图组件加载失败:", error);
  },
});

const prefs: LayerPrefs = { ...DEFAULT_PREFS };
const notice = useLayerNotice(props.t.denied);
/* `shallowRef`：航路网是几万条航段的要素集合，一律整份换掉（高亮不改它，改的是样式，
   见 `useRouteLayer` 的 `refreshHighlight`），深层代理只是白白包一遍。 */
const airways = shallowRef<FeatureCollection | null>(null);
/** 见文件顶上：「不使用受限汇编」每变一次加一，各层取数回来时对号。 */
const aip: AipGeneration = { gen: 0 };
/** 最近一次视野。换级别时地面要按它重取，而地面层自己不记视野。 */
let lastViewport: Viewport | null = null;

const route = useRouteLayer({
  airways,
  text: { label: props.label, planOnMap: props.t.planOnMap },
});
const chart = useChartLayers({
  airways,
  notice,
  prefs,
  aip,
  text: {
    emptyNavaids: props.t.emptyNavaids,
    emptyGeneric: props.t.emptyGeneric,
  },
  onAirwaysChange: route.refreshHighlight,
});
const groundLayer = useGroundLayer({ aip });
const live = useTrafficLayer({
  cid: props.cid,
  prefs,
  notice,
});

const weather = useWeatherLayer({ prefs, notice });
const { showWeather, weatherBucket } = weather;

/* 模板里只有顶层的 ref 会自动解包，所以把要用的拆出来。 */
const { points, markers, focus, label, cruiseFt, highlightedLegs, litLegs } =
  route;

/**
 * 倾斜视角。按钮改它，地图倾斜过门槛时（手势也算）经 `view3d` 事件写回来 —— 地图
 * 的 pitch 是真相，这个 ref 只是它的镜像加一个请求。不存偏好：打开 EFB 默认俯视。
 */
const view3d = ref(false);
const profileShown = computed(
  () => cruiseFt.value != null && points.value.length > 1,
);

/* ------------------------------------------------------------ 外壳排布 */

/** 挂载前是 null：服务端不知道排布，钉板也就不渲染、不取数。 */
const shellMode = ref<ShellMode | null>(null);
const phone = computed(() => shellMode.value === "phone");

function readShellMode(): ShellMode {
  return parseShellMode(
    getComputedStyle(document.documentElement).getPropertyValue("--shell-mode"),
  );
}

/* ------------------------------------------------------------ 钉板与航图列表 */

/** 钉板开关（偏好）。只管平板和桌面；手机上钉板按钮开列表。 */
const pinboardOn = ref(DEFAULT_PREFS.pinboard);
const barVisible = computed(
  () =>
    mounted.value &&
    pinboardOn.value &&
    shellMode.value !== null &&
    shellMode.value !== "phone",
);

/** 全部航图列表。 */
const listOpen = ref(false);
/** 打开列表的那个按钮（钉板的列表按钮，或手机上的钉板按钮）。关掉时焦点回去。 */
let listOpener: HTMLElement | null = null;

/** 本次飞行的钉住航图。钉板露着或列表开着才取数（见 useChartPins.ts）。 */
const pins = useChartPins({
  aipAccess: props.aipAccess,
  active: computed(() => barVisible.value || listOpen.value),
});
provide(CHART_PINS_KEY, pins);
const { openChart } = pins;

function openList() {
  listOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  listOpen.value = true;
}

function closeList() {
  listOpen.value = false;
  const target = listOpener;
  listOpener = null;
  restoreFocus(target);
}

function toggleList() {
  if (listOpen.value) closeList();
  else openList();
}

const { shownFixes, airports, runways, navaids, firs, mora, airspaces } = chart;
const ifrChart = chart.chart;
const { ground, groundAttribution } = groundLayer;
const {
  traffic,
  atc,
  atcAreas,
  atcLabels,
  selected,
  selectedPilot,
  own,
  ownTrack,
  atcCount,
  ownAt,
} = live;

/** 点地图：点中席位或飞机就换成它，点在空处就收起详情卡。 */
function onSelect(next: MapSelection | null) {
  live.selection.value = next;
}

/** 飞机详情卡上的「在地图上居中」。每次造新对象，理由见 `locateTarget`。 */
function locatePilot() {
  const p = selectedPilot.value;
  if (p && hasPosition(p)) {
    focus.value = { kind: "point", lat: p.latitude!, lon: p.longitude! };
  }
}
const noticeLine = notice.notice;
const failedLayer = notice.failure;

/** 实时和降水的失败挂在模式条上，其余的在工具栏的图层菜单里。 */
const modeFailure = computed<"live" | "weather" | null>(() =>
  failedLayer.value === "live" || failedLayer.value === "weather"
    ? failedLayer.value
    : null,
);

const modeState = computed<Record<ModeToggle, boolean>>(() => ({
  traffic: live.showTraffic.value,
  atcLive: live.showAtc.value,
  weather: showWeather.value,
  pinboard: pinboardOn.value,
}));

const staticState = computed<Record<ChartLayerToggle, boolean>>(() => ({
  airways: chart.showAirways.value,
  firs: chart.showFirs.value,
  navaids: chart.showNavaids.value,
  mora: chart.showMora.value,
  ctr: chart.showCtr.value,
  app: chart.showApp.value,
  restricted: chart.showRestricted.value,
}));

const busy = computed(() => ({
  airways: chart.airwayBusy.value,
  other: chart.layerBusy.value,
}));

const ownButton = computed(() =>
  ownAt.value ? { callsign: ownAt.value.callsign } : null,
);

const modeText: MapModeBarText = {
  label: props.t.mode.label,
  traffic: props.layerLabels.traffic,
  atc: props.layerLabels.atcLive,
  weather: props.t.mode.weather,
  pinboard: props.t.mode.pinboard,
  weatherLight: props.t.weatherLight,
  weatherHeavy: props.t.weatherHeavy,
  layerFailed: props.t.layerFailed,
  retry: props.t.retry,
};

const toolbarText: MapToolbarText = {
  label: props.t.toolbar.label,
  layers: props.t.layersMenu,
  layerFailed: props.t.layerFailed,
  retry: props.t.retry,
  view3d: props.t.view3d,
  locate: props.t.locate,
  high: props.t.toolbar.high,
  low: props.t.toolbar.low,
  chartHigh: props.t.chartHigh,
  chartLow: props.t.chartLow,
  chartSwitch: props.t.toolbar.chartSwitch,
};

/**
 * 面板盖住了哪一块。两处用：交给 RouteMap 做 `setPadding`，以及写成 CSS 变量，
 * 让压在地图上的控件（`.map-overlay`、MapLibre 的四个控件角）跟着可见区走。
 */
const padding = ref<MapPadding>({ top: 0, right: 0, bottom: 0, left: 0 });

/**
 * 钉板占掉的高度（`MapPinboard` 经 `height` 报）。三处用：地图内边距的底边再让一
 * 截（框住航路、居中都落在栏上面）；`--map-pinboard-reserve` 给列表和右下角坐标让
 * 位；`--chart-viewer-bottom` 让贴在旁边的查看器停在栏上面。`--map-pad-*` 不含它：
 * 栏自己就贴在 `--map-pad-bottom` 上。
 */
const pinboardHeight = ref(0);
const reserve = computed(() =>
  barVisible.value ? pinboardReserve(pinboardHeight.value) : 0,
);
const mapPadding = computed(() => withPinboard(padding.value, reserve.value));

const padStyle = computed(() => ({
  "--map-pad-top": `${padding.value.top}px`,
  "--map-pad-right": `${padding.value.right}px`,
  "--map-pad-bottom": `${padding.value.bottom}px`,
  "--map-pad-left": `${padding.value.left}px`,
  "--map-pinboard-reserve": `${reserve.value}px`,
}));

/** 查看器 Teleport 到 body 下，读不到 `.map-stage` 上的变量，所以写在根元素上。 */
function applyViewerBottom(bottom: number | null) {
  const root = document.documentElement.style;
  if (bottom === null) root.removeProperty("--chart-viewer-bottom");
  else root.setProperty("--chart-viewer-bottom", `${bottom}px`);
}
watch(() => viewerBottom(padding.value, reserve.value), applyViewerBottom);
/**
 * Astro 换页时整个换掉 <html> 的属性（style 在内），而值没变 watch 不会再跑，所
 * 以换完补写一次。
 */
function reapplyViewerBottom() {
  applyViewerBottom(viewerBottom(padding.value, reserve.value));
}
/* 钉板收起（关掉、换到手机排布）时，开列表的那个按钮跟着没了；之后关列表走
   restoreFocus 的退路。 */
watch(barVisible, (on) => {
  if (!on) listOpener = null;
});
let unsubscribeLayout: (() => void) | null = null;

/** 视野变了：静态层按缩放补数据，地面层按视野补机场。两者互不相干。 */
function onViewport(v: Viewport) {
  lastViewport = v;
  chart.onViewport(v);
  void groundLayer.loadGroundFor(v);
}

function onToggle(id: LayerToggle) {
  switch (id) {
    case "airways":
      void chart.toggleAirways();
      return;
    case "firs":
      void chart.toggleFirs();
      return;
    case "navaids":
      void chart.toggleNavaids();
      return;
    case "mora":
      void chart.toggleMora();
      return;
    case "traffic":
      void live.toggleLive("traffic");
      return;
    case "atcLive":
      void live.toggleLive("atc");
      return;
    case "weather":
      weather.toggleWeather();
      return;
    default:
      void chart.toggleAirspace(id);
  }
}

/** 模式条。钉板在手机上开列表，在平板和桌面上开关底部那条栏（存偏好）。 */
function onMode(id: ModeToggle) {
  if (id !== "pinboard") {
    onToggle(id);
    return;
  }
  if (phone.value) {
    toggleList();
    return;
  }
  pinboardOn.value = !pinboardOn.value;
  prefs.pinboard = pinboardOn.value;
  writePrefs(prefs);
  // 列表是从栏上开的；栏收起来，列表一起收。焦点还在这个按钮上，不用挪。
  if (!pinboardOn.value) {
    listOpen.value = false;
    listOpener = null;
  }
}

function onRetry(id: LayerId) {
  if (id === "live") void live.refreshLive();
  else if (id === "weather") weather.retry();
  else chart.retry(id);
}

/**
 * 「定位到我」。**每次都是一个新对象**：RouteMap 按引用判断焦点变没变（否则实时数
 * 据每 30 秒会把镜头拽回来一次），连点两次要都生效。
 */
function locateOwn() {
  const target = live.locateTarget();
  if (target) focus.value = target;
}

/**
 * 「不使用受限汇编」变了（设置页，或另一个标签页）。先加号，路上那些按旧值取的请
 * 求回来时就不会再进缓存或上图；再让三处各自作废、重取开着的那几层。情报区边界不
 * 来自 can-db，不动。
 */
watch(hideNaip, () => {
  aip.gen++;
  chart.reloadAip();
  groundLayer.reloadAip(lastViewport);
  route.reloadPlan();
});

onMounted(() => {
  mounted.value = true;
  shellMode.value = readShellMode();
  document.addEventListener("astro:after-swap", reapplyViewerBottom);
  unsubscribeLayout = subscribePanelLayout((layout) => {
    shellMode.value = layout.mode;
    padding.value = mapPaddingFor(layout, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  });
  // 按偏好把图层打开 —— 这是「打开就看到航图」的那一步。不 await：地图不该等航路网
  // 下载完才出现。
  const saved = readPrefs();
  Object.assign(prefs, saved);
  pinboardOn.value = saved.pinboard;
  chart.restore(saved);
  live.start(saved);
  weather.restore(saved);
  route.start();
});

onBeforeUnmount(() => {
  // 这块地图是 `transition:persist` 的，一般走不到这里；真走到了而定时器和监听器
  // 还活着，就是一个谁也看不见的泄漏。
  route.stop();
  live.stop();
  unsubscribeLayout?.();
  document.removeEventListener("astro:after-swap", reapplyViewerBottom);
  applyViewerBottom(null);
});
</script>

<template>
  <section class="map-stage" :style="padStyle" :aria-label="label">
    <!-- `points` 为空也照样渲染：空点集只画底图，不会抛。 -->
    <RouteMap
      v-if="mounted"
      :points="points"
      :markers="markers"
      :focus="focus"
      :padding="mapPadding"
      :airways="airways"
      :airway-fixes="shownFixes"
      :airports="airports"
      :runways="runways"
      :highlighted-legs="highlightedLegs"
      :lit-legs="litLegs"
      :ground="ground"
      :extra-attribution="groundAttribution"
      :navaids="navaids"
      :firs="firs"
      :mora="mora"
      :traffic="traffic"
      :atc="atc"
      :atc-areas="atcAreas"
      :atc-labels="atcLabels"
      :own="own"
      :own-track="ownTrack"
      :airspaces="airspaces"
      :cruise-ft="cruiseFt"
      :view3d="view3d"
      :weather="showWeather"
      :weather-bucket="weatherBucket"
      :label="label"
      :failure-text="failureText"
      :firs-label="layerLabels.firs"
      class="h-full"
      @viewport="onViewport"
      @select="onSelect"
      @view3d="view3d = $event"
      @weather-tile="weather.noteTile($event)"
    />
    <!-- 水合之前的占位：没有它，首屏这一整块是空的，等 JS 到了才突然出现地图。 -->
    <div v-else class="surface-grid h-full"></div>

    <div class="map-overlay">
      <!-- 「这一层没有数据」/「你没有航行资料库权限」。模式条下面居中。 -->
      <p
        v-if="noticeLine"
        class="map-notice glass"
        :data-notice="noticeLine.layer"
      >
        {{ noticeLine.text }}
      </p>
      <!-- 剖面是按巡航高度估算的，不是性能计算，也不含程序高度限制。画出来就要说。 -->
      <p v-else-if="view3d && profileShown" class="map-notice glass">
        {{ t.view3dHint }}
      </p>

      <div class="map-chrome">
        <MapModeBar
          :on="modeState"
          :atc-count="atcCount"
          :phone="phone"
          :list-open="listOpen"
          :failure="modeFailure"
          :text="modeText"
          @toggle="onMode"
          @retry="onRetry"
        />
        <MapToolbar
          :labels="layerLabels"
          :on="staticState"
          :chart="ifrChart"
          :busy="busy"
          :failure="failedLayer"
          :view3d="view3d"
          :own="ownButton"
          :phone="phone"
          :text="toolbarText"
          @toggle="onToggle"
          @chart="chart.setChart"
          @retry="onRetry"
          @view3d="view3d = !view3d"
          @locate="locateOwn"
        />
      </div>

      <MapPinboard
        v-if="barVisible"
        :text="t.pinboard"
        :list-open="listOpen"
        @list="toggleList"
        @height="pinboardHeight = $event"
      />

      <AtcDetails
        v-if="selected"
        :station="selected.station"
        :is-atis="selected.isAtis"
        :text="t.atc"
        @close="onSelect(null)"
      />
      <PilotDetails
        v-else-if="selectedPilot"
        :pilot="selectedPilot"
        :text="t.pilot"
        @close="onSelect(null)"
        @locate="locatePilot"
      />
      <ChartPins
        :open="listOpen"
        :messages="chartMessages"
        @close="closeList"
      />
    </div>

    <!-- 唯一的查看器。换一张时是同一个实例换 `chart`（它 watch `chart.id` 重载）。 -->
    <ChartViewer
      v-if="openChart"
      :chart="openChart"
      :messages="chartMessages"
      @close="pins.close()"
    />
  </section>
</template>
