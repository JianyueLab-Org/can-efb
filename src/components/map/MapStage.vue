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
 * - `MapControls.vue` 图层菜单、提示、重试、「定位到我」
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
  ref,
  shallowRef,
  watch,
} from "vue";
import type { FeatureCollection } from "geojson";
import MapControls from "@/components/map/MapControls.vue";
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
import { DEFAULT_PREFS, readPrefs, type LayerPrefs } from "@/lib/mapPrefs";
import { hideNaip } from "@/lib/naip";
import { subscribePanelLayout } from "@/lib/mapBus";
import { mapPaddingFor, type MapPadding } from "@/lib/panelLayout";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
  /** 自己的 CAN ID。没登录是 null。见 useTrafficLayer：按 CID 认自己。 */
  cid: string | null;
  /** 九个图层开关的文案，已翻译。 */
  layerLabels: Record<LayerToggle, string>;
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

/* 模板里只有顶层的 ref 会自动解包，所以把要用的拆出来。 */
const { points, markers, focus, label, highlightedLegs, litLegs } = route;
const { shownFixes, airports, runways, navaids, firs, mora, airspaces } = chart;
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

const layerState = computed<Record<LayerToggle, boolean>>(() => ({
  airways: chart.showAirways.value,
  firs: chart.showFirs.value,
  navaids: chart.showNavaids.value,
  mora: chart.showMora.value,
  traffic: live.showTraffic.value,
  atcLive: live.showAtc.value,
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

/**
 * 面板盖住了哪一块。两处用：交给 RouteMap 做 `setPadding`，以及写成 CSS 变量，
 * 让压在地图上的控件（`.map-overlay`、MapLibre 的四个控件角）跟着可见区走。
 */
const padding = ref<MapPadding>({ top: 0, right: 0, bottom: 0, left: 0 });
const padStyle = computed(() => ({
  "--map-pad-top": `${padding.value.top}px`,
  "--map-pad-right": `${padding.value.right}px`,
  "--map-pad-bottom": `${padding.value.bottom}px`,
  "--map-pad-left": `${padding.value.left}px`,
}));
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
    default:
      void chart.toggleAirspace(id);
  }
}

function onRetry(id: LayerId) {
  if (id === "live") void live.refreshLive();
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
  unsubscribeLayout = subscribePanelLayout((layout) => {
    padding.value = mapPaddingFor(layout, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  });
  // 按偏好把图层打开 —— 这是「打开就看到航图」的那一步。不 await：地图不该等航路网
  // 下载完才出现。
  const saved = readPrefs();
  Object.assign(prefs, saved);
  chart.restore(saved);
  live.start(saved);
  route.start();
});

onBeforeUnmount(() => {
  // 这块地图是 `transition:persist` 的，一般走不到这里；真走到了而定时器和监听器
  // 还活着，就是一个谁也看不见的泄漏。
  route.stop();
  live.stop();
  unsubscribeLayout?.();
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
      :padding="padding"
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
      :label="label"
      :failure-text="failureText"
      :firs-label="layerLabels.firs"
      class="h-full"
      @viewport="onViewport"
      @select="onSelect"
    />
    <!-- 水合之前的占位：没有它，首屏这一整块是空的，等 JS 到了才突然出现地图。 -->
    <div v-else class="surface-grid h-full"></div>

    <MapControls
      :labels="layerLabels"
      :text="{
        menu: t.layersMenu,
        retry: t.retry,
        locate: t.locate,
        layerFailed: t.layerFailed,
      }"
      :on="layerState"
      :busy="busy"
      :atc-count="atcCount"
      :notice="noticeLine"
      :failure="failedLayer"
      :own="ownButton"
      @toggle="onToggle"
      @retry="onRetry"
      @locate="locateOwn"
    />

    <div class="map-overlay">
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
    </div>
  </section>
</template>
