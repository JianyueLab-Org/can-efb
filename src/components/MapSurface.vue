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
import {
  blocksFor,
  fetchMORABlock,
  toMORAPoints,
  type MORACell,
} from "@/lib/mora";
import { fetchFIRs } from "@/lib/firs";
import {
  fetchDatafeed,
  onlineControllers,
  ownPilot,
  toControllerPoints,
  toOwnPoint,
  toTrafficPoints,
} from "@/lib/datafeed";
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
  /**
   * 自己的 CAN ID。没登录是 null。
   *
   * **用来在 datafeed 里认出自己那架飞机**，按 CID 而不是呼号 —— 呼号是每次连线
   * 自己填的，两个人可以填成一样，而认错的后果是把别人的飞机标成"你"。
   */
  cid: string | null;
  /** 其余图层开关的文案，已翻译。 */
  layerLabels: {
    firs: string;
    navaids: string;
    mora: string;
    live: string;
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
  mora: boolean;
  live: boolean;
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
  // **默认关。** 它是全图铺满的数字，和航路点、导航台标注抢同一片空白 —— 开着
  // 好看，但要读航路的时候是噪音。需要它的人（雷达引导、绕飞、备降）自己开。
  mora: false,
  navaids: true,
  airspace: "off",
  // **默认开。** 这一层回答的是"现在谁在线、我在哪"，而那正是打开飞行包的人第
  // 一眼想知道的；它也很轻（整张网络的实时数据一次几 KB）。
  live: true,
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
 *
 * **数据不来自 can-db**，来自随站点发的静态文件（VATSpy，见 lib/firs.ts）：汇编
 * 没有发布完整的边界，沿国境线的那一段不在数据里，闭合成环会切一条直线横穿过
 * 去。由此这一层也不受 aipAccess 影响，没有登录门槛之外的权限要求。
 */
const showFirs = ref(false);
const firs = ref<FeatureCollection | null>(null);
let firCache: FeatureCollection | null = null;

/**
 * Grid MORA。**唯一一个按视野取的图层**，其余几层都是一次拉全国。
 *
 * 理由是量级：航路网全国八千段，格子光是覆盖框内就有几千个，而且它只在放大到
 * 读得出数字时才有用。所以按 10 度分块取、块内整块缓存 —— 平移不重取，因为格
 * 子本身固定不动。
 */
const showMora = ref(false);
const mora = ref<FeatureCollection | null>(null);
/** 已取回的格子，跨块累积；键是 `lat,lon`。 */
const moraCells = new Map<string, MORACell>();
/** 已经取过（或正在取）的块，键是块的左下角。避免同一块并发重复请求。 */
const moraBlocks = new Set<string>();
let lastViewport: {
  south: number;
  west: number;
  north: number;
  east: number;
} | null = null;

/**
 * 实时：在线管制、其余在线航班、自己那架飞机。
 *
 * 一个开关管三层，因为它们是**同一份数据的三个部分** —— 拆成三个开关，关掉其中
 * 一个也省不下任何请求，只是多两颗按钮。
 *
 * 直接打 can-fsd 的 datafeed，不走本站反代（它公开、无鉴权、带 `ACAO: *`），理
 * 由见 lib/datafeed.ts。
 */
const showLive = ref(false);
const traffic = ref<FeatureCollection | null>(null);
const atc = ref<FeatureCollection | null>(null);
const own = ref<FeatureCollection | null>(null);
/** 在线管制席位数，给按钮上那个角标用。 */
const atcCount = ref(0);
/**
 * 自己那架飞机的当前位置，给「定位到我」用。没连线是 null，那颗按钮也就不出现。
 *
 * 单独存一份而不是从 `own` 那个要素集合里挖：挖出来要走
 * `own.features[0].geometry.coordinates`，而那串下标一旦和构造那边对不上，错法
 * 是安静地定位到别处。
 */
const ownAt = ref<{ lat: number; lon: number; callsign: string } | null>(null);

/**
 * 30 秒一轮。
 *
 * 不是秒级：这是飞行前后看的图，而 datafeed 本身也是每秒重算一次快照，取得再密
 * 也只是拿到同一批数字。can-fsd 还有 `/v1/events` 增量流，管制端该用那个。
 */
const LIVE_INTERVAL_MS = 30_000;
let liveTimer: ReturnType<typeof setInterval> | null = null;
/** 首次取数期间挡住再次点击，见 toggleLive。 */
let liveInFlight = false;

async function refreshLive() {
  try {
    const feed = await fetchDatafeed();
    const controllers = onlineControllers(feed);
    atc.value = toControllerPoints(controllers);
    atcCount.value = controllers.length;
    traffic.value = toTrafficPoints(feed, props.cid);
    const mine = ownPilot(feed, props.cid);
    own.value = toOwnPoint(mine);
    ownAt.value = mine
      ? { lat: mine.latitude, lon: mine.longitude, callsign: mine.callsign }
      : null;
  } catch (error) {
    // **不关掉这一层，也不清空已画的东西。** 实时数据每 30 秒重试一次，一次抖动
    // 就把飞机从图上抹掉比让它停在 30 秒前的位置糟得多 —— 后者至少是真的发生过
    // 的位置。
    console.error("[efb:map] 实时数据加载失败:", error);
  }
}

async function toggleLive() {
  // **先翻状态再取数**，而不是取完再翻。中间那一段 await 是可以被再点一次的：
  // 「开」还在等第一份数据时又点了「关」，若状态留到 await 之后才写，关的那次
  // 会被开的那次覆盖 —— 界面显示关着，定时器却活着，而且没有任何办法再关掉它。
  if (liveInFlight) return;
  prefs.live = !showLive.value;
  writePrefs(prefs);

  if (showLive.value) {
    showLive.value = false;
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    traffic.value = null;
    atc.value = null;
    own.value = null;
    ownAt.value = null;
    atcCount.value = 0;
    return;
  }

  showLive.value = true;
  liveInFlight = true;
  try {
    await refreshLive();
  } finally {
    liveInFlight = false;
  }
  // 定时器在开关打开之后才建，关掉时清掉 —— 否则关着的图层还在每 30 秒发请求。
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => void refreshLive(), LIVE_INTERVAL_MS);
}

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

  layerBusy.value = true;
  try {
    firCache = await fetchFIRs();
    firs.value = firCache;
    showFirs.value = true;
  } catch (error) {
    // 这里不记 deniedThisSession：静态文件不会返回 401，而把一次网络抖动记成
    // 「被拒过」会让这一层在整个会话里再也不重试。
    console.error("[efb:map] 情报区加载失败:", error);
    showFirs.value = false;
    firs.value = null;
  } finally {
    layerBusy.value = false;
  }
}

/**
 * 视野变了：把覆盖它的块补齐。
 *
 * 图层关着就什么都不做 —— 地图一直在动，而不看的东西不该产生流量。
 */
async function onViewport(v: {
  south: number;
  west: number;
  north: number;
  east: number;
}) {
  lastViewport = v;
  if (!showMora.value || deniedThisSession) return;
  await loadMoraFor(v);
}

async function loadMoraFor(v: {
  south: number;
  west: number;
  north: number;
  east: number;
}) {
  const wanted = blocksFor(v.south, v.west, v.north, v.east).filter(
    (b) => !moraBlocks.has(`${b.lat},${b.lon}`),
  );
  if (!wanted.length) return;
  // 先记下来再取：同一块的第二次请求在第一次回来之前就该被挡掉。
  for (const b of wanted) moraBlocks.add(`${b.lat},${b.lon}`);

  try {
    const batches = await Promise.all(
      wanted.map((b) => fetchMORABlock(b.lat, b.lon)),
    );
    for (const cells of batches) {
      for (const c of cells) moraCells.set(`${c.lat},${c.lon}`, c);
    }
    mora.value = toMORAPoints([...moraCells.values()]);
  } catch (error) {
    if (isDenied(error)) deniedThisSession = true;
    // 取失败的块要放回去，否则这次会话里再也不会重试它。
    for (const b of wanted) moraBlocks.delete(`${b.lat},${b.lon}`);
    console.error("[efb:map] Grid MORA 加载失败:", error);
  }
}

async function toggleMora() {
  prefs.mora = !showMora.value;
  writePrefs(prefs);

  if (showMora.value) {
    showMora.value = false;
    // **缓存留着**：关掉再打开是常见操作，而格子不会变。
    mora.value = null;
    return;
  }
  showMora.value = true;
  if (moraCells.size) mora.value = toMORAPoints([...moraCells.values()]);
  if (deniedThisSession) return;

  layerBusy.value = true;
  try {
    // 还没收到过视野就先不取 —— `moveend` 和地图 load 都会送一次过来。
    if (lastViewport) await loadMoraFor(lastViewport);
  } finally {
    layerBusy.value = false;
  }
}

/**
 * 把视野对到自己那架飞机上。
 *
 * 走 `focus` 这个已有的通路，而不是新开一条：RouteMap 里 focus 的语义正是"在一
 * 堆点里挑一个看，别把缩放丢掉"，和这里要的一模一样。
 *
 * **每次都造一个新对象**，因为 render() 现在按引用判断 focus 变没变（否则实时数
 * 据每 30 秒会把镜头拽回来一次）。连点两次要都生效，就不能复用同一个对象。
 */
function locateOwn() {
  const at = ownAt.value;
  if (!at) return;
  focus.value = { ident: at.callsign, lat: at.lat, lon: at.lon, kind: "own" };
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
  if (saved.mora) void toggleMora();
  if (saved.live) void toggleLive();
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
  // 定时器必须停。这块地图是 `transition:persist` 的，一般不会走到这里 —— 但真
  // 走到了而定时器还活着，就是一个每 30 秒发一次请求、谁也看不见的泄漏。
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
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
      :mora="mora"
      :traffic="traffic"
      :atc="atc"
      :own="own"
      @viewport="onViewport"
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
        :class="showMora ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="toggleMora"
      >
        {{ layerLabels.mora }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="showLive ? 'is-on' : ''"
        @click="toggleLive"
      >
        {{ layerLabels.live
        }}<span v-if="showLive && atcCount" class="map-layer-count">{{
          atcCount
        }}</span>
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

    <!--
      「定位到我」。**只在自己真的连着线时才出现** —— 一颗按下去没反应的按钮比
      没有这颗按钮更让人怀疑是坏了。呼号写在按钮上，顺带回答"网络认到的是我哪一
      次连线"。
    -->
    <button
      v-if="ownAt"
      type="button"
      class="map-locate card"
      @click="locateOwn"
    >
      <span aria-hidden="true">✈</span>
      <span class="font-mono">{{ ownAt.callsign }}</span>
    </button>

    <div v-if="!hasPoints" class="map-hint card">
      <p class="font-medium text-ink">{{ emptyTitle }}</p>
      <p class="mt-1 text-muted">{{ emptyBody }}</p>
    </div>
  </section>
</template>
