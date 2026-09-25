<script setup lang="ts">
/**
 * 地图画布，MapLibre GL。
 *
 * ## 为什么换
 *
 * 这块地图要长成一张航路图：航路线、五字码航路点、导航台符号加频率、空域多边形
 * 和它们的上下限标注，全都叠在一起，标注需要碰撞检测。MapLibre 在 GPU
 * 上画矢量，标签碰撞是它的内建能力。
 *
 * ## 没有瓦片，也没有外部依赖
 *
 * style 是**手写的一个对象**，不指向任何瓦片服务：一个 background 图层当海，一个
 * GeoJSON source 画陆地，如此而已。所以底图里不存在道路、建筑和 POI —— 不是关掉
 * 了，是那些数据根本不在这张图里。数据是 Natural Earth 1:50m 陆地多边形，公有领
 * 域，在 `public/basemap/` 下。
 *
 * 陆地这一份是公有领域，本身不要求署名。但**署名是开着的**，因为情报区边界用的是
 * VATSpy 的数据，CC BY-SA 4.0 —— 许可要求那行字出现在展示它的地方。加任何一个新数
 * 据源之前先看它的许可，别默认沿用上一条的结论。
 *
 * ## 绝不服务端渲染
 *
 * 规矩：`maplibre-gl` 在模块顶层就摸
 * `window`。`MapStage` 用 `defineAsyncComponent` + `mounted` 守着它 —— 改成静态
 * import，**每一个**页面都会 500（这块地图挂在外壳上，不再只是 `/route`）。
 *
 * ## 样式在 `lib/chartStyle.ts`
 *
 * 颜色、线宽、字号、缩放门槛、图层顺序全在那一个文件里，这里只把它交给 MapLibre、
 * 灌数据、切主题。符号是 `lib/chartIcons.ts` 画的。
 *
 * ## 拆成了几块
 *
 * 纯几何在 `lib/routeGeometry.ts`，底图取数在 `map/basemap.ts`，署名在
 * `map/attribution.ts`，镜头（对焦、框选、内边距）在 `map/camera.ts`。这个文件
 * 只剩构造地图、灌 source、切主题。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// eslint-disable-next-line import/no-unresolved -- Vite 的 worker 后缀，不是真实路径
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FeatureCollection } from "geojson";
import { formatLatLon } from "@/lib/mapText";
import { buildStyle, themedProperties, type Theme } from "@/lib/chartStyle";
import { registerChartIcons } from "@/lib/chartIcons";
import type { MapFocus } from "@/lib/mapBus";
import type { MapPadding } from "@/lib/panelLayout";
import {
  pointFeatures,
  routeLines,
  type RoutePoint,
} from "@/lib/routeGeometry";
import { createBasemapLoader } from "@/components/map/basemap";
import { createAttribution } from "@/components/map/attribution";
import { createCamera } from "@/components/map/camera";

/**
 * **告诉 MapLibre 它的 worker 在哪，否则整块地图是死的。**
 *
 * MapLibre 6 把 worker 拆成了独立文件（`maplibre-gl-worker.mjs`，它自己还 import
 * 一份 `maplibre-gl-shared.mjs`）。不指定时它会把 worker 内联成一个 blob 再
 * `new Worker(blobURL, {type:"module"})` —— 而那个 blob 里的相对 import 解析不
 * 到，worker 于是**起得来但永远不回话**。
 *
 * 后果非常难查，因为它不报错：GeoJSON source 的瓦片是在 worker 里处理的，worker
 * 不回话 → source 永远不就绪 → `map.on("load")` **永不触发** → 所有矢量图层都不
 * 画。而 `background` 图层不经过 worker，照画不误。屏幕上就是一块纯色，控制台一
 * 个字都没有。这正是上线后「右边一片蓝、什么都没有」的全部原因。
 *
 * `?worker&url` 是 Vite 的写法：它把 worker **打成一个独立文件**（把 shared 那
 * 份一起打进去，于是没有相对 import 要解析），并返回它的 URL。
 *
 * **验证方式是可见的**：修好之后构建产物 `dist/client/_astro/` 里会多出一个
 * worker 文件；修之前一个都没有。这条比任何截图都可靠。
 *
 * 放在模块顶层而不是 onMounted：它必须在**任何** Map 构造之前生效，而这个模块被
 * 异步 import，顶层就是最早的时机。
 */
setWorkerUrl(workerUrl);

/** 视野框，给外面按框取数据用。见 emitViewport。 */
export interface Viewport {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
}

const emit = defineEmits<{ viewport: [Viewport] }>();

const props = defineProps<{
  points: RoutePoint[];
  markers?: RoutePoint[];
  /**
   * 镜头焦点（`lib/mapBus.ts` 的 `MapFocus`）。按**引用**判断变没变：同一个对象
   * 留着不会再动镜头，新对象才会 —— 所以「定位到我」每次都造一个新的。
   */
  focus?: MapFocus | null;
  /** 面板盖住的那一块，MapStage 由 `panel:layout` 换算。 */
  padding?: MapPadding | null;
  /**
   * 航路网图层，已经转成线要素（`lib/airways.ts`）。
   *
   * 传进来的是**已经画好的形状**而不是原始的图：转换要用 `fixes` 查坐标、要丢掉
   * 端点缺失的航段，那是关于数据的处理，不是渲染 —— 放在这里会让这个组件同时懂
   * 两件事。
   */
  airways?: FeatureCollection | null;
  /** 航路点（航路网自己的点集），和 airways 一起来一起走。 */
  airwayFixes?: FeatureCollection | null;
  /**
   * 全部机场，画成跑道杠符号加 ICAO（属性见 `lib/airports.ts` 的 `toAirportPoints`）。
   *
   * 和 `markers` 不是一回事：`markers` 是「面板挑出来给你看的那几个」，这一层是
   * **底图的一部分** —— 缩放到一定程度就该有，不需要谁去点。
   */
  airports?: FeatureCollection | null;
  /** 全库跑道（线加端点），来自 can-db 的 `/aip/runways`。见 lib/runways.ts。 */
  runways?: FeatureCollection | null;
  /**
   * 计划里**真正在航路网上点亮了**的那些腿。
   *
   * 这一层据此决定 `ZOOM.airwaysHigh` 以上**由谁画**它们（航路网点亮，计划线让
   * 位），不是据此把它们丢掉 —— 丢掉的话那一级以下就没人画了，见 routeLines 上面
   * 那段。
   *
   * 是「标到的」而不是「有 via 的」：同上。
   */
  highlightedLegs?: Set<string> | null;
  /** 机场地面（滑行道、机位、等待位置、机坪），放大之后才有。见 `lib/ground.ts`。 */
  ground?: FeatureCollection | null;
  /**
   * 随数据变化的额外署名：机场地面的 ODbL 那一行。
   *
   * **和常驻的那几行一起进同一个署名控件**，不另起一块：署名被放到第二个地方，
   * 等于让人得知道该去哪儿找。空数组就是这一屏没有需要额外署名的数据。
   */
  extraAttribution?: string[];
  /** 导航台。 */
  navaids?: FeatureCollection | null;
  /** 空域多边形（扇区与限制区，按 `cls` 分色，见 `lib/aip.ts` 的 `airspaceClass`）。 */
  airspaces?: FeatureCollection | null;
  /**
   * 飞行情报区边界。
   *
   * **和 airspaces 分开一条源，不是并进去。** 两个理由，都不是洁癖：
   *
   * 一，情报区**铺满**整个区域，而 airspaces 那层带 7% 的填充 —— 铺满的东西再
   * 叠一层半透明，整张图会均匀地蒙上一层灰，越是重叠的地方越脏。情报区只画边
   * 界，一点填充都不要。
   *
   * 二，扇区和限制区是单选的叠加物（看这个就看不到那个），而情报区是常开的底
   * 子。挤进同一个单选组就意味着打开限制区会让边界消失，那正好和它该有的行为
   * 相反。
   */
  firs?: FeatureCollection | null;
  /**
   * Grid MORA 标注点，属性里带 `thousands` / `hundreds`。
   *
   * 千位百位是**两个属性**而不是一个字符串：航图上它们不是一个字号，拼好了就
   * 没法再分开排版。见 lib/mora.ts。
   */
  mora?: FeatureCollection | null;
  /** 其余在线航班。自己那架**不在**这里，见 own。 */
  traffic?: FeatureCollection | null;
  /**
   * 在线管制席位里**画成点**的那些：放行 / 地面 / 塔台，外加没能对上边界的。
   * 属性里带 `callsign`、`frequency`、`facility`。
   */
  atc?: FeatureCollection | null;
  /**
   * 在线管制里**画成范围**的那些：区域 / 进近 / FSS 管的那片空域。
   *
   * 它们管的是一块地方，不是一个点 —— datafeed 给的经纬度是管制员自己的视野中心，
   * 既不是他管的空域也不在它中间，画成点读不出归属。几何来自随站发的边界底图，按
   * 呼号前缀对上（见 `lib/atc.ts` 的 `boundaryCodesFor`）。
   */
  atcAreas?: FeatureCollection | null;
  /** 自己那架飞机，至多一个要素。 */
  own?: FeatureCollection | null;
  /** 自己这次会话的航迹，一条线（`lib/ownTrack.ts`）。 */
  ownTrack?: FeatureCollection | null;
  label: string;
  /**
   * 地图起不来时显示的两句话，**已翻译**。
   *
   * 以前这里显示的是 `failure` 里那个内部记号本身 —— 屏幕上会出现
   * `map-init-failed` 这样一串英文标识。它对使用者没有任何意义，而且四种语言的
   * 站点上都是英文，看起来像页面崩了而不是像一条说明。
   *
   * 记号仍然留在代码里（它是日志和分支用的），只是不再直接渲染：显示什么由外壳
   * 按语言给。
   */
  failureText: { init: string; webgl: string };
  /**
   * 署名里「情报区」那个词，**已翻译**。
   *
   * 以前署名整行写死成中文（「情报区 … · 陆地 Natural Earth」），英文、日文站上也
   * 挂着这两个汉字。外壳本来就给图层按钮翻好了「情报区」，这里直接复用那一条，
   * 不另开一个意思相同的键；「陆地」那个词删了 —— Natural Earth 是专名，单独署上
   * 在哪种语言里都读得懂。
   */
  firsLabel: string;
}>();

const container = ref<HTMLDivElement | null>(null);
const corners = ref({ nw: "", se: "" });

/**
 * 起不来时说出来，而不是留一块沉默的色块。
 *
 * 这个 ref 是补上来的：上一版地图起不来时，屏幕上是 `.route-map` 的容器底色，
 * 控制台一个字都没有 —— 因为 MapLibre 的错误走的是 `map.on('error')`（没接），
 * 而底图拉取失败走的是一个静默的 catch。两条路都不说话，结果是一个**看不出**
 * **原因**的故障，只能靠翻 DOM 找 canvas 在不在来定位。
 *
 * 正常运行时仍然不为装饰性底图弹提示 —— 那条判断没变。变的是「彻底起不来」和
 * 「底图这一层没拿到」现在会各自说一句话。
 */
const failure = ref<"container" | "init" | "webgl" | null>(null);

/**
 * 上面那个记号对应的**人话**，按语言来。
 *
 * `container`（容器没挂上）和 `init` 归成同一句：对使用者来说它们是同一件事
 * ——「地图没起来」——，区别只在排查时看日志。分成两句只会让人以为自己遇到的是
 * 两种不同的毛病。
 */
const failureMessage = computed(() =>
  failure.value === "webgl" ? props.failureText.webgl : props.failureText.init,
);

let map: MapLibreMap | null = null;
let themeObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
const basemap = createBasemapLoader(() => map);
const attribution = createAttribution(
  () => map,
  () => ({
    firsLabel: props.firsLabel,
    extra: props.extraAttribution ?? [],
  }),
);
const camera = createCamera(() => map);

/* **样式就绪的闸是这个标志，不是 `map.isStyleLoaded()`。**
 *
 * MapLibre 6 的 `isStyleLoaded()` 走的是 `style.loaded()`：只要有一个 source 的
 * `setData` 还没处理完、或者还有瓦片在加载，它就是 false。而这张图的 source 几乎
 * 一直在忙 —— 实时那三层每 30 秒换一次数据，底图和细节是异步灌的。于是 render()
 * 和 applyTheme() 拿它当闸，恰好在忙的那一刻进来的 prop 变化（换航路、换焦点、
 * 切主题）就**被整个丢掉**，直到下一次不相干的触发才补上，而之后没有任何东西会
 * 重试。
 *
 * 这两个函数真正需要的只是「source 和图层已经存在」。它们全都写在构造时那份手写
 * style 里，没有一个是后来 addSource/addLayer 加的，所以 style 一解析完就全在；
 * `setData` / `setPaintProperty` 自己也只要求 style 的 `_loaded`，不管 source 忙不
 * 忙。`load` 事件之后这个前提就永远成立（这里没有 setStyle），而 `load` 回调本身会
 * 按当前 props 补一次 render 和 applyTheme —— 在那之前被挡掉的调用什么也不丢，
 * 也就不需要另外挂一个重试。 */
let styleReady = false;

function theme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * 角落坐标标注：读当前视野的两个角。
 *
 * `getBounds()` 平移过日界线后给的是展开的经度（`190`），读数要折回 ±180 再判东
 * 西 —— 见 `lib/mapText.ts`。只折显示，不折发给外面的视野（见 emitViewport）。
 */
function updateCorners() {
  if (!map) return;
  const b = map.getBounds();
  corners.value = {
    nw: formatLatLon(b.getNorth(), b.getWest()),
    se: formatLatLon(b.getSouth(), b.getEast()),
  };
}

/**
 * 视野变了就说一声，让外面按框去取数据。
 *
 * **发在 `moveend` 而不是 `move`**：拖动一次会连发几十个 `move`，每个都触发一轮
 * 取数就等于把地图变成一台请求发生器。`updateCorners` 走 `move` 是因为它只读本
 * 地状态、不花钱。
 */
function emitViewport() {
  if (!map) return;
  // 视野一变就看看够不够格拉细节。它自己会挡住重复调用。
  void basemap.loadDetail();
  /* 这里**不折**经度：发出去的是 MapLibre 原样的展开值，west ≤ east 恒成立，按框
     取数的那几处（MORA 分块、视野内机场）拿到的是一个连续的区间。折回 ±180 由它们
     自己在库里处理 —— 在这里折，过日界线时 west 会大于 east，区间反而断成两截。 */
  const b = map.getBounds();
  emit("viewport", {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
    zoom: map.getZoom(),
  });
}

/**
 * 切主题。**没有手写清单**：`themedProperties` 从 `buildStyle` 里把每个图层的每个
 * paint / layout 属性列出来，这里逐个比对当前值，变了才设。新加的图层自动跟着换，
 * 以前那份手写的 `setPaintProperty` 清单漏登记过两次。
 *
 * 不随主题变的（席位色、过滤、文字）比对后原样跳过，所以席位色不会被换成平色。
 */
function applyTheme() {
  if (!map || !styleReady) return;
  for (const p of themedProperties(theme())) {
    if (!map.getLayer(p.layer)) continue;
    const current =
      p.kind === "paint"
        ? map.getPaintProperty(p.layer, p.name as never)
        : map.getLayoutProperty(p.layer, p.name as never);
    if (JSON.stringify(current) === JSON.stringify(p.value)) continue;
    if (p.kind === "paint") {
      map.setPaintProperty(p.layer, p.name as never, p.value as never);
    } else {
      map.setLayoutProperty(p.layer, p.name as never, p.value as never);
    }
  }
}

/**
 * 空集合。**一个共享常量，不是每次现造一个。**
 *
 * `?? { type: "FeatureCollection", features: [] }` 每次求值都得到一个新对象，于是
 * 下面那道「引用没变就不重传」的闸对所有空图层永远失效 —— 而关着的图层正是最常处
 * 于空状态的那些。
 */
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** 上一次真正灌给每个 source 的那份数据，按 source id。见 setSource。 */
const lastData = new Map<string, unknown>();

/**
 * 灌数据，**引用没变就跳过**。
 *
 * `render()` 一次要碰十八个 source，而它是被一个包含实时图层的 watch 触发的 ——
 * 那三层每 30 秒换一次。也就是说从前**每半分钟就把八千多条航段和十几万条地面线重
 * 新上传一遍**，尽管它们一个字都没改。MapLibre 收到 `setData` 就会重新解析并重建
 * 那一层的瓦片，几十万个点的重建是看得见的一顿。
 *
 * 判据用**引用相等**而不是深比较：上游那些集合是算好之后整个换掉的（`airways.value
 * = lines`），没有原地改的写法 —— 唯一一处原地改属性的是航段高亮，而它改完会显式
 * 换一个新对象，正是为了让这道闸放行。深比较十几万个点比重传还贵。
 */
function setSource(id: string, data: FeatureCollection | null | undefined) {
  const next = data ?? EMPTY;
  if (lastData.get(id) === next) return;
  lastData.set(id, next);
  (map?.getSource(id) as GeoJSONSource | undefined)?.setData(next);
}

/* 这两份是**算出来的**，每次 render 都会得到新对象，引用相等那道闸拦不住它们。
 * 所以按输入记一份：输入没变就直接返回上次算好的那个，连带让 setSource 也跳过。 */
let routeMemo: {
  points: unknown;
  legs: unknown;
  out: FeatureCollection;
} | null = null;
let markerMemo: {
  markers: unknown;
  points: unknown;
  out: FeatureCollection;
} | null = null;

/** 把当前 props 灌进 source。source 已经在，只换数据 —— 不重建图层。 */
function render() {
  if (!map || !styleReady) return;

  const points = props.points ?? [];
  const markers = props.markers ?? [];

  if (
    !routeMemo ||
    routeMemo.points !== props.points ||
    routeMemo.legs !== props.highlightedLegs
  ) {
    routeMemo = {
      points: props.points,
      legs: props.highlightedLegs,
      out: routeLines(points, props.highlightedLegs),
    };
  }
  setSource("route", routeMemo.out);

  if (
    !markerMemo ||
    markerMemo.markers !== props.markers ||
    markerMemo.points !== props.points
  ) {
    markerMemo = {
      markers: props.markers,
      points: props.points,
      // 航路上的点打个标记，好让标注那一层只挑它们，见 pointFeatures。
      out: pointFeatures([
        ...markers,
        ...points.map((p) => ({ ...p, onRoute: true })),
      ]),
    };
  }
  setSource("markers", markerMemo.out);

  setSource("runways", props.runways);
  setSource("airports", props.airports);
  setSource("ground", props.ground);
  setSource("airways", props.airways);
  setSource("airwayFixes", props.airwayFixes);
  setSource("navaids", props.navaids);
  setSource("airspaces", props.airspaces);
  setSource("firs", props.firs);
  setSource("mora", props.mora);
  setSource("traffic", props.traffic);
  setSource("atcAreas", props.atcAreas);
  setSource("atc", props.atc);
  setSource("ownTrack", props.ownTrack);
  setSource("own", props.own);

  if (camera.applyFocus(props.focus ?? null)) return;
  camera.fitPoints([...points, ...markers]);
}

onMounted(() => {
  // 这一条以前是静默 return，而它正是「有容器、没 canvas」那个现象的唯一出口 ——
  // MapLibre 的 canvas 在构造函数里同步创建，所以没有 canvas 就意味着构造没执行。
  if (!container.value) {
    failure.value = "container";
    console.error("[efb] 地图容器没有挂上，MapLibre 没有初始化");
    return;
  }

  // **WebGL 能不能拿到。** MapLibre 5 以后拿不到上下文会直接抛，而那正是「有容
  // 器、没 canvas」最像的原因。
  //
  // **探到的结果不用来提前返回。** 探针用的是默认属性，而 MapLibre 要的上下文属
  // 性和它不完全一样 —— 探针失败而地图其实能画是可能的，那时提前返回就是自己造
  // 了一次故障。所以只把结论记下来，等真的构造失败时用它挑一句说得准的话：
  // 「这台设备的浏览器没有 WebGL」和「地图初始化失败」对使用者是两种不同的处境，
  // 前者他能去开硬件加速，后者只能报障。
  let webglAvailable = true;
  try {
    const probe = document.createElement("canvas");
    webglAvailable = Boolean(
      probe.getContext("webgl2") ||
        probe.getContext("webgl") ||
        probe.getContext("experimental-webgl"),
    );
  } catch {
    webglAvailable = false;
  }

  try {
    map = new MapLibreMap({
      container: container.value,
      // 手写 style，不指向任何瓦片服务 —— 见文件顶上。内容在 `lib/chartStyle.ts`。
      style: buildStyle(theme()),
      center: [110, 34],
      zoom: 3,
      // 内建的那个关掉，换成下面手动加的一个 —— 要的是自己那行字（VATSpy 的
      // CC BY-SA 署名），而内建控件只会列出各 source 的 attribution 字段。
      // **署名本身不是可选的**，见文件头。
      attributionControl: false,
      // 汉字用本机字体画，不请求 glyphs —— 全套 CJK 切片是几十 MB，为几个
      // 地名背这个体积不值得。
      localIdeographFontFamily:
        'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      // 滚轮缩放恒开：地图铺满视口，页面本身不滚，不存在「滚轮停在地图上把页
      // 面卡住」那回事了。以前这里问 CSS 里三栏外壳的排布变量，那个变量随三栏外壳
      // 一起删了。
      scrollZoom: true,
    });

    map.addControl(new NavigationControl({ showCompass: false }), "top-left");
  } catch (error) {
    // WebGL 不可用、构造参数不合法都会走到这里。以前它会作为一个未捕获异常冒到
    // Vue 的生命周期里 —— 而那条路径在生产构建下未必留下任何可读的东西。
    // WebGL 拿不到是这里最常见的一种，而它对使用者是可行动的（去开硬件加速）——
    // 所以上面那个探针的结论在这里用上，挑一句说得准的话。
    failure.value = webglAvailable ? "init" : "webgl";
    console.error("[efb] MapLibre 初始化失败:", error);
    return;
  }

  // MapLibre 的样式、瓦片、数据错误**全部**从这个事件出来，不接就等于看不见。
  map.on("error", (event) => {
    console.error("[efb] 地图错误:", event.error ?? event);
  });

  // 署名。CC BY-SA 4.0 要求的，不是装饰 —— can-radar 用同一份数据，署得也是同
  // 一行。陆地那份（Natural Earth）属公有领域，一并列出是礼貌不是义务。
  //
  // **放右上角，不是默认的右下角**：右下角是 `.map-corner-se` 那个坐标读数，两
  // 个都是绝对定位、都贴着同一个角，叠在一起谁也读不清。这不是审美取舍 —— 署名
  // 被盖住就等于没署。
  attribution.apply();

  /* 比例尺。航图上判断距离靠它，而这张图没有任何别的尺度参照 —— 网格线是整度
   * 的，纬度上一度约 60 海里，经度上随纬度收窄，用它读距离会错。
   *
   * 海里：和航图、飞行计划的距离单位一致。 */
  map.addControl(
    new ScaleControl({ maxWidth: 90, unit: "nautical" }),
    "bottom-right",
  );

  /* 符号在 `load` 之前就可能被要（瓦片先于 load 解析），缺了就当场补上。
   * `registerChartIcons` 跳过已注册的，重复调无害。 */
  map.on("styleimagemissing", () => {
    if (map) registerChartIcons(map);
  });

  map.on("load", () => {
    styleReady = true;
    registerChartIcons(map!);
    // 构造时的配色是那一刻取的；`load` 之前切过主题的话，那次 applyTheme 被闸挡
    // 掉了，这里补上。
    applyTheme();
    if (props.padding) camera.setPadding(props.padding);
    render();
    updateCorners();
    emitViewport();
    void basemap.loadLand();
  });
  map.on("move", updateCorners);
  map.on("moveend", emitViewport);

  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(container.value);

  themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});

/* **每一个喂 source 的 prop 都必须在这里。**
 *
 * 之前这个 watch 只列了 points / markers / focus / airways 四个，而 `render()`
 * 会把**所有** source 一起写一遍 —— 于是其余图层只在"恰好有一次 airways 变化跟
 * 在它后面"时才画得出来。
 *
 * 静态图层因此一直是碰运气：情报区、MORA、导航台都是挂载时异步取的，能不能显示
 * 取决于它和航路网谁先回来。而实时那三层是**必然不显示**的 —— 它们每 30 秒换一
 * 次数据，之后再没有任何 airways 变化，所以飞机永远停在第一帧、管制永远不出现。
 *
 * 分成两个 watch，不是一个：
 *
 * - 上面那组小而且可能被就地修改（航路点来自事件载荷），深比是划算的。
 * - 下面那组是**每次整体替换**的要素集合。对它们深比意味着每一次实时刷新都要遍
 *   历几万个要素（光 MORA 一层就有六万多格），而它们的引用一变就说明内容变了 ——
 *   按引用比既正确又便宜。
 */
watch(() => [props.points, props.markers, props.focus], render, { deep: true });

watch(
  () => [
    props.airways,
    props.airwayFixes,
    props.ground,
    props.airports,
    props.runways,
    props.highlightedLegs,
    props.navaids,
    props.firs,
    props.mora,
    props.airspaces,
    props.traffic,
    props.atc,
    props.atcAreas,
    props.ownTrack,
    props.own,
  ],
  render,
);

/* 署名单独一个 watch，不跟着 render 走：它换的是控件不是图层数据，而 render 每
   次视野变化都会跑好几趟 —— 挂在那上面等于每拖一次地图就摘挂一次控件。 */
watch(() => [props.extraAttribution, props.firsLabel], attribution.apply, {
  deep: true,
});

/* 面板开合、抽屉拖动、换页换宽度都会改内边距。深比：MapStage 每次给的是新对象，
   而数值没变时不该再 easeTo 一次（camera 里还有一道闸）。 */
watch(
  () => props.padding,
  (padding) => {
    if (padding) camera.setPadding(padding);
  },
  { deep: true },
);

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
  styleReady = false;
  map?.remove();
  map = null;
});
</script>

<template>
  <div class="route-map-wrap">
    <div ref="container" class="route-map" role="img" :aria-label="label"></div>
    <!--
      起不来时说出来。一块沉默的色块会被当成「地图是空的」，而它其实是「地图没
      起来」—— 这两件事该长得不一样。
    -->
    <!--
      **显示人话，记号留在 `data-failure` 上。**

      原来这里直接渲染 `failure` 本身，于是屏幕上会出现 `map-init-failed` 这样一
      串英文标识 —— 当时的理由（样式那边写着）是"它是诊断标识、要能被原样搜到"，
      而那个理由本身是成立的，错的是把它摆在了给成员看的位置：四种语言的站点上都
      是这一串英文，读起来像页面崩了，而不像一条说明。

      两件事因此分开：成员读到的是按语言给的一句话，诊断要的记号在属性里（也在
      console 里），`document.querySelector('[data-failure]')` 一句就能拿到。
    -->
    <p v-if="failure" class="map-failure" :data-failure="failure">
      {{ failureMessage }}
    </p>

    <!-- 角落坐标标注：航路图上用来读当前视野范围的那两个数。 -->
    <span class="map-corner map-corner-nw">{{ corners.nw }}</span>
    <span class="map-corner map-corner-se">{{ corners.se }}</span>
  </div>
</template>
