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
import {
  fetchAirways,
  toAirwayLines,
  toAirwayFixes,
  distinctLocTypes,
  type AirwayLevel,
} from "@/lib/airways";
import {
  fetchNavaids,
  toNavaidPoints,
  fetchAirspaces,
  toAirspacePolygons,
  type AirspaceFamily,
} from "@/lib/aip";
import type { FeatureCollection } from "geojson";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
  /** 没东西可画时那条提示的标题，已翻译。 */
  emptyTitle: string;
  /** 没东西可画时那条提示的正文，已翻译。 */
  emptyBody: string;
  /** 航路图层开关的三个文案（关 / 高空 / 低空），已翻译。 */
  airwayLabels: { off: string; high: string; low: string };
  /** 其余图层开关的文案（情报区 / 导航台 / 扇区 / 限制区），已翻译。 */
  layerLabels: {
    firs: string;
    navaids: string;
    sectors: string;
    restricted: string;
  };
}>();

/** 见文件顶上最后一段。`mounted` 之前一律不渲染 RouteMap。 */
const mounted = ref(false);

const RouteMap = defineAsyncComponent({
  loader: () => import("@/components/RouteMap.vue"),
  // chunk 拉不下来时说话。默认行为是安静地什么都不渲染 —— 那和「地图是空的」在
  // 屏幕上长得一模一样。
  onError(error) {
    console.error("[efb] 地图组件加载失败:", error);
  },
});

/** 见 setAirwayLevel 上面的注释：跨组件重建保留。 */
const airwayCache = new Map<
  AirwayLevel,
  { lines: FeatureCollection; fixes: FeatureCollection }
>();

/**
 * 图层偏好存 localStorage。
 *
 * 这块地图跨页面存活，但**刷新一次就回到默认**——而"我要看哪几层"是一个跨会话
 * 的选择，不是一次浏览的状态。和轨的折叠状态存 `data-rail` 是同一个道理。
 *
 * 读写都包在 try 里：锁死的浏览器里 localStorage 会抛，而一个图层偏好不值得让
 * 整块地图挂掉。
 */
const PREF_KEY = "efb.map.layers";

interface LayerPrefs {
  airway: AirwayLevel | "off";
  firs: boolean;
  navaids: boolean;
  airspace: AirspaceFamily | "off";
}

/**
 * **默认是打开的。** 这个站的地图是一张航图，不是一块等着被点亮的空底图 ——
 * 打开就该看到航路、航路点和导航台。扇区默认关着：它是一大片填充，和航路叠在
 * 一起会把线糊掉，要看的人自己开。
 */
const DEFAULT_PREFS: LayerPrefs = {
  airway: "high",
  firs: true,
  navaids: true,
  airspace: "off",
};

function readPrefs(): LayerPrefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<LayerPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function writePrefs(prefs: LayerPrefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下就算了，下次回到默认 —— 不值得为此打扰用户。
  }
}

/**
 * 一旦 can-db 拒绝过，这次会话里就不再尝试。
 *
 * 没有 `aipAccess` 的成员每一层都会 401。默认打开之后，如果不记住这件事，他们
 * 每进一个页面就会撞三次 401 并在控制台刷三行错 —— 那既吵，又会让真正的故障淹
 * 在噪音里。**记的是"被拒过"，不是"失败过"**：网络抖动应该重试，权限不足不该。
 */
let deniedThisSession = false;

function isDenied(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

let navaidCache: FeatureCollection | null = null;
const airspaceCache = new Map<AirspaceFamily, FeatureCollection>();

const points = ref<MapPoint[]>([]);
const markers = ref<MapPoint[]>([]);
const focus = ref<MapPoint | null>(null);
const label = ref(props.label);

/** 有任何一种可画的东西，就不该再显示那条「还没有东西」的提示。 */
const hasPoints = computed(
  () => points.value.length > 0 || markers.value.length > 0,
);

/**
 * 航路图层：关 / 高空 / 低空。
 *
 * **按需拉，而且拉过的留着。** 整张全国航路网是几百 KB，默认关着 —— 大多数时候
 * 人是来看自己那条航路的，不是来看全国的网。切回已经拉过的那一层不该再打一次
 * 接口，所以按 level 缓存。
 *
 * 缓存放在组件外的模块作用域：这块地图跨页面存活，但保活失败时组件会重建，那时
 * 缓存还在就不必重拉。
 */
const airwayLevel = ref<AirwayLevel | "off">("off");
const prefs = { ...DEFAULT_PREFS };
const airways = ref<FeatureCollection | null>(null);
const airwayFixes = ref<FeatureCollection | null>(null);
const airwayBusy = ref(false);

async function setAirwayLevel(level: AirwayLevel | "off") {
  airwayLevel.value = level;
  prefs.airway = level;
  writePrefs(prefs);
  if (level === "off") {
    airways.value = null;
    airwayFixes.value = null;
    return;
  }

  const cached = airwayCache.get(level);
  if (cached) {
    airways.value = cached.lines;
    airwayFixes.value = cached.fixes;
    return;
  }

  if (deniedThisSession) return;
  airwayBusy.value = true;
  try {
    const graph = await fetchAirways(level);
    // 分色规则要按真实取值定，而写这一版时没人看过这个库里到底有哪几种类型 ——
    // 先把它们打出来。见 lib/airways.ts 里 distinctLocTypes 的注释。
    console.log("[efb:map] airway locTypes", distinctLocTypes(graph));
    const lines = toAirwayLines(graph);
    // 航路点和线一起来一起走：它们是同一份图的两个面，分开缓存迟早不同步。
    const fixes = toAirwayFixes(graph);
    airwayCache.set(level, { lines, fixes });
    airways.value = lines;
    airwayFixes.value = fixes;
  } catch (error) {
    // 这一层是用户明确打开的，不是装饰性底图 —— 失败要说话，而且要退回"关"，
    // 否则开关停在"高空"上却什么都没画，看起来像这一带没有航路。
    if (isDenied(error)) deniedThisSession = true;
    console.error("[efb:map] 航路网加载失败:", error);
    airwayLevel.value = "off";
    airways.value = null;
    airwayFixes.value = null;
  } finally {
    airwayBusy.value = false;
  }
}

/**
 * 其余三个图层：导航台、扇区、限制区。各自独立开关。
 *
 * 独立而不是做成一个「显示全部」：这几层的用途不一样 —— 看扇区归属和看限制区是
 * 两件事，一次全打开只会把图糊掉。
 *
 * 和航路一样按需拉、拉过留着。
 */
const showNavaids = ref(false);
const navaids = ref<FeatureCollection | null>(null);

/**
 * 情报区边界。**独立开关，默认开** —— 它是航图的底子，不是叠加物。
 *
 * 单独一个 ref 而不是并进 airspaceFamily 那个单选，理由见 RouteMap 里 firs
 * 这个 prop 的注释：并进去就意味着打开限制区会让边界消失。
 */
const showFirs = ref(false);
const firs = ref<FeatureCollection | null>(null);
let firCache: FeatureCollection | null = null;

const airspaceFamily = ref<AirspaceFamily | "off">("off");
const airspaces = ref<FeatureCollection | null>(null);

const layerBusy = ref(false);

async function toggleNavaids() {
  prefs.navaids = !showNavaids.value;
  writePrefs(prefs);
  if (showNavaids.value) {
    showNavaids.value = false;
    navaids.value = null;
    return;
  }
  if (navaidCache) {
    navaids.value = navaidCache;
    showNavaids.value = true;
    return;
  }
  if (deniedThisSession) return;
  layerBusy.value = true;
  try {
    navaidCache = toNavaidPoints(await fetchNavaids());
    navaids.value = navaidCache;
    showNavaids.value = true;
  } catch (error) {
    // 和航路那层同一条规矩：用户明确打开的图层，失败要说话并退回关，否则开关亮
    // 着却什么都没画，看起来像这一带没有导航台。
    if (isDenied(error)) deniedThisSession = true;
    console.error("[efb:map] 导航台加载失败:", error);
    showNavaids.value = false;
  } finally {
    layerBusy.value = false;
  }
}

async function toggleFirs() {
  prefs.firs = !showFirs.value;
  writePrefs(prefs);

  if (showFirs.value) {
    showFirs.value = false;
    firs.value = null;
    return;
  }
  if (firCache) {
    firs.value = firCache;
    showFirs.value = true;
    return;
  }
  if (deniedThisSession) return;

  layerBusy.value = true;
  try {
    firCache = toAirspacePolygons(await fetchAirspaces("fir"));
    firs.value = firCache;
    showFirs.value = true;
  } catch (error) {
    if (isDenied(error)) deniedThisSession = true;
    console.error("[efb:map] 情报区加载失败:", error);
    showFirs.value = false;
    firs.value = null;
  } finally {
    layerBusy.value = false;
  }
}

async function setAirspaceFamily(family: AirspaceFamily | "off") {
  prefs.airspace = airspaceFamily.value === family ? "off" : family;
  writePrefs(prefs);
  if (family === "off" || airspaceFamily.value === family) {
    airspaceFamily.value = "off";
    airspaces.value = null;
    return;
  }
  const cached = airspaceCache.get(family);
  if (cached) {
    airspaces.value = cached;
    airspaceFamily.value = family;
    return;
  }
  if (deniedThisSession) return;
  layerBusy.value = true;
  try {
    const polygons = toAirspacePolygons(await fetchAirspaces(family));
    airspaceCache.set(family, polygons);
    airspaces.value = polygons;
    airspaceFamily.value = family;
  } catch (error) {
    if (isDenied(error)) deniedThisSession = true;
    console.error("[efb:map] 空域加载失败:", error);
    airspaceFamily.value = "off";
    airspaces.value = null;
  } finally {
    layerBusy.value = false;
  }
}

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  // 见 RouteMap.vue 顶上：这一批 `[efb:map]` 是排查「一片蓝」用的临时脚手架。
  // 这一行证明外壳这个岛屿水合了 —— 它是 RouteMap 能不能被渲染的前提。
  console.log("[efb:map] MapSurface mounted");
  mounted.value = true;

  // 按偏好把图层打开。**这是"打开就看到航图"的那一步** —— 没有它，默认值只是
  // 一个没人读的常量。
  //
  // 不 await：地图不该等航路网下载完才出现，底图和航路是两条独立的线。
  const saved = readPrefs();
  Object.assign(prefs, saved);
  if (saved.airway !== "off") void setAirwayLevel(saved.airway);
  if (saved.firs) void toggleFirs();
  if (saved.navaids) void toggleNavaids();
  if (saved.airspace !== "off") void setAirspaceFamily(saved.airspace);
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
      :airways="airways"
      :airway-fixes="airwayFixes"
      :navaids="navaids"
      :firs="firs"
      :airspaces="airspaces"
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
    <!--
      航路图层开关。放在地图上而不是面板里：地图是跨页面常驻的，而面板每换一页就
      整个换掉 —— 开关跟着面板走的话，切一页图层状态就没人管了。
    -->
    <div class="map-layers card">
      <button
        v-for="opt in ['off', 'high', 'low'] as const"
        :key="opt"
        type="button"
        class="map-layer-btn"
        :class="airwayLevel === opt ? 'is-on' : ''"
        :disabled="airwayBusy"
        @click="setAirwayLevel(opt)"
      >
        {{ airwayLabels[opt] }}
      </button>
    </div>

    <div class="map-layers map-layers-2 card">
      <button
        type="button"
        class="map-layer-btn"
        :class="showFirs ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="toggleFirs"
      >
        {{ layerLabels.firs }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="showNavaids ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="toggleNavaids"
      >
        {{ layerLabels.navaids }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="airspaceFamily === 'controlled' ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="setAirspaceFamily('controlled')"
      >
        {{ layerLabels.sectors }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="airspaceFamily === 'restricted' ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="setAirspaceFamily('restricted')"
      >
        {{ layerLabels.restricted }}
      </button>
    </div>

    <div v-if="!hasPoints" class="map-hint card">
      <p class="font-medium text-ink">{{ emptyTitle }}</p>
      <p class="mt-1 text-muted">{{ emptyBody }}</p>
    </div>
  </section>
</template>
