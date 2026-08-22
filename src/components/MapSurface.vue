<script setup lang="ts">
/**
 * 常驻的显示面。轨在最左，中间是当前菜单项的面板，这一块占住右边。
 *
 * **它和 `RouteMap.vue` 不是一回事。** RouteMap 是画图的那一层（MapLibre、底图、
 * 大圆弧、主题跟随）；这一层负责取数据、管图层开关、订阅面板发来的点，以及守住
 * 那条唯一不能松的规矩（见最后一段）。
 *
 * **底图始终在，而且不再解释自己。** 这块地方经历过两版：
 *
 * 第一版没有航路时把整块地图换成一段文字，理由是「一张画不出东西的空地图会被当成
 * 坏掉的地图」。那条被推翻了 —— 底图本身是真实的地理数据，不是编出来的占位数字，
 * 而把整块显示面换成文字恰恰破坏了这一版外壳的前提（右边就是地图）。
 *
 * 第二版把那段话缩成压在右上角的一个小提示。**那块提示现在也删了**：它的文案说
 * 「这个网络今天只有航路一个地理数据源」，而地图上早就有航路、航路点、导航台、空
 * 域、Grid MORA、情报区边界、在线机组和在线管制 —— 一句已经变成假话的说明，比没
 * 有说明更糟。
 *
 * 真正需要解释的那几种情形各自有自己的话，而且说得准：图层取回来是空的、没有
 * `aipAccess`、地图整个起不来（分别见 `notice` 和 RouteMap 的 `failure`）。
 *
 * 代价写在这里，别当它不存在：**MapLibre 那个 chunk 现在每一页都要加载**，不再是
 * 「解出航路才下载」。这是为「地图是主体」付的钱。如果哪天要把它省回来，正确的做
 * 法是让不可能画出东西的页面根本不渲染这一列，而不是把底图换成文字。
 *
 * 仍然不能松的那一条：**绝不服务端渲染 MapLibre。** 它在模块顶层就摸 `window`。
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
  type AirwayLevel,
} from "@/lib/airways";
import {
  fetchNavaids,
  toNavaidPoints,
  fetchAirspaces,
  toAirspacePolygons,
  onlyParents,
  type Airspace,
} from "@/lib/aip";
import {
  blocksFor,
  fetchMORABlock,
  toMORAPoints,
  type MORACell,
} from "@/lib/mora";
import { fetchFIRs } from "@/lib/firs";
import {
  fetchGround,
  toGroundDrawing,
  GROUND_MIN_ZOOM,
  GROUND_MAX_AIRPORTS,
  type Ground,
} from "@/lib/ground";
import {
  fetchAirportPins,
  airportsInView,
  toAirportPoints,
} from "@/lib/airports";
import { fetchRunways, toRunwayFeatures } from "@/lib/runways";
import {
  fetchDatafeed,
  onlineControllers,
  ownPilot,
  toControllerAreas,
  toControllerPoints,
  toOwnPoint,
  toTrafficPoints,
} from "@/lib/datafeed";
import { boundaryCodesFor, ownsAirspace } from "@/lib/atc";
import { altitudeBand, flightLevel, isOnGround } from "@/lib/traffic";
import type { FeatureCollection } from "geojson";
import { api } from "@/lib/canApi";
import { unwrapList } from "@/lib/aip";

const props = defineProps<{
  /** 地图角上的说明，已翻译。 */
  label: string;
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
    /** 在线机组。 */
    traffic: string;
    /** 在线管制。和 `ctr`/`app` 不是一回事 —— 那两个是空域划分，这个是谁在线。 */
    atcLive: string;
    ctr: string;
    app: string;
    restricted: string;
  };
  /** 图层相关的几句话，已翻译。 */
  t: {
    /** 「有 n 块边界不完整没画」，`{n}` 会被替换。 */
    partial: string;
    /** 没有 aipAccess 时那一句。 */
    denied: string;
    /** 某一层取回来是空的时候那一句，按层分。 */
    emptyAirways: string;
    emptyNavaids: string;
    emptyGeneric: string;
    /** 画的是航图线画时那一句，`{m}` 是精度米数。 */
    groundAccuracy: string;
    /** 地图上画着已提交计划时的角标，`{from}`/`{to}` 是起降机场。 */
    planOnMap: string;
  };
  /** 地图整个起不来时那两句，转交给 RouteMap。 */
  failureText: { init: string; webgl: string };
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
  /**
   * 实时那两层，各存各的。
   *
   * `atcLive` 而不是 `atc`，是为了不和空域那三个开关里的 `ctr`/`app` 混 —— 那三个
   * 画的是**空域的划分**（静态资料），这一个画的是**谁在线**（实时）。名字撞了迟早
   * 有人改错一个。
   */
  traffic: boolean;
  atcLive: boolean;
  navaids: boolean;
  /**
   * 空域从"单选一族"改成**三个独立开关**：区域管制、进近管制、限制区。
   *
   * 单选是错的形状：区域和进近是**嵌套**的两层（进近整个套在区域里），而"看巡航
   * 段归谁管"和"看进离场归谁管"经常要一起看。限制区更是和它们互不相干。
   */
  ctr: boolean;
  app: boolean;
  restricted: boolean;
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
  // 三层都默认关：它们是大片填充，叠在航路上会把线糊掉。要看的人自己开。
  ctr: false,
  app: false,
  restricted: false,
  // **两层都默认开。** 它们回答的是"现在谁在线、我在哪"，而那正是打开飞行包的人第
  // 一眼想知道的；数据也很轻（整张网络一次几 KB，两层共用同一次取数）。
  //
  // 拆成两个开关是为了**能分别关掉**，不是为了默认少画一层 —— 默认行为没变。
  traffic: true,
  atcLive: true,
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

/**
 * 图层层面的一句话：这一层为什么没东西。
 *
 * **这是本次改动要解决的那个故障。** 一个按需图层有三种没东西的情形，而以前只有
 * 一种会说话：
 *
 *   1. 请求失败      —— 会说（console.error + 退回关）
 *   2. 权限不够      —— **不说**，`deniedThisSession` 把它咽掉了
 *   3. 取回来是空的  —— **不说**，因为它根本不是错误：200 加一个空数组，
 *                       `toAirwayLines` 得到 0 个要素，一路顺畅地画出一张空图
 *
 * 第 3 种是今天线上高空航路的真实处境：航段的 `level` 一列全是默认值，can-db 的
 * 高空视图因此返回 0 条（见那个仓库的 TODO）。开关亮在「高空」上、图上一条线都没
 * 有、控制台一个字都没有 —— 于是它看起来像**地图坏了**，而不是像**这一层没有数
 * 据**。这两件事对使用者要做的判断完全不同。
 *
 * 带 `layer` 是为了让提示跟着来源走：B 层加载成功时不该把 A 层那句话抹掉，而 A
 * 层自己关掉时那句话必须跟着消失。
 */
const notice = ref<{ layer: string; text: string } | null>(null);

function setNotice(layer: string, text: string) {
  // 权限那条是**会话级**的，压过一切按层的提示：它一旦成立，其余每一层都会因为
  // 同一个原因空着，而把「这一层没有数据」摆在最前面会让人以为换一层就好了。
  if (notice.value?.layer === "denied") return;
  notice.value = { layer, text };
}

function clearNotice(layer: string) {
  if (notice.value?.layer === layer) notice.value = null;
}

function noteDenied() {
  deniedThisSession = true;
  notice.value = { layer: "denied", text: props.t.denied };
}

let navaidCache: FeatureCollection | null = null;

const points = ref<MapPoint[]>([]);
const markers = ref<MapPoint[]>([]);
const focus = ref<MapPoint | null>(null);
const label = ref(props.label);

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
    clearNotice("airways");
    return;
  }

  const cached = airwayCache.get(level);
  if (cached) {
    airways.value = cached.lines;
    airwayFixes.value = cached.fixes;
    // 缓存命中也要判一次空：空的那一层缓存的正是"空"，而提示不该只在第一次出现。
    if (cached.lines.features.length) clearNotice("airways");
    else setNotice("airways", props.t.emptyAirways);
    return;
  }

  if (deniedThisSession) return;
  airwayBusy.value = true;
  try {
    const graph = await fetchAirways(level);
    const lines = toAirwayLines(graph);
    // 航路点和线一起来一起走：它们是同一份图的两个面，分开缓存迟早不同步。
    const fixes = toAirwayFixes(graph);
    airwayCache.set(level, { lines, fixes });
    airways.value = lines;
    airwayFixes.value = fixes;

    // **取回来是空的，不是失败。** 所以不退回"关"：开关停在这一层是对的，人确实
    // 选了它，只是这一层今天没有数据。退回"关"反而会让人以为自己没点上。
    if (lines.features.length) clearNotice("airways");
    else setNotice("airways", props.t.emptyAirways);
  } catch (error) {
    // 这一层是用户明确打开的，不是装饰性底图 —— 失败要说话，而且要退回"关"，
    // 否则开关停在"高空"上却什么都没画，看起来像这一带没有航路。
    if (isDenied(error)) noteDenied();
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
 * 取回边界底图并缓存，**和"要不要画边界这一层"无关**。
 *
 * 两个消费者：边界图层自己（`toggleFirs`），以及实时那一层 —— 它要拿边界去圈出
 * 「这块空域现在有人管」。后者在边界图层关着的时候也需要这份数据，所以取数不能挂
 * 在开关上。
 */
async function loadFirCache(): Promise<FeatureCollection> {
  if (!firCache) firCache = await fetchFIRs();
  return firCache;
}

/**
 * Grid MORA。**唯一一个按视野取的图层**，其余几层都是一次拉全国。
 *
 * 理由是量级：航路网全国八千段，格子光是覆盖框内就有几千个，而且它只在放大到
 * 读得出数字时才有用。所以按 10 度分块取、块内整块缓存 —— 平移不重取，因为格
 * 子本身固定不动。
 */
const showMora = ref(false);
const mora = ref<FeatureCollection | null>(null);

/**
 * 机场地面。**没有开关**，由缩放决定 —— 见 `loadGroundFor`。
 *
 * 三个 ref 是一组：几何、署名、精度。后两个不是装饰 ——
 *
 *   - `groundAttribution` 是 **ODbL 的许可条款**。OSM 那份数据用了就必须署名，而
 *     它由数据决定（只有真用了 OSM 的机场才有值），所以不能写死一句挂在图上。
 *   - `groundAccuracyM` 只在画**航图线画**那份时有值。那一份位置只能信到 5–20
 *     米；分好类的那份是米级的，给它标精度反而误导。
 */
/**
 * 全部机场的齿轮点。**没有开关，也不按视野裁** —— 见 lib/airports.ts。
 *
 * 缩放阶梯上它排在情报区之后、航路之前：缩到最小只剩情报区，放一级先看到「这一片
 * 有哪些机场」。出不出现由图层的 minzoom 管，这里只负责把点备好。
 */
const airports = ref<FeatureCollection | null>(null);
/**
 * 全库跑道。**整份取一次，不按视野裁** —— 34 kB，而缩放阶梯要它在比例尺 20 公里那
 * 一档就出现，那个视野里有十几个机场。出不出现由图层的 minzoom 管。
 */
const runways = ref<FeatureCollection | null>(null);
const ground = ref<FeatureCollection | null>(null);
const groundAttribution = ref<string[]>([]);
const groundAccuracyM = ref(0);
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
 * 实时数据：在线机组、在线管制、自己那架飞机。
 *
 * ## 从一个开关拆成两个
 *
 * 这里原来是一个「实时」开关管三层，注释写的理由是「它们是同一份数据的三个部分，
 * 拆开也省不下任何请求，只是多两颗按钮」。
 *
 * **那句话只算了请求，没算屏幕。** 省不省请求确实一样，但这两层在图上是完全不同的
 * 两种噪音：一屏几十架飞机和几块铺满的管制区，想看航路的时候要关掉的往往只是其中一
 * 样。多一颗按钮换的是"能只留下要看的那层"，那笔账是划算的。
 *
 * ## 自己那架跟着机组走
 *
 * 它是机组的一员，而且是最要紧的那一个。关掉机组这一层连它一起收掉是说得通的 ——
 * 想只看管制的时候，图上留一架自己也是噪音。「定位到我」那颗按钮因此也跟着消失，这
 * 是对的：按下去没反应比没有按钮更让人怀疑。
 *
 * ## 两个开关共用一次取数
 *
 * 只要有一个开着就轮询，两个都关就停。datafeed 是一份文档，取一次两层都有 —— 分两
 * 次取才是真的浪费。
 *
 * 直接打 can-fsd 的 datafeed，不走本站反代（它公开、无鉴权、带 `ACAO: *`），理
 * 由见 lib/datafeed.ts。
 */
const showTraffic = ref(false);
const showAtc = ref(false);
/** 两层里有任何一层开着，就该在轮询。 */
const liveOn = computed(() => showTraffic.value || showAtc.value);
const traffic = ref<FeatureCollection | null>(null);
/** 场面席位（放行/地面/塔台），外加没能对上边界的那些。画成点。 */
const atc = ref<FeatureCollection | null>(null);
/** 区域 / 进近 / FSS 管的那片空域。画成范围，不是点。 */
const atcAreas = ref<FeatureCollection | null>(null);
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

/**
 * 从别的标签页切回来时立刻补一次。
 *
 * 没有这一下，藏起来期间跳过的那些轮次会让画面停在最多 30 秒前 —— 而"切回来第一
 * 眼看到的是旧位置"正是这一层最不该有的样子。
 */
function onVisible() {
  if (!document.hidden && liveOn.value) void refreshLive();
}

async function refreshLive() {
  // **标签页看不见就不取。** 这一层每 30 秒一次、只要开着就永远在跑 —— 而飞行包
  // 常常是开着一整晚的第二块屏。看不见的时候取回来的数据没有任何人读，却照样占
  // 着流量和 can-fsd 的一次请求。
  //
  // 不用停掉定时器：`visibilitychange` 回来时会立刻补一次（见下面），而让定时器
  // 继续空转比"停掉再重建"少一处状态。
  if (typeof document !== "undefined" && document.hidden) return;
  try {
    const feed = await fetchDatafeed();

    /* 两层各自按自己的开关算。**取数只有一次** —— datafeed 是一份文档，管制和机组
       都在里面，分两次取才是浪费。关着的那层不去算要素，省的是 CPU 不是流量。 */
    if (showTraffic.value) {
      traffic.value = toTrafficPoints(
        feed,
        props.cid,
        altitudeBand,
        isOnGround,
        flightLevel,
      );
      const mine = ownPilot(feed, props.cid);
      own.value = toOwnPoint(mine);
      ownAt.value = mine
        ? { lat: mine.latitude, lon: mine.longitude, callsign: mine.callsign }
        : null;
    }
    if (!showAtc.value) return;

    const controllers = onlineControllers(feed);

    /* 区域和进近画**范围**，场面席位画点。

       以前所有席位一律画成一个点，而那个点是管制员自己的视野中心 —— 既不是他管的
       空域，也不在它中间。`ZBPE_CTR` 在河北上空一个小圆点，读不出「华北这一整片归
       他」，而那正是飞行员要知道的。

       边界底图**按需现取**：这一层默认是开的，而边界那一层不一定（`showFirs` 可以
       关掉）。所以这里不看 `firs.value`，直接要 `firCache` —— 两层的开关互不影响。 */
    const boundaries = firCache ?? (await loadFirCache().catch(() => null));
    const { areas, unmatched } = toControllerAreas(
      controllers,
      boundaries,
      ownsAirspace,
      boundaryCodesFor,
    );
    atcAreas.value = areas;
    // 点这一层留给场面席位，外加**没能对上边界的那些** —— 它们不该从图上消失。
    atc.value = toControllerPoints(
      controllers.filter((c) => !ownsAirspace(c.facility)).concat(unmatched),
    );
    atcCount.value = controllers.length;
  } catch (error) {
    // **不关掉这一层，也不清空已画的东西。** 实时数据每 30 秒重试一次，一次抖动
    // 就把飞机从图上抹掉比让它停在 30 秒前的位置糟得多 —— 后者至少是真的发生过
    // 的位置。
    console.error("[efb:map] 实时数据加载失败:", error);
  }
}

/**
 * 机组和管制各一个开关，**共用一个定时器**。
 *
 * 两个都关才停轮询：datafeed 是一份文档，两层都从它来，只要还有一层开着就得继续
 * 取。定时器只有一个，因为取一次就够两层用。
 */
async function toggleLive(which: "traffic" | "atc") {
  // **先翻状态再取数**，而不是取完再翻。中间那一段 await 是可以被再点一次的：
  // 「开」还在等第一份数据时又点了「关」，若状态留到 await 之后才写，关的那次
  // 会被开的那次覆盖 —— 界面显示关着，定时器却活着，而且没有任何办法再关掉它。
  if (liveInFlight) return;
  const flag = which === "traffic" ? showTraffic : showAtc;
  const next = !flag.value;
  flag.value = next;
  prefs[which === "traffic" ? "traffic" : "atcLive"] = next;
  writePrefs(prefs);

  if (!next) {
    // 关掉的那一层清干净。自己那架跟着机组走 —— 它是机组的一员，而且只看管制的时
    // 候，图上留一架自己也是噪音。
    if (which === "traffic") {
      traffic.value = null;
      own.value = null;
      ownAt.value = null;
    } else {
      atc.value = null;
      atcAreas.value = null;
      atcCount.value = 0;
    }
    // 另一层还开着就继续轮询，两个都关了才停。
    if (!liveOn.value && liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    return;
  }

  liveInFlight = true;
  try {
    await refreshLive();
  } finally {
    liveInFlight = false;
  }
  // 定时器建一次就够两层用；已经在跑就别重建，否则第二个开关会把周期重新计时。
  if (!liveTimer) {
    liveTimer = setInterval(() => void refreshLive(), LIVE_INTERVAL_MS);
  }
}

/**
 * 空域三层。**同一次请求**（can-db 的 `?family=controlled` 一次给全部 672 块），
 * 按 `kind` 在本地分成区域和进近 —— 拆成两次请求只是把同一份数据取两遍。
 *
 * 只画**父区**（`CTA` / `APP`），不画它们内部的席位划分：29 个区域管制区被切成
 * 307 个扇区、50 个进近被切成 287 个，全铺开是每个父区一圈外框加几条内部分割
 * 线，叠成一张网 —— 那是管制席位的图，不是飞行员看的航图。
 */
const showCtr = ref(false);
const showApp = ref(false);
const showRestricted = ref(false);

/** can-db 那一族的原始清单，取一次就够。 */
let controlledCache: Airspace[] | null = null;
let restrictedCache: Airspace[] | null = null;

/**
 * 因为边界不完整而没画的块数，分层记着。
 *
 * **要显示出来。** 汇编对将近一半的区域管制区只发布了边界的一段（其余沿国境线
 * 走，而国境线不在数据里），照着画会得到一条看起来合理的错边界，所以那些块被跳
 * 过了 —— 但**静默地少画和静默地画错一样糟**，得让人知道图上缺了几块。
 */
const skipped = ref({ ctr: 0, app: 0, restricted: 0 });
const airspaces = ref<FeatureCollection | null>(null);

const layerBusy = ref(false);

async function toggleNavaids() {
  prefs.navaids = !showNavaids.value;
  writePrefs(prefs);
  if (showNavaids.value) {
    showNavaids.value = false;
    navaids.value = null;
    clearNotice("navaids");
    return;
  }
  if (navaidCache) {
    navaids.value = navaidCache;
    showNavaids.value = true;
    if (navaidCache.features.length) clearNotice("navaids");
    else setNotice("navaids", props.t.emptyNavaids);
    return;
  }
  if (deniedThisSession) return;
  layerBusy.value = true;
  try {
    navaidCache = toNavaidPoints(await fetchNavaids());
    navaids.value = navaidCache;
    showNavaids.value = true;
    // 和航路那层同一条：空不是错，开关留在打开状态，用一句话说明它为什么空。
    if (navaidCache.features.length) clearNotice("navaids");
    else setNotice("navaids", props.t.emptyNavaids);
  } catch (error) {
    // 和航路那层同一条规矩：用户明确打开的图层，失败要说话并退回关，否则开关亮
    // 着却什么都没画，看起来像这一带没有导航台。
    if (isDenied(error)) noteDenied();
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
    firs.value = await loadFirCache();
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
  zoom: number;
}) {
  lastViewport = v;
  /* 地面和 Grid MORA 都挂在这个事件上，但**互不相干**：地面没有开关，它由缩放
     自己决定出不出现，所以不能藏在 MORA 那个 return 后面。 */
  void loadGroundFor(v);
  if (!showMora.value || deniedThisSession) return;
  await loadMoraFor(v);
}

/* 已经取回来的机场地面，按 ICAO。**留着不清**：平移出去再回来是最常见的动作，
   而每个机场是兆级的几何 —— 清掉等于每次来回都重下一遍。 */
const groundCache = new Map<string, Ground>();
/** 这一轮画的是哪几个场，用来判断要不要重新拼 GeoJSON。 */
let groundShown = "";

/**
 * 放大到门槛以上时，把视野里的机场地面补上。
 *
 * **没有图层开关，这是刻意的。** 地面只在放大之后出现，而放大本身就是"我要看这个
 * 机场"的意思 —— 再要求点一次开关，等于让人先猜到有这么个开关。缩回去它自己消
 * 失，不留状态。
 */
async function loadGroundFor(v: {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
}) {
  if (v.zoom < GROUND_MIN_ZOOM) {
    // 缩回去就清空。留着不画只是省一次拼装，却会让下次放大到别处时先闪一下上一
    // 个机场的地面。
    if (ground.value) {
      ground.value = null;
      groundAttribution.value = [];
      groundAccuracyM.value = 0;
      groundShown = "";
      clearNotice("ground");
    }
    return;
  }

  const pins = await fetchAirportPins();
  if (!pins.length) return;

  const wanted = airportsInView(pins, v).slice(0, GROUND_MAX_AIRPORTS);
  if (!wanted.length) {
    if (ground.value) {
      ground.value = null;
      groundAttribution.value = [];
      groundAccuracyM.value = 0;
      groundShown = "";
      clearNotice("ground");
    }
    return;
  }

  await Promise.all(
    wanted
      .filter((p) => !groundCache.has(p.icao))
      .map(async (p) => {
        const g = await fetchGround(p.icao);
        // null = 这个场没有地面数据。`fetchGround` 自己记住了，这里不必再记 ——
        // 它不进 groundCache，所以下面拼装时自然跳过。
        if (g) groundCache.set(p.icao, g);
      }),
  );

  const have = wanted
    .map((p) => groundCache.get(p.icao))
    .filter((g): g is Ground => !!g);

  const key = have.map((g) => g.icao).join(",");
  if (key === groundShown) return;
  groundShown = key;

  if (!have.length) {
    ground.value = null;
    groundAttribution.value = [];
    groundAccuracyM.value = 0;
    clearNotice("ground");
    return;
  }

  const drawing = toGroundDrawing(have);
  ground.value = drawing.collection;
  /* 署名**必须**显示 —— OSM 那份是 ODbL，署名是许可条款不是礼貌。由数据决定而不
     是写死：只有真的用了 OSM 的机场才有值，写死会让纯扇区包的机场挂一个错误的出
     处。汇编那份的规矩正好相反（来源不能外露），所以画 lines 时这里是空的。 */
  groundAttribution.value = drawing.attributions;
  /* 画的是航图线画时才说精度：那一份位置只能信到 5–20 米，而分好类的那份是米级
     的，给它标一个精度反而是误导。 */
  groundAccuracyM.value = drawing.kind === "lines" ? drawing.worstAccuracyM : 0;

  /* 只有画**航图线画**时才说精度。
   *
   * 分好类的那份是米级的，给它标一句「约 20 米」反而是误导。而航图那份非说不
   * 可：它画出来和图纸一样利落，看不出位置只能信到 5–20 米 —— 正是那种"看起来
   * 完全正常"的错，这个网络的文档里反复记的就是这一类。 */
  if (groundAccuracyM.value > 0) {
    setNotice(
      "ground",
      props.t.groundAccuracy.replace(
        "{m}",
        String(Math.round(groundAccuracyM.value)),
      ),
    );
  } else {
    clearNotice("ground");
  }
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
    if (isDenied(error)) noteDenied();
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

async function loadControlled(): Promise<Airspace[]> {
  if (!controlledCache) controlledCache = await fetchAirspaces("controlled");
  return controlledCache;
}

async function loadRestricted(): Promise<Airspace[]> {
  if (!restrictedCache) restrictedCache = await fetchAirspaces("restricted");
  return restrictedCache;
}

/**
 * 三层合成一个要素集合再交给地图。
 *
 * 一个 source 而不是三个：它们的画法只差颜色（靠要素上的 `cls` 分），而三个
 * source 意味着 RouteMap 里三套图层、三份主题切换 —— 换来的只是能分别控制层序，
 * 而这三层本来就该在同一层。
 */
function composeAirspaces() {
  const parts: Airspace[] = [];
  const counts = { ctr: 0, app: 0, restricted: 0 };

  if (showCtr.value && controlledCache) {
    const list = onlyParents(controlledCache, "CTA");
    const built = toAirspacePolygons(list);
    counts.ctr = built.skipped;
    parts.push(...list);
  }
  if (showApp.value && controlledCache) {
    const list = onlyParents(controlledCache, "APP");
    counts.app = toAirspacePolygons(list).skipped;
    parts.push(...list);
  }
  if (showRestricted.value && restrictedCache) {
    counts.restricted = toAirspacePolygons(restrictedCache).skipped;
    parts.push(...restrictedCache);
  }

  skipped.value = counts;
  airspaces.value = parts.length ? toAirspacePolygons(parts).features : null;
}

/** 一个开关的通用形状：拉数据（带缓存）、翻状态、重新合成。 */
async function toggleAirspace(which: "ctr" | "app" | "restricted") {
  const flag =
    which === "ctr" ? showCtr : which === "app" ? showApp : showRestricted;

  prefs[which] = !flag.value;
  writePrefs(prefs);

  if (flag.value) {
    flag.value = false;
    composeAirspaces();
    // 三层都关掉了才撤提示 —— 还开着一层就说明那句话仍然在描述屏幕上的情况。
    if (!airspaces.value?.features.length && !showCtr.value && !showApp.value) {
      if (!showRestricted.value) clearNotice("airspace");
    }
    return;
  }
  if (deniedThisSession) return;

  layerBusy.value = true;
  try {
    if (which === "restricted") await loadRestricted();
    else await loadControlled();
    flag.value = true;
    composeAirspaces();
    // 三层共用一个要素集合，所以空不空要看合成之后的结果，不看单独哪一族。
    if (airspaces.value?.features.length) clearNotice("airspace");
    else setNotice("airspace", props.t.emptyGeneric);
  } catch (error) {
    if (isDenied(error)) noteDenied();
    console.error("[efb:map] 空域加载失败:", error);
    flag.value = false;
    composeAirspaces();
  } finally {
    layerBusy.value = false;
  }
}

/** 三层里一共跳过了多少块，给那条提示用。 */
const skippedTotal = computed(
  () => skipped.value.ctr + skipped.value.app + skipped.value.restricted,
);

/* 面板发过东西没有。**发过就不要再被计划盖掉** —— 计划是异步取的，而面板可能在它
   回来之前就已经推了自己的内容（航路规划器一进页面就推）。没有这道闸，「打开 /route
   画好一条航路，两秒后被自己的飞行计划顶掉」是一定会发生的。 */
let panelPublished = false;

/**
 * 把成员**已提交的飞行计划**画在地图上，作为默认内容。
 *
 * 以前这块地图的默认内容是「上一个面板推过来的东西」，而在没人推之前是空的 ——
 * 打开 EFB 第一眼是一张只有底图的图。可他手上正好有一件事：那条已经交了的计划。
 *
 * 走的是**展开**而不是**生成**：`/api/v1/route` 把计划里那串航路字符串解析成点
 * （`lib/routePlan.ts` 顶上分得很清楚，两条路都在，别弄混）。生成是"还没有计划时
 * 该怎么飞"，这里已经有计划了。
 *
 * 画成 `points` 而不是 `markers`，于是它自动拿到航路那套高亮配色（亮线加一条深色
 * 衬线）—— **那就是「高亮」**，不需要再发明第二种强调样式。
 *
 * 失败一律安静：地图上没有那条线，和这个成员本来就没交计划，在屏幕上是同一回事，
 * 而为此弹一个错误框会把一个常态说成故障。真正要说话的是 Dashboard，它已经在说了
 * （`planFailed` 那一段专门讲了「把失败画成没有」为什么更贵）。
 */
async function loadPlanRoute() {
  const plan = await api<{
    departure?: string;
    arrival?: string;
    route?: string;
  } | null>("/api/v1/pilot/flightplan");
  if (!plan.ok || !plan.data) return;
  if (panelPublished) return;

  const { departure, arrival, route } = plan.data;
  if (!departure || !arrival) return;

  const params = new URLSearchParams({
    departure,
    arrival,
    route: route ?? "",
  });

  /* **走 can-db 的 `/aip/resolve`，不走 can-api 的 `/api/v1/route`。**
   *
   * 两条都做展开，而 can-api 那条还不要 `aipAccess`，看着更宽 —— 但它读的是**全
   * 球** navdata，消歧只有「离上一个点最近的同名点」一条规则，而那是**链式的**：
   * 前一个解错，后一个的「最近」就从错的位置起算。实际见过一条浙江境内的航路因此
   * 一路走到俄罗斯（`FK` 这个代号全球有好几个，浙江那个在 28.6N/121.5E）。
   *
   * can-db 这一份的点表只覆盖本网络 12 个情报区，**压根没有别处那个同名点**，所
   * 以这不是加一道启发式闸去猜哪个点不合理，而是从来就没有可猜的余地。
   *
   * 它要 `aipAccess >= 1`，但这张图上**每一个航行图层本来就都要**（航路、导航
   * 台、空域、MORA、地面全走 can-db）—— 拿不到的成员看到的本来就是一张空底图，
   * 所以这里不多挡任何人。 */
  const response = await fetch(`/api/db/aip/resolve?${params}`);
  if (!response.ok || panelPublished) return;
  const resolved = unwrapList<MapPoint>(await response.json());
  if (!resolved.length) return;

  points.value = resolved;
  label.value = props.t.planOnMap
    .replace("{from}", departure)
    .replace("{to}", arrival);
}

let unsubscribe: (() => void) | null = null;

onMounted(() => {
  mounted.value = true;
  document.addEventListener("visibilitychange", onVisible);

  // 按偏好把图层打开。**这是"打开就看到航图"的那一步** —— 没有它，默认值只是
  // 一个没人读的常量。
  //
  // 不 await：地图不该等航路网下载完才出现，底图和航路是两条独立的线。
  const saved = readPrefs();
  Object.assign(prefs, saved);
  if (saved.airway !== "off") void setAirwayLevel(saved.airway);
  if (saved.firs) void toggleFirs();
  if (saved.mora) void toggleMora();
  // 两层各自恢复。**不能都调一遍 toggleLive**，`liveInFlight` 会把第二次挡掉 ——
  // 那正是它存在的目的（防连点），所以这里直接把状态摆好，取数交给一次 refresh。
  if (saved.traffic) showTraffic.value = true;
  if (saved.atcLive) showAtc.value = true;
  if (liveOn.value) {
    void refreshLive();
    liveTimer = setInterval(() => void refreshLive(), LIVE_INTERVAL_MS);
  }
  if (saved.navaids) void toggleNavaids();
  if (saved.ctr) void toggleAirspace("ctr");
  if (saved.app) void toggleAirspace("app");
  if (saved.restricted) void toggleAirspace("restricted");
  // 计划那条线不 await：地图不该等它回来才出现，和航路网是同一条道理。
  void loadPlanRoute();

  /* 机场齿轮。和地面用的是同一份索引（`fetchAirportPins` 整趟会话只取一次），所以
     这一层不额外花一次请求。取不到就没有齿轮 —— 和别的图层一样安静降级。 */
  void fetchAirportPins().then((pins) => {
    if (pins.length) airports.value = toAirportPoints(pins);
  });

  /* 跑道。和机场索引一样整份取一次 —— 34 kB，比按机场取地面便宜三个数量级，而且它
     带的是权威入口坐标，跑道号不用推。 */
  void fetchRunways().then((list) => {
    if (list.length) runways.value = toRunwayFeatures(list);
  });

  unsubscribe = subscribeToMap((payload) => {
    panelPublished = true;
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
  document.removeEventListener("visibilitychange", onVisible);
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
      :airports="airports"
      :runways="runways"
      :ground="ground"
      :extra-attribution="groundAttribution"
      :navaids="navaids"
      :firs="firs"
      :mora="mora"
      :traffic="traffic"
      :atc="atc"
      :atc-areas="atcAreas"
      :own="own"
      @viewport="onViewport"
      :airspaces="airspaces"
      :label="label"
      :failure-text="failureText"
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
      <!--
        实时那两层各一颗按钮。角标上的数只给管制那颗：席位数是"现在有没有人管"，
        一眼要看的；在线飞机数几十上百，摆上去只是个噪音数字。
      -->
      <button
        type="button"
        class="map-layer-btn"
        :class="showTraffic ? 'is-on' : ''"
        @click="toggleLive('traffic')"
      >
        {{ layerLabels.traffic }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="showAtc ? 'is-on' : ''"
        @click="toggleLive('atc')"
      >
        {{ layerLabels.atcLive
        }}<span v-if="showAtc && atcCount" class="map-layer-count">{{
          atcCount
        }}</span>
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="showCtr ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="toggleAirspace('ctr')"
      >
        {{ layerLabels.ctr }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="showApp ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="toggleAirspace('app')"
      >
        {{ layerLabels.app }}
      </button>
      <button
        type="button"
        class="map-layer-btn"
        :class="showRestricted ? 'is-on' : ''"
        :disabled="layerBusy"
        @click="toggleAirspace('restricted')"
      >
        {{ layerLabels.restricted }}
      </button>
    </div>

    <!--
      因为边界不完整而没画出来的块数。

      **必须说出来。** 汇编对将近一半的区域管制区只发布了边界的一段（其余沿国境
      线走，而国境线不在数据里），照着画会得到一条看起来合理的错边界，所以那些块
      被跳过了 —— 但一张缺了几块而不作声的图，会被当成"这里没有管制区"。
    -->
    <p v-if="skippedTotal" class="map-partial card">
      {{ t.partial.replace("{n}", String(skippedTotal)) }}
    </p>

    <!--
      「这一层为什么没东西」。见 notice 上面那段。

      和上面那条 `partial` 分开、也叠在它下面：那条说的是"画出来的这张图缺了几
      块"，这条说的是"你打开的那一层根本没有数据"。合成一条就得在两种完全不同的
      处境里选一句话说，而它们同时出现是可能的。
    -->
    <p v-if="notice" class="map-notice card" :data-notice="notice.layer">
      {{ notice.text }}
    </p>

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
  </section>
</template>
