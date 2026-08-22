<script setup lang="ts">
/**
 * 地图画布。**MapLibre GL**，不是 Leaflet —— 这一版是换库重写。
 *
 * ## 为什么换
 *
 * 这块地图要长成一张航路图：航路线、五字码航路点、导航台符号加频率、空域多边形
 * 和它们的上下限标注，全都叠在一起。Leaflet 把每个标注渲染成 DOM 节点，一屏几千
 * 个就卡；更要命的是它**没有标签避让**，密集处标注互相压成一团。MapLibre 在 GPU
 * 上画矢量，标签碰撞是它的内建能力 —— 这是换库的全部理由。
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
 * 和 Leaflet 那一版同一条规矩，理由一样硬：`maplibre-gl` 在模块顶层就摸
 * `window`。`MapSurface` 用 `defineAsyncComponent` + `mounted` 守着它 —— 改成静态
 * import，**每一个**页面都会 500（这块地图挂在外壳上，不再只是 `/route`）。
 *
 * ## 契约没变
 *
 * props 仍然是 `points`（连成线的航路）/ `markers`（只画点）/ `focus`（对镜头），
 * 和 `lib/mapBus.ts` 一一对应。换库是实现的事，通道不该跟着换。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Map as MapLibreMap,
  AttributionControl,
  NavigationControl,
  ScaleControl,
  LngLatBounds,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// eslint-disable-next-line import/no-unresolved -- Vite 的 worker 后缀，不是真实路径
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Feature, FeatureCollection } from "geojson";
import { arc, type LatLon } from "@/lib/geo";
import { FACILITY_COLORS } from "@/lib/atc";
import { altitudeRamp } from "@/lib/traffic";
import { GROUND_MIN_ZOOM } from "@/lib/ground";

/**
 * 航班按高度档取色的 MapLibre 表达式。
 *
 * 要素上带的是 `band`（第几档），分档规则在 `lib/traffic.ts` 里算好 —— 这里只做
 * 「第几档 → 什么颜色」这一步查表。分档是产品判断，写成 `step` 表达式等于把它抄成
 * 第二份。
 *
 * **和席位色不同，这一套跟主题走**：viridis 有深浅两条，切主题时要一起换（见
 * `applyTheme`）。席位色是身份编码所以不换，高度色是读数所以要在两种底色上都读得
 * 出来。
 */
function altitudeBandColor() {
  const ramp = altitudeRamp(isDark() ? "dark" : "light");
  const cases: (string | number)[] = [];
  ramp.forEach((color, band) => cases.push(band, color));
  // 兜底取最低那一档：`band` 缺失时给一个真的颜色，而不是让整条表达式失效。
  return ["match", ["get", "band"], ...cases, ramp[0]];
}

/**
 * 管制点按 `facility` 分色的 MapLibre 表达式。
 *
 * 用 `match` 而不是在 JS 里把颜色写进要素属性：颜色是显示规则，写进数据之后每 30
 * 秒刷新一次实时图层就要重算一遍几百个要素的颜色，而规则本身根本没变。
 *
 * **这批颜色不跟主题走**，和图上别的东西不一样。它们是席位的身份色（塔台红、地面
 * 绿、进近橙……），深浅两套主题下都得是同一个红 —— 换一套色就等于换一套编码，而
 * 这份编码是和 can-radar 共用的，那边的图例也照着它。
 */
function facilityCircleColor() {
  const cases: (string | number)[] = [];
  for (const [facility, color] of Object.entries(FACILITY_COLORS)) {
    cases.push(Number(facility), color);
  }
  // 末尾是兜底色：datafeed 里出现一个没见过的 facility 时画成 OBS 的灰，而不是让
  // 整条表达式失效把这一层弄没。
  return ["match", ["get", "facility"], ...cases, FACILITY_COLORS[0]];
}

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

/**
 * 外壳现在是三栏还是上下堆叠。
 *
 * **答案来自 CSS**（`globals.css` 里 `--shell-layout`，在那条媒体查询里翻面），不
 * 是这里再写一份 `matchMedia`。断点是布局的事，布局定义在 CSS；在 JS 里抄一份的下
 * 场是改断点时漏掉一处，而那种不一致不会报错，只会在某个宽度区间里表现得很怪。
 */
function shellIsColumns(): boolean {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--shell-layout")
      .trim() === "columns"
  );
}

interface Point {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
  /**
   * 这个点属于**当前这条航路**，而不是背景里那批彼此无关的点。
   *
   * 不来自事件载荷 —— `render()` 在把 points 和 markers 并进同一个 source 时打
   * 上去的。分开是因为标注只该跟着航路走：markers 里可能是全国几百个机场，给它
   * 们都标上名字就是一团糊。
   */
  onRoute?: boolean;
}

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
  points: Point[];
  markers?: Point[];
  focus?: Point | null;
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
   * 机场地面（滑行道、机位、等待位置、跑道线画），放大之后才有。
   *
   * 传进来已经是选好的那一份 —— **有分好类的要素就不带航图线画**，两者不同时画。
   * 那个取舍在 `lib/ground.ts` 里，理由也写在那儿：两份并排画等于把同一条滑行道
   * 画两遍、位置差十几米，读图的人无法判断该信哪条。
   */
  /**
   * 全部机场，画成齿轮加 ICAO。
   *
   * 和 `markers` 不是一回事：`markers` 是「面板挑出来给你看的那几个」，这一层是
   * **底图的一部分** —— 缩放到一定程度就该有，不需要谁去点。
   */
  airports?: FeatureCollection | null;
  ground?: FeatureCollection | null;
  /**
   * 随数据变化的额外署名，例如 OSM 的 ODbL 那一行。
   *
   * **和常驻的那几行一起进同一个署名控件**，不另起一块：署名被放到第二个地方，
   * 等于让人得知道该去哪儿找。空数组就是这一屏没有需要额外署名的数据。
   */
  extraAttribution?: string[];
  /** 导航台。 */
  navaids?: FeatureCollection | null;
  /** 空域多边形（扇区与限制区，按 family 分色）。 */
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
}>();

/**
 * 陆地多边形。**从 `src/` 里 `?url` 引进来，不放 `public/`**，这是一处实打实的
 * 加载优化而不是搬家：
 *
 * `public/` 下的文件拿到的是 `cache-control: public, max-age=0`，也就是**每次开
 * 页面都要重新问一遍**。走 `?url` 之后 Vite 给它内容哈希的名字并落进 `_astro/`，
 * 而 node 适配器对 `/_astro/` 下的一切发
 * `public, max-age=31536000, immutable`（`@astrojs/node` 的 `serve-static.js`
 * 里那一行）—— 浏览器因此一年之内根本不再请求这两个文件。名字带哈希，所以"缓存
 * 一年"和"换了数据立刻生效"不矛盾：换了内容就是另一个名字。
 *
 * 这个文件 1.1 MB，边界那个 634 KB。
 *
 * **量这件事要用 GET，不能用 `curl -I`。** 那个头是适配器在 `stream` 事件里设
 * 的，HEAD 请求不走那条路径 —— 用 HEAD 量会看到 `max-age=0`，从而得出"改动没生
 * 效"的错误结论。
 *
 * **边缘缓存还没解决**：线上量到的仍是 `cf-cache-status: DYNAMIC`。Cloudflare 按
 * 扩展名决定缓不缓存，`.js`/`.css` 在它的默认清单里而 `.json` 不在，所以这两个文
 * 件每次都还是回源 —— 只是回源之后浏览器会存一年。要让边缘也存，得在 Cloudflare
 * 上给 `/_astro/*` 加一条 Cache Rule，那是控制台里的事，不在这个仓库里。
 */
import LAND_URL from "@/basemap/land-50m.json?url";
/* 细一档的陆地和国界，**放大之后才拉**（见 loadDetail）。由
 * `scripts/build-basemap.mjs` 从 Natural Earth 1:10m 生成，裁到本网络覆盖的那一
 * 块并取整到四位小数 —— 全球那份是 15 MB，而缩到最小时那些细节一个像素都看不出。 */
import LAND_DETAIL_URL from "@/basemap/land-10m.json?url";
import BORDERS_URL from "@/basemap/borders-10m.json?url";

/**
 * 两套配色。深色那套按航路图来：**陆地纯黑、海洋深蓝**，线条压到刚好看得见。
 *
 * 网格线比陆地边界更淡 —— 它是刻度不是内容，抢了注意力就本末倒置。
 */
const PALETTE = {
  dark: {
    ocean: "#0a1628",
    land: "#000000",
    landLine: "#1b2836",
    grid: "#1e2a38",
    /* 国界。比海岸线暗一档、而且画成虚线 —— 政治边界在航图上从来不是主角，它只
     * 负责回答「这是哪个国家」。实线会和海岸线抢，而两者常常挨着走。 */
    border: "#2b3a4a",
    /* 生成出来的航路。**必须比航路网亮一个量级**：以前它是 #7ab8e0，而航路网
     * 的高空色是 #6fa8cc —— 同一个色系、亮度也接近，只有一倍宽度差，压在八千段
     * 网上根本认不出哪条是自己刚算出来的那条。
     *
     * 配一条深色的**衬线**（routeCasing）压在下面，这是航图和路网图的通行做法：
     * 让线自带一圈"沟"，无论它穿过什么都还分得开 —— 光加宽加亮做不到这件事。 */
    route: "#a8e6ff",
    routeCasing: "#06131f",
    marker: "#cfe4f2",
    // 航路按**代号首字母**分色，这是航图的通行约定：
    //   V           低空航路
    //   A / B / G   高空与国际航路
    //   其余        J / P / R / W 等
    // 类别就在代号里，不需要等 can-db 的 locType —— 那一列是汇编给的中文
    // 分类（「国内对外开放航路」之类），和这里的字母分类是两回事。
    airwayV: "#d8e6ef",
    airwayHigh: "#6fa8cc",
    airwayOther: "#4a6b82",
    label: "#9db4c4",
    navaid: "#e6f0f7",
    // 区域管制用浅蓝、进近用青绿、限制区用粉红 —— 照航图的惯例，几类一眼要分
    // 得开。区域和进近分成两色是因为它们本来就是两件事：一个管巡航段，一个管进
    // 离场，而且进近整个套在区域里面，同色的话嵌套处根本读不出边界。
    sector: "#5f93b5",
    approach: "#6fbfa8",
    restricted: "#d98a9a",
    // 情报区边界是**底子**，不是叠加物：偏灰，压在所有内容之下，只负责说清
    // 这一片归谁管。太亮会和航路抢，而它铺满整张图。
    fir: "#4c6478",
    // Grid MORA 用绿色，这是航图的惯例 —— 图上没有第二样东西是绿的，所以它
    // 一眼就和航路、导航台、边界分得开，哪怕挤在一起。
    mora: "#5fa86a",
    // 实时那三层。**自己那架最亮**，这是整层的重点：一眼能在满屏静态数据里找
    // 到自己。其余航班压到刚好看得见，管制席位用琥珀色 —— 图上另一个没被占用
    // 的色相。
    own: "#ffd166",
    traffic: "#8fa6b8",
    atc: "#e8934a",
    /* 机场地面，只在放大之后出现。
     *
     * **跑道最亮，其余压下去。** 放到这个尺度上时，读图的人找的是跑道 —— 滑行道
     * 和机坪是它的上下文，不是主角。机位和等待位置画成点，因为源数据里它们本来
     * 就常常只有一个点（扇区包那份有 733 个等待位置是点）。
     *
     * 和航路网那几色刻意错开色相：地面和航路会在同一个画面里同时出现，同色系会
     * 让「这条是滑行道还是航路」变成一道需要思考的题。 */
    /* 机场。**自己一个色相，和别的符号全都错开** —— 航路点、导航台是白线画，航路
     * 是蓝灰，Grid MORA 绿，自己那架琥珀，管制席位橙。紫留给机场：挤在一起时颜色
     * 就够分辨，不用先看清是三角还是齿轮。 */
    airport: "#b9a3e8",
    groundRunway: "#cdd8e0",
    groundTaxiway: "#7d8f9c",
    groundApron: "#3a4854",
    groundStand: "#9aa8b4",
    groundHold: "#d98a9a",
  },
  light: {
    ocean: "#dde5ea",
    land: "#f4f5f3",
    landLine: "#c8d2d8",
    grid: "#cbd5db",
    border: "#b3bfc7",
    route: "#0b5f96",
    routeCasing: "#ffffff",
    marker: "#1d4e70",
    airwayV: "#5c7180",
    airwayHigh: "#2f6f9e",
    airwayOther: "#8aa4b5",
    label: "#5a6b78",
    navaid: "#1d4e70",
    sector: "#4a7fa3",
    approach: "#2f8a70",
    restricted: "#b45a6d",
    fir: "#93a7b5",
    mora: "#3d7a48",
    own: "#b8860b",
    traffic: "#6b8395",
    atc: "#b8622a",
    airport: "#6b4fa8",
    groundRunway: "#4a5b68",
    groundTaxiway: "#8fa0ad",
    groundApron: "#c4cdd4",
    groundStand: "#7b8b98",
    groundHold: "#b45a6d",
  },
};

/**
 * 按代号首字母挑颜色。`slice` 取第一个字母，`match` 分三档。
 *
 * 表达式而不是在 JS 里预先算好写进 properties：颜色跟主题走，主题一变只要换这
 * 个表达式里的三个色值，不必把几千条要素重新生成一遍。
 */
function airwayColor(c: {
  airwayV: string;
  airwayHigh: string;
  airwayOther: string;
}) {
  return [
    "match",
    ["slice", ["get", "airway"], 0, 1],
    "V",
    c.airwayV,
    ["A", "B", "G"],
    c.airwayHigh,
    c.airwayOther,
  ];
}

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
let landCache: unknown = null;

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function palette() {
  return isDark() ? PALETTE.dark : PALETTE.light;
}

/**
 * 经纬网格。**生成出来的，不是一份数据文件。**
 *
 * 10° 一条：再密就在全国视野下糊成一片，再疏就失去刻度的作用。经线按纬度采样成
 * 折线而不是两点一线 —— 墨卡托上经线是直的，但换投影就不是了，采样让这一层不依
 * 赖当前投影。
 */
function graticule(): FeatureCollection {
  const features: Feature[] = [];
  for (let lon = -180; lon <= 180; lon += 10) {
    const coords: [number, number][] = [];
    for (let lat = -80; lat <= 80; lat += 5) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    const coords: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 5) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 航路线：相邻两点之间走大圆弧。 */
function routeLines(points: Point[]): FeatureCollection {
  const features: Feature[] = [];
  const isProcedure = (p: Point) => p.kind === "sid" || p.kind === "star";

  for (let i = 1; i < points.length; i++) {
    const from: LatLon = [points[i - 1].lat, points[i - 1].lon];
    const to: LatLon = [points[i].lat, points[i].lon];
    features.push({
      type: "Feature",
      // 一条腿的样式取自**它到达的那个点**：SID 的第一条腿属于 SID。这条规则和
      // can-radar 一致，改之前先看那边。
      //
      // `via` 是走这条腿用的航路代号（不在航路上时是 `DCT`），拿来沿线标注 ——
      // 航图上就是这么读一条计划的：点、航路、点。
      properties: {
        procedure: isProcedure(points[i]) ? 1 : 0,
        via: points[i].via ?? "",
      },
      geometry: {
        type: "LineString",
        coordinates: arc(from, to).map(([lat, lon]) => [lon, lat]),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function pointFeatures(points: Point[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      properties: {
        ident: p.ident,
        airport: p.kind === "airport" ? 1 : 0,
        // 是不是**这条航路上**的点。markers 这个 source 里同时装着航路的点和
        // 一批彼此无关的点（比如全国机场），只有前者该被标名字 —— 给几百个机场
        // 都标上名字就是一团糊。
        onRoute: p.onRoute ? 1 : 0,
      },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}

function fmt(lat: number, lon: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${ns}${Math.abs(lat).toFixed(1)}° ${ew}${Math.abs(lon).toFixed(1)}°`;
}

/** 角落坐标标注：读当前视野的两个角。 */
function updateCorners() {
  if (!map) return;
  const b = map.getBounds();
  corners.value = {
    nw: fmt(b.getNorth(), b.getWest()),
    se: fmt(b.getSouth(), b.getEast()),
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
  void loadDetail();
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
 * 分好类的地面要素按 `kind` 分色。
 *
 * 抽成函数是因为样式里和 `applyPalette` 里各要一份 —— 两处写两遍的话，换主题时其
 * 中一处迟早停在旧配色上，而那是看得见却查不出的那种毛病。
 */
function groundFeatureColor(c: ReturnType<typeof palette>): unknown {
  return [
    "match",
    ["get", "kind"],
    "runway",
    c.groundRunway,
    "apron",
    c.groundApron,
    "terminal",
    c.groundApron,
    "parking_position",
    c.groundStand,
    "holding_position",
    c.groundHold,
    c.groundTaxiway,
  ];
}

function groundPointColor(c: ReturnType<typeof palette>): unknown {
  return [
    "match",
    ["get", "kind"],
    "holding_position",
    c.groundHold,
    c.groundStand,
  ];
}

/**
 * 地面线宽：**把真实米数换算成像素**，随缩放走。
 *
 * 这一层从前写的是几乎不变的像素值（z12 是 0.5px、z18 才 1px）—— 线确实画出来了，
 * 但细到看不见，症状和「地面没有显示」一模一样。**这是这个网络反复记的那种坏法的
 * 又一例**：不报错、不缺数据，只是屏幕上什么也没有。
 *
 * 换算按 Web Mercator：`米/像素 ≈ 156543 · cos(纬度) / 2^zoom`。取纬度 35°（本网络
 * 覆盖区中部）算出 z12 约 31 米/像素、z18 约 0.49 米/像素。于是一条 23 米宽的滑行
 * 道在 z12 是 0.7 像素、z18 是 47 像素 —— 恰好每升一级翻一倍，正是
 * `["exponential", 2]` 在两个端点之间给出的曲线。
 *
 * 下限是必须的：低缩放上按真实宽度算出来是零点几像素，一整片地面会同时消失，而那
 * 又是一次「看起来完全正常」。`fallbackM` 是这一层缺宽度时按多少米算。
 */
function groundWidth(fallbackM: number): never {
  const w = ["case", [">", ["get", "widthM"], 0], ["get", "widthM"], fallbackM];
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    GROUND_MIN_ZOOM,
    ["max", 0.6, ["/", w, 31.3]],
    18,
    ["max", 2, ["/", w, 0.49]],
  ] as never;
}

/**
 * 常驻的那几行署名。
 *
 * VATSpy 是 CC BY-SA 4.0，**署名是许可条款不是装饰**；陆地那份（Natural Earth）
 * 属公有领域，一并列出是礼貌不是义务。
 */
const BASE_ATTRIBUTION =
  '情报区 <a href="https://github.com/vatsimnetwork/vatspy-data-project" ' +
  'target="_blank" rel="noreferrer">VATSpy</a> (CC BY-SA 4.0) · ' +
  "陆地 Natural Earth";

/** 当前挂着的署名控件。换内容时要先摘下来 —— MapLibre 没有改文案的接口。 */
let attributionControl: AttributionControl | null = null;

/**
 * 把常驻署名和随数据来的那几行拼起来挂上去。
 *
 * **放右上角，不是默认的右下角**：右下角是 `.map-corner-se` 那个坐标读数和比例
 * 尺，三个都绝对定位贴着同一个角，叠在一起谁也读不清。这不是审美取舍 —— 署名被
 * 盖住就等于没署。
 *
 * 内容变了就摘掉重挂。看着粗暴，但 MapLibre 的 AttributionControl 没有别的改法，
 * 而这件事一屏最多发生一两次（放大到一个用了 OSM 的机场时）。
 */
function applyAttribution() {
  if (!map) return;
  if (attributionControl) {
    map.removeControl(attributionControl);
    attributionControl = null;
  }
  const extra = (props.extraAttribution ?? []).filter(Boolean);
  attributionControl = new AttributionControl({
    compact: true,
    customAttribution: [BASE_ATTRIBUTION, ...extra].join(" · "),
  });
  map.addControl(attributionControl, "top-right");
}

/**
 * 航路点的三角形符号。**运行时用 canvas 画出来注册**，不引 sprite 文件。
 *
 * 一套雪碧图要两个文件（png + json）、一份构建步骤，而这里总共只有几个符号，
 * 画出来比维护那套流程便宜。`pixelRatio: 2` 让它在高分屏上不糊。
 */
function registerIcons() {
  if (!map || map.hasImage("fix-triangle")) return;
  const size = 16;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.beginPath();
  ctx.moveTo(size / 2, 2);
  ctx.lineTo(size - 2, size - 3);
  ctx.lineTo(2, size - 3);
  ctx.closePath();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  map.addImage("fix-triangle", ctx.getImageData(0, 0, size, size), {
    pixelRatio: 2,
  });

  // VOR/DME：圆圈套方框。航图上这个组合表示同址的 VOR 和 DME，两个符号分开画
  // 会占两倍面积，而它们本来就是一个台。
  const box = document.createElement("canvas");
  box.width = box.height = size;
  const bx = box.getContext("2d");
  if (!bx) return;
  bx.strokeStyle = "#ffffff";
  bx.lineWidth = 1.4;
  bx.strokeRect(2.5, 2.5, size - 5, size - 5);
  bx.beginPath();
  bx.arc(size / 2, size / 2, size / 2 - 4.5, 0, Math.PI * 2);
  bx.stroke();
  map.addImage("navaid-vordme", bx.getImageData(0, 0, size, size), {
    pixelRatio: 2,
  });

  /* 飞机。**必须按 SDF 注册**，因为这是站里唯一两个用 `icon-color` 的图层（自己
   * 那架和其余航班共用这一个图标，只有颜色和大小不同）。非 SDF 的图标 MapLibre
   * 会原样贴上去，`icon-color` 被**静默忽略** —— 结果是两层都画成白色，而且不
   * 报错。
   *
   * 机头朝上（航向 0），`icon-rotate` 直接吃 datafeed 的 `heading`，不用换算。
   * 画成实心是有意的：其余静态符号都是空心线画，实心让它一眼从图上跳出来。 */
  const air = document.createElement("canvas");
  const asize = 22;
  air.width = air.height = asize;
  const ax = air.getContext("2d");
  if (!ax) return;
  ax.fillStyle = "#ffffff";
  ax.beginPath();
  ax.moveTo(asize / 2, 1); // 机头
  ax.lineTo(asize - 3, asize - 4); // 右翼尖
  ax.lineTo(asize / 2, asize - 8); // 机腹缺口
  ax.lineTo(3, asize - 4); // 左翼尖
  ax.closePath();
  ax.fill();
  map.addImage("aircraft", ax.getImageData(0, 0, asize, asize), {
    pixelRatio: 2,
    sdf: true,
  });

  /* 机场：**齿轮**。
   *
   * 图上已经有三角形（航路点）、圆套方（VOR/DME）和实心飞机，齿轮和它们没有一处
   * 轮廓相似 —— 挤在一起时一眼分得开，那是这几个符号唯一要满足的事。
   *
   * 按 **SDF** 注册，和飞机一样：这样颜色能跟着主题走。非 SDF 的图标 MapLibre 会
   * 原样贴上去、`icon-color` 被**静默忽略**，深色底上就是一块白疙瘩。
   *
   * 中间那个孔用 `destination-out` 挖掉而不是画一个底色圆 —— 底色圆在深浅两套主题
   * 下只能对一套。 */
  /* **和航路点的三角形同尺寸**（同一个 `size`，同样 pixelRatio 2、icon-size 1）。
   * 先前是 20px 画布再乘 0.32–0.55，画出来只有三到五个像素 —— 那个尺度上它不像齿
   * 轮，像一粒脏点。同尺寸之后两个符号在图上是一样大的一对，靠形状和颜色区分。 */
  const gear = document.createElement("canvas");
  const gsize = size;
  gear.width = gear.height = gsize;
  const gx = gear.getContext("2d");
  if (!gx) return;
  /* 齿数和齿深是照**这个尺寸**调的，不是照好看调的。
   *
   * 8 个浅齿（rIn 0.74）在 8 个 CSS 像素上糊成一粒点 —— 每个齿不到一个像素。6 个
   * 深齿读得出轮廓，而中心孔放大到 0.48 让它成为一个**环**：这一页其余的静态符号
   * （三角形、圆套方）都是空心线画，实心齿轮会比它们重一档，而实心是留给自己那架
   * 飞机的强调手段。 */
  const gc = gsize / 2;
  const teeth = 6;
  const rOut = gc - 1;
  const rIn = rOut * 0.62;
  gx.fillStyle = "#ffffff";
  gx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const angle = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? rOut : rIn;
    const x = gc + Math.cos(angle) * r;
    const y = gc + Math.sin(angle) * r;
    if (i === 0) gx.moveTo(x, y);
    else gx.lineTo(x, y);
  }
  gx.closePath();
  gx.fill();
  gx.globalCompositeOperation = "destination-out";
  gx.beginPath();
  gx.arc(gc, gc, rOut * 0.48, 0, Math.PI * 2);
  gx.fill();

  map.addImage("airport-gear", gx.getImageData(0, 0, gsize, gsize), {
    pixelRatio: 2,
    sdf: true,
  });
}

function applyPalette() {
  if (!map || !map.isStyleLoaded()) return;
  const c = palette();
  map.setPaintProperty("ocean", "background-color", c.ocean);
  map.setPaintProperty("land", "fill-color", c.land);
  map.setPaintProperty("land-outline", "line-color", c.landLine);
  map.setPaintProperty("grid", "line-color", c.grid);
  map.setPaintProperty("land-detail", "fill-color", c.land);
  map.setPaintProperty("land-detail-outline", "line-color", c.landLine);
  map.setPaintProperty("borders", "line-color", c.border);
  map.setPaintProperty("airways", "line-color", airwayColor(c) as never);
  for (const id of ["airway-labels", "airway-fixes"]) {
    map.setPaintProperty(id, "text-color", c.label);
    map.setPaintProperty(id, "text-halo-color", c.ocean);
  }
  // 航路现在是四个图层（衬线 / 航路段 / 程序段 / 沿线航路名），主题一换要一起
  // 跟上 —— 漏掉哪个，那一层就停在上一套配色里。
  map.setPaintProperty("route", "line-color", c.route);
  map.setPaintProperty("route-procedure", "line-color", c.route);
  map.setPaintProperty("route-casing", "line-color", c.routeCasing);
  map.setPaintProperty("route-airways", "text-color", c.route);
  map.setPaintProperty("route-airways", "text-halo-color", c.routeCasing);
  map.setPaintProperty("route-labels", "text-color", c.marker);
  map.setPaintProperty("route-labels", "text-halo-color", c.routeCasing);
  map.setPaintProperty("markers", "circle-color", c.marker);
  map.setPaintProperty("markers", "circle-stroke-color", c.marker);

  /* 机场和地面那几层也要跟着换主题。
   *
   * **这一段是补的漏**：地面图层加进来的时候没有登记到这里，于是深浅色一切换它们
   * 就停在上一套配色里 —— 而那和「这一层没画出来」在浅色主题上长得很像（浅底上一
   * 条浅灰线基本看不见）。
   *
   * 航图线画那一层（`ground-lines`）**不在这里**，而且不该在：它用的是图上的原色
   * （`["get","rgb"]`），那是数据不是主题。 */
  map.setPaintProperty("airport-gear", "icon-color", c.airport);
  map.setPaintProperty("airport-labels", "text-color", c.airport);
  map.setPaintProperty("airport-labels", "text-halo-color", c.ocean);
  map.setPaintProperty("ground-runways", "line-color", c.groundRunway);
  map.setPaintProperty(
    "ground-features",
    "line-color",
    groundFeatureColor(c) as never,
  );
  map.setPaintProperty(
    "ground-points",
    "circle-color",
    groundPointColor(c) as never,
  );
  for (const id of [
    "ground-labels-way",
    "ground-labels-area",
    "ground-labels-runway",
    "ground-labels-spot",
  ]) {
    map.setPaintProperty(
      id,
      "text-color",
      id === "ground-labels-runway"
        ? c.groundRunway
        : id === "ground-labels-spot"
          ? c.groundStand
          : c.label,
    );
    map.setPaintProperty(id, "text-halo-color", c.ocean);
  }

  // 实时那三层也要跟着换主题，否则深浅色一切换它们就留在上一套配色里。
  //
  // **管制那两层的颜色故意不在这里换。** 它们按 `facility` 分色（见
  // `facilityCircleColor`），而席位色是身份编码、两套主题下必须是同一个红同一个
  // 绿。在这里补一句 `setPaintProperty("atc", "circle-color", …)` 会把那个表达式
  // 整个换成一个平色 —— 而且只在切主题的那一刻发生，看起来像"切一次深色管制就全
  // 变一个色"。描边和光晕仍然跟主题，它们是为了在底色上压得住，不是编码。
  map.setPaintProperty("atc", "circle-stroke-color", c.ocean);
  map.setPaintProperty("atc-labels", "text-halo-color", c.ocean);
  // 高度色带**跟主题走**（viridis 有深浅两条），和席位色不一样 —— 后者是身份编码，
  // 两套主题下必须同一个红；这一套是读数，要在两种底色上都读得出来。
  map.setPaintProperty("traffic", "icon-color", altitudeBandColor() as never);
  map.setPaintProperty(
    "traffic-labels",
    "text-color",
    altitudeBandColor() as never,
  );
  map.setPaintProperty("traffic-labels", "text-halo-color", c.ocean);
  map.setPaintProperty("own", "icon-color", c.own);
  map.setPaintProperty("own", "text-color", c.own);
  map.setPaintProperty("own", "text-halo-color", c.ocean);

  // 上面几层的颜色也一并跟上 —— 之前漏了，深浅切换后它们停在旧配色上。
  map.setPaintProperty("fir-line", "line-color", c.fir);
  map.setPaintProperty("fir-labels", "text-color", c.fir);
  map.setPaintProperty("fir-labels", "text-halo-color", c.ocean);
  map.setPaintProperty("mora-labels", "text-color", c.mora);
  map.setPaintProperty("mora-labels", "text-halo-color", c.ocean);
}

/** 上一次真正对过焦的那个点，见 render() 里的说明。 */
let lastFocus: unknown = null;
/** 上一次真的框选过的那批点的签名。见 render() 结尾。 */
let lastFitted = "";

/** 把当前 props 灌进 source。source 已经在，只换数据 —— 不重建图层。 */
function render() {
  if (!map || !map.isStyleLoaded()) return;

  const points = props.points ?? [];
  const markers = props.markers ?? [];

  (map.getSource("route") as GeoJSONSource | undefined)?.setData(
    routeLines(points),
  );
  (map.getSource("markers") as GeoJSONSource | undefined)?.setData(
    // 航路上的点打个标记，好让标注那一层只挑它们，见 pointFeatures。
    pointFeatures([
      ...markers,
      ...points.map((p) => ({ ...p, onRoute: true })),
    ]),
  );
  (map.getSource("airports") as GeoJSONSource | undefined)?.setData(
    props.airports ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("ground") as GeoJSONSource | undefined)?.setData(
    props.ground ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("airways") as GeoJSONSource | undefined)?.setData(
    props.airways ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("airwayFixes") as GeoJSONSource | undefined)?.setData(
    props.airwayFixes ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("navaids") as GeoJSONSource | undefined)?.setData(
    props.navaids ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("airspaces") as GeoJSONSource | undefined)?.setData(
    props.airspaces ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("firs") as GeoJSONSource | undefined)?.setData(
    props.firs ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("mora") as GeoJSONSource | undefined)?.setData(
    props.mora ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("traffic") as GeoJSONSource | undefined)?.setData(
    props.traffic ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("atcAreas") as GeoJSONSource | undefined)?.setData(
    props.atcAreas ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("atc") as GeoJSONSource | undefined)?.setData(
    props.atc ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("own") as GeoJSONSource | undefined)?.setData(
    props.own ?? { type: "FeatureCollection", features: [] },
  );

  /* 视野：focus 优先 —— 「在一堆点里挑一个看」不该把用户刚才的缩放丢掉。
   *
   * **只在 focus 真的换了的时候动视野。** render() 现在会被实时数据每 30 秒触发
   * 一次，而 focus 是会一直留着的：不比一下的话，每半分钟就把镜头拽回上一次对焦
   * 的那个点 —— 正在平移的人会以为地图坏了。 */
  if (props.focus) {
    if (props.focus !== lastFocus) {
      lastFocus = props.focus;
      map.easeTo({
        center: [props.focus.lon, props.focus.lat],
        zoom: Math.max(map.getZoom(), 7),
      });
    }
    return;
  }
  lastFocus = null;

  // **航路网不参与框选**：它是全国的图，把它算进去等于每次都缩到最小。视野
  // 该跟着你正在看的东西走，而不是跟着背景参考走。
  const all = [...points, ...markers];
  if (!all.length) {
    lastFitted = "";
    return;
  }

  /* **只在这批点真的换了的时候框选一次。**
   *
   * 和上面 `focus` 那道防护是同一件事，只是当时没有人踩到：`render()` 会被实时
   * 图层每 30 秒触发一次，而 `points` 从前只在用户主动做了什么之后才有值 —— 于是
   * 「每次 render 都 fitBounds」看起来没问题。
   *
   * 地图开始默认画已提交的飞行计划之后它就不成立了：概览页上那条航路一直在，于是
   * **每半分钟把镜头拽回航路**，正在平移或放大看机场的人会以为地图坏了。放大看地
   * 面的时候尤其明显 —— 刚凑近跑道就被拉回去。
   *
   * 签名用代号加坐标：同一条航路重新解析一次（对象换了、内容没变）不该重新框选。 */
  const signature = all.map((p) => `${p.ident}:${p.lat},${p.lon}`).join("|");
  if (signature === lastFitted) return;
  lastFitted = signature;

  const bounds = new LngLatBounds();
  for (const p of all) bounds.extend([p.lon, p.lat]);
  map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 0 });
}

/**
 * 细节底图（10m 陆地 + 国界）**只在放大到用得上时才拉**，而且只拉一次。
 *
 * 两个文件加起来约 2 MB。开图那个视野（z3，全国）上它们一个像素都体现不出来 ——
 * 在那儿拉等于让每一次首屏都为看不见的东西付两兆。
 *
 * 门槛 4：国界从 z4 开始画，陆地细节 z5。**按最早需要的那一层定**，否则会出现「层
 * 该显示了、数据还没到」的一两秒空窗。
 *
 * `detailPending` 挡的是并发：`moveend` 会连着触发，没有它第一次放大就会同时飞出
 * 去好几个一样的请求。失败不写 `detailLoaded`，所以下次移动会再试。
 */
let detailLoaded = false;
let detailPending = false;

async function loadDetail() {
  if (detailLoaded || detailPending || !map) return;
  if (map.getZoom() < 4) return;
  detailPending = true;
  try {
    const [land, borders] = await Promise.all([
      fetch(LAND_DETAIL_URL).then((r) => (r.ok ? r.json() : null)),
      fetch(BORDERS_URL).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (!map) return;
    if (land) {
      (map.getSource("landDetail") as GeoJSONSource | undefined)?.setData(land);
    }
    if (borders) {
      (map.getSource("borders") as GeoJSONSource | undefined)?.setData(borders);
    }
    if (land && borders) detailLoaded = true;
  } catch (error) {
    // 和底图同一条：静默降级成没有细节，但日志里留一行。
    console.error("[efb] 细节底图加载失败:", error);
  } finally {
    detailPending = false;
  }
}

async function loadLand() {
  try {
    if (!landCache) {
      const response = await fetch(LAND_URL);
      if (!response.ok) return;
      landCache = await response.json();
    }
    if (!map) return;
    const source = map.getSource("land") as GeoJSONSource | undefined;
    source?.setData(landCache as FeatureCollection);
  } catch (error) {
    // 界面上仍然静默降级成一片海 —— 为一张装饰性底图弹提示，是把噪音摆在比信息
    // 更显眼的位置，这条判断没变。
    //
    // 但**日志里必须留下一行**。上一版这里是一个空的 catch，于是「底图没画出来」
    // 成了一个完全没有线索的故障。不弹提示和不留记录是两件事。
    console.error("[efb] 底图数据加载失败:", error);
  }
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

  const c = palette();

  try {
    map = new MapLibreMap({
      container: container.value,
      // 手写 style，不指向任何瓦片服务 —— 见文件顶上。
      style: {
        version: 8,
        sources: {
          land: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          grid: { type: "geojson", data: graticule() },
          landDetail: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          borders: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          airways: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          ground: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          airports: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          airwayFixes: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          navaids: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          airspaces: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          firs: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          mora: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          traffic: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          atcAreas: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          atc: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          own: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          route: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          markers: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
        },
        // 文字要字体源，否则带 text-field 的图层**一个字都不画，而且不报错**。
        // 自备在 public/basemap/fonts/ 下，理由和许可见那里的 README。
        glyphs: "/basemap/fonts/{fontstack}/{range}.pbf",
        layers: [
          {
            id: "ocean",
            type: "background",
            paint: { "background-color": c.ocean },
          },
          {
            id: "land",
            type: "fill",
            source: "land",
            paint: { "fill-color": c.land },
          },
          {
            /* 50m 的海岸线。**到 z5 就交棒**给下面那条 10m 的 —— 两条分辨率不同的
             * 海岸线叠在一起会画出一圈毛边，而那看起来像渲染坏了。 */
            id: "land-outline",
            type: "line",
            source: "land",
            maxzoom: 5,
            paint: { "line-color": c.landLine, "line-width": 0.6 },
          },
          {
            // 细一档的陆地，盖在 50m 那层上。数据到 z5 才拉，见 loadDetail。
            id: "land-detail",
            type: "fill",
            source: "landDetail",
            minzoom: 5,
            paint: { "fill-color": c.land },
          },
          {
            id: "land-detail-outline",
            type: "line",
            source: "landDetail",
            minzoom: 5,
            paint: { "line-color": c.landLine, "line-width": 0.7 },
          },
          {
            /* 国界。**只有国与国之间那条**，海岸线不在里面（生成时就滤掉了）。
             *
             * 虚线：政治边界在航图上不是主角，而它常常和海岸线、和情报区边界挨着
             * 走 —— 三条实线并排谁也读不出来。 */
            id: "borders",
            type: "line",
            source: "borders",
            minzoom: 4,
            paint: {
              "line-color": c.border,
              "line-width": 0.8,
              "line-dasharray": [3, 2] as never,
            },
          },
          {
            id: "grid",
            type: "line",
            source: "grid",
            paint: { "line-color": c.grid, "line-width": 0.5 },
          },
          {
            /* 机场地面 —— **航图那份**（从汇编图上抠的线画）。
             *
             * `line-color` 取要素自己的 `rgb`：这一份**没有语义**，内容流里只有颜
             * 色和线宽，没有一个字说哪条是滑行道中线。硬派一个含义上去就是编造，
             * 所以照图上的原色画，读图的人看到的和纸上那张一致。
             *
             * 没有 `rgb` 的要素（也就是分好类的那一份）在这里落到 `transparent`，
             * 由下面那层按类别画 —— 两层共用一个 source，各画各的那一半。 */
            id: "ground-lines",
            type: "line",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM + 1,
            paint: {
              "line-color": [
                "coalesce",
                ["get", "rgb"],
                "transparent",
              ] as never,
              "line-width": groundWidth(1.5),
              "line-opacity": 0.85,
            },
          },
          {
            /* 跑道，**地面里最先出现的那一层**。
             *
             * 缩放阶梯：情报区 → 机场齿轮 → 航路 → **跑道** → 其余地面 → 代号。
             * 到了看得清跑道形状的尺度，跑道本身就是那张图的骨架；滑行道和机坪再
             * 早一级只会把它埋掉。 */
            id: "ground-runways",
            type: "line",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM,
            filter: [
              "all",
              ["!", ["has", "rgb"]],
              ["==", ["get", "kind"], "runway"],
            ] as never,
            paint: {
              "line-color": c.groundRunway,
              "line-width": groundWidth(45),
              "line-opacity": 0.95,
            },
          },
          {
            /* 机场地面 —— **分好类**的那份（扇区包手工做的或 OSM）。
             *
             * 按 `kind` 分色。跑道最亮：放到这个尺度上，读图的人找的就是它。
             * 认不出的类别落到滑行道色而不是藏起来 —— 源数据里将来多一个类别时，
             * 那条线仍然画得出来，只是颜色不特别。 */
            id: "ground-features",
            type: "line",
            source: "ground",
            /* **跑道不在这一层**，它在 `ground-runways`、早一级出现 —— 缩放阶梯上
             * 「机场跑道」排在「机场地面」前面。一个图层只有一个 minzoom，所以这是
             * 两层。 */
            minzoom: GROUND_MIN_ZOOM + 1,
            filter: [
              "all",
              ["!", ["has", "rgb"]],
              ["!=", ["get", "kind"], "runway"],
            ] as never,
            paint: {
              "line-color": groundFeatureColor(c) as never,
              "line-width": groundWidth(23),
              "line-opacity": 0.9,
            },
          },
          {
            /* 滑行道和跑道的**代号**，贴着线走。
             *
             * `symbol-placement: "line"` 让它跟随走向，MapLibre 的标签避让会自动
             * 把挤在一起的那些藏掉 —— 和航路代号那一层同一个做法。
             *
             * **只标有名字的。** 手工那份 30710 条要素里 6820 条带代号，OSM 那份
             * 5271 条带 `ref`；其余是真的没有名字，不是这里漏了。而航图线画那一份
             * **一个名字都没有**（它只有颜色和线宽），所以 `has` 那一条同时把它整
             * 份挡在外面 —— 不加的话 `["get","name"]` 对它求值是 null，而
             * `!= ""` 对 null 成立，于是满图都是空标签占着避让位。
             *
             * z13 才出：z12 刚够看出跑道形状，这时候铺一层代号只会盖住几何本身。 */
            id: "ground-labels-way",
            type: "symbol",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM + 2,
            filter: [
              "all",
              ["has", "name"],
              ["!=", ["get", "name"], ""],
              // **跑道不在这一层。** 它的号写在两头（`ground-labels-runway`），
              // 沿线重复是滑行道的画法。
              ["match", ["get", "kind"], ["taxiway"], true, false],
            ] as never,
            layout: {
              "symbol-placement": "line",
              "text-field": ["get", "name"] as never,
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              "text-letter-spacing": 0.05,
              // 滑行道很长，一条上重复几次才不用为了看代号来回平移。
              "symbol-spacing": 220,
            },
            paint: {
              "text-color": c.label,
              // 描边不是装饰：地面线本身密，没有这一圈底色代号会糊进线里。
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            /* 跑道号，**写在跑道两头**，和航图一样。
             *
             * 那两个点是数据层按几何算出来的（`runwayEndLabels`）：取相距最远的一
             * 对顶点当两端 —— 库里的跑道要素不都是中线，有些是跑道面的轮廓，首尾两
             * 点挨在一起 —— 再按方位角决定哪一头写哪个号。
             *
             * 比别的标注大一档、加粗：放到这个尺度上，读图的人先找的就是它。
             * `text-allow-overlap` 开着 —— 跑道号是这张图上最不该被别的标注挤掉的
             * 东西，宁可让它压住一条滑行道代号。 */
            id: "ground-labels-runway",
            type: "symbol",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM,
            filter: ["==", ["get", "kind"], "runway_end"] as never,
            layout: {
              "symbol-placement": "point",
              "text-field": ["get", "name"] as never,
              "text-font": ["Noto Sans Regular"],
              "text-size": 13,
              "text-letter-spacing": 0.1,
              "text-allow-overlap": true,
            },
            paint: {
              "text-color": c.groundRunway,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.8,
            },
          },
          {
            /* 机坪和航站楼的名字。**单独一层，因为它们是地标不是编号。**
             *
             * 分开的理由是**出现的时机**：机坪和航站楼各只有几百个、块头大，是「我
             * 在机场的哪一头」这个问题的答案，所以该和滑行道代号一起早早出现；机位
             * 号有四千个，早出一级就是一片数字糊在停机坪上。一个图层只有一个
             * `minzoom`，所以这是两件事，不是一件事的两种样式。
             *
             * 线上带名字的：机坪 406、航站楼 329。 */
            id: "ground-labels-area",
            type: "symbol",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM + 2,
            filter: [
              "all",
              ["has", "name"],
              ["!=", ["get", "name"], ""],
              ["match", ["get", "kind"], ["apron", "terminal"], true, false],
            ] as never,
            layout: {
              "symbol-placement": "point",
              "text-field": ["get", "name"] as never,
              "text-font": ["Noto Sans Regular"],
              "text-size": 11,
              "text-letter-spacing": 0.08,
              "text-transform": "uppercase",
            },
            paint: {
              "text-color": c.label,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            /* 机位号和等待位置代号，**贴着那个位置**而不是沿线走。
             *
             * 用 `"point"` 而不是 `"line"`：这两类里既有真的单点（等待位置、一部分
             * 机位），也有画成短线的机位 —— 沿线排一个两位数的机位号既排不下也读不
             * 出方向。
             *
             * z15 才出，比滑行道晚两级：首都 352 个机位，早出一级就是一片数字糊在
             * 停机坪上。真要一个个看，那个尺度本来也已经凑得很近了。 */
            id: "ground-labels-spot",
            type: "symbol",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM + 4,
            filter: [
              "all",
              ["has", "name"],
              ["!=", ["get", "name"], ""],
              [
                "match",
                ["get", "kind"],
                ["parking_position", "holding_position"],
                true,
                false,
              ],
            ] as never,
            layout: {
              "symbol-placement": "point",
              "text-field": ["get", "name"] as never,
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              // 机位号密，允许它被挤掉而不是彼此叠着画。
              "text-allow-overlap": false,
            },
            paint: {
              "text-color": c.groundStand,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            /* 单点要素：等待位置和一部分机位本来就是一个点，不是退化的线。
             *
             * 扇区包那份里有 733 个等待位置是点 —— 只画线的话它们会整批消失，而
             * 等待位置恰恰是地面上最该看见的东西之一。 */
            id: "ground-points",
            type: "circle",
            source: "ground",
            minzoom: GROUND_MIN_ZOOM + 2,
            filter: ["==", ["geometry-type"], "Point"] as never,
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                13,
                1.5,
                17,
                4,
              ] as never,
              "circle-color": groundPointColor(c) as never,
              "circle-opacity": 0.9,
            },
          },
          {
            /* 有人上席的空域，**填充**。
             *
             * 排在情报区边界**之前**（也就是压在它下面），和所有线之下 —— 它是一
             * 大片色块，盖在线上会把线糊掉，而它要表达的只是"这一片现在有人管"。
             *
             * 透明度 0.08 是刻意压得很低的：一个区域席位覆盖的是整个情报区，填得
             * 再深一点，全图就会均匀蒙上一层，越是几个席位重叠的地方越脏。真正说
             * 明边界在哪的是下面那条描边。
             *
             * 颜色按席位分，和列表、和点那一层共用 `lib/atc.ts` 的同一份色表。 */
            id: "atc-area-fill",
            type: "fill",
            source: "atcAreas",
            paint: {
              "fill-color": facilityCircleColor() as never,
              "fill-opacity": 0.08,
            },
          },
          {
            /* 同一块空域的描边。**这条才是"边界在哪"的答案**，填充只负责让人一眼
             * 看到有这么一片。比情报区那条虚线粗、而且是实线 —— 两者会重叠，重叠
             * 时该让人看出这一块和旁边没人管的不一样。 */
            id: "atc-area-line",
            type: "line",
            source: "atcAreas",
            paint: {
              "line-color": facilityCircleColor() as never,
              "line-width": 1.6,
              "line-opacity": 0.9,
            },
          },
          {
            // 情报区边界紧贴网格之上、所有内容之下 —— 它是底子。
            //
            // **虚线是航图的惯例**，不是装饰：实线在这张图上已经归航路和海岸
            // 线了，边界再用实线，三者在缩小时会混成一片。
            id: "fir-line",
            type: "line",
            source: "firs",
            paint: {
              "line-color": c.fir,
              "line-width": 1.1,
              "line-dasharray": [5, 3],
              "line-opacity": 0.75,
            },
          },
          {
            // 空域在最底层：它是一大片填充，压在任何线之上都会把线糊掉。
            id: "airspace-fill",
            type: "fill",
            source: "airspaces",
            paint: {
              "fill-color": [
                "match",
                ["get", "cls"],
                "restricted",
                c.restricted,
                "app",
                c.approach,
                c.sector,
              ] as never,
              // 半透明，而且很淡 —— 它是背景，不是内容。
              "fill-opacity": 0.07,
            },
          },
          {
            id: "airspace-line",
            type: "line",
            source: "airspaces",
            paint: {
              "line-color": [
                "match",
                ["get", "cls"],
                "restricted",
                c.restricted,
                "app",
                c.approach,
                c.sector,
              ] as never,
              "line-width": 0.9,
              "line-opacity": 0.85,
            },
          },
          {
            // 代号 + 垂直范围，落在多边形的中心。symbol 图层遇到面要素会自己取
            // 中心点，不必预先算。
            id: "airspace-labels",
            type: "symbol",
            source: "airspaces",
            minzoom: 5,
            layout: {
              "text-field": [
                "concat",
                ["get", "code"],
                "\n",
                ["get", "vertical"],
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 9,
              "text-line-height": 1.1,
            },
            paint: {
              "text-color": c.label,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.2,
            },
          },
          {
            /* 机场：齿轮加 ICAO。
             *
             * **缩放阶梯上它排在情报区之后、航路之前**（见 ZOOM 那段注释）：把地图
             * 缩到最小时只剩情报区，再放一级才是「这一片有哪些机场」—— 那是从大往
             * 小看时第一个有用的问题，而航路网在那个尺度上只是一团灰雾。
             *
             * 齿轮和文字分两层：z5 先出符号，z6 才出代号。四百多个机场的代号在 z5
             * 上根本排不下，而「这儿有个机场」本身已经是信息。 */
            id: "airport-gear",
            type: "symbol",
            source: "airports",
            minzoom: 5,
            layout: {
              "icon-image": "airport-gear",
              // 和 `airway-fixes` 的三角形一样：1。两个符号一样大。
              "icon-size": 1,
              "icon-allow-overlap": true,
            },
            paint: { "icon-color": c.airport as never },
          },
          {
            id: "airport-labels",
            type: "symbol",
            source: "airports",
            minzoom: 6,
            layout: {
              "text-field": ["get", "icao"] as never,
              "text-font": ["Noto Sans Regular"],
              "text-size": [
                "interpolate",
                ["linear"],
                ["zoom"],
                6,
                9,
                11,
                12,
              ] as never,
              "text-offset": [0, 1.1],
              "text-anchor": "top",
              "text-letter-spacing": 0.05,
            },
            paint: {
              "text-color": c.airport,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            // 航路网压在计划航路**之下**：它是背景参考，不该盖住你正在看的那条。
            id: "airways",
            minzoom: 6,
            type: "line",
            source: "airways",
            paint: {
              "line-color": airwayColor(c) as never,
              /* **随缩放变粗变实**，不是一个定值。
               *
               * 覆盖框内是八千多个航段。在开图那个视野（z3，全国）上，八千条
               * 0.7px 的线彼此间距只有几个像素 —— 画出来不是一张航路网，是一片
               * 灰雾，底下的海岸线和边界全被它盖住。
               *
               * 但也不该在低缩放直接藏掉：「这一带有航路网」本身就是信息，而且
               * 藏了之后放大时会突然长出一张网。所以让它淡下去而不是消失，到
               * z6（一度约 91px）恢复成正常的航图线宽。 */
              /* 淡入曲线跟着 minzoom 挪到 6 起 —— 原来是 3 起，而 3–6 那一段现在
               * 根本不画，留着就是一段死表达式，下一个人会以为它还在生效。 */
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                6,
                0.5,
                9,
                1.1,
              ] as never,
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                6,
                0.45,
                9,
                0.85,
              ] as never,
            },
          },
          {
            // 航路代号，贴着线走。`symbol-placement: line` 让它跟随走向，而
            // MapLibre 的标签避让会自动把挤在一起的那些藏掉 —— 这正是当初从
            // Leaflet 换过来的理由。
            id: "airway-labels",
            type: "symbol",
            source: "airways",
            minzoom: 8,
            layout: {
              "symbol-placement": "line",
              "text-field": ["get", "airway"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 9,
              "text-letter-spacing": 0.05,
              "symbol-spacing": 300,
            },
            paint: {
              "text-color": c.label,
              // 描边不是装饰：白字压在浅色陆地上会糊，这一圈底色让它在两种主题
              // 下都读得出来。
              "text-halo-color": c.ocean,
              "text-halo-width": 1.2,
            },
          },
          {
            // 航路点。三角形图标是运行时用 canvas 画出来注册的（见 addImage），
            // 不引 sprite —— 为四五个符号挂一套雪碧图不划算。
            /* 名字比三角形**晚一档**出现（见下面的 text-opacity）。
             *
             * 航路网自己的点集有五千多个。z5 上一度是 45px，五个字母的代号大约
             * 40px 宽 —— 挨着的两个点必然打架，于是避让会丢掉大部分名字，屏幕上
             * 剩下一批看起来随机的标注。三角形本身很小，那一档先画出来说明「这
             * 里有一个航路点」，名字等放到读得出的比例尺再出现。 */
            id: "airway-fixes",
            type: "symbol",
            source: "airwayFixes",
            minzoom: 8,
            layout: {
              "icon-image": "fix-triangle",
              "icon-size": 1,
              "icon-allow-overlap": true,
              "text-field": ["get", "ident"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 9,
              "text-offset": [0, 0.9],
              "text-anchor": "top",
            },
            paint: {
              "text-color": c.label,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.2,
              // 名字在 z6 才出现，三角形从 z5 就在。见上面那段注释。
              "text-opacity": ["step", ["zoom"], 0, 6, 1] as never,
            },
          },
          {
            // 导航台。圆圈套方框是航图上 VOR/DME 的画法，符号同样是运行时画的。
            id: "navaids",
            type: "symbol",
            source: "navaids",
            minzoom: 5,
            layout: {
              "icon-image": "navaid-vordme",
              "icon-size": 1,
              "icon-allow-overlap": true,
              "text-field": ["get", "label"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 9,
              "text-offset": [0, 1.1],
              "text-anchor": "top",
            },
            paint: {
              "text-color": c.navaid,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.2,
            },
          },
          {
            // Grid MORA：千位大、百位小，这是航图上的画法。
            //
            // `format` 的分段 `font-scale` 是唯一能在一个标注里换字号的办法。
            // 基线是对齐的，所以小字自然坐在下方 —— 正好是要的下标样子。
            //
            /* **minzoom 5.5**，不是 4。
             *
             * 一度格子的像素宽是 `360 / (512 · 2^z)` 的倒数：z4 是 22.8px，z5 是
             * 45.5px，z5.5 是 64px。而一个「31¹」样式的标注在 11px 字号下大约
             * 20px 宽，还要留出不贴着邻格的余量。
             *
             * z4 上放不下的后果不是"挤"，是**避让会丢掉大部分格子** —— 而一张只
             * 填了一部分的 MORA 网格比不画更糟：读图的人会把空格当成"这里没有数
             * 据"，而不是"这里的数字被挤掉了"。要么整片都在，要么整片都不在。 */
            id: "mora-labels",
            type: "symbol",
            source: "mora",
            minzoom: 5.5,
            layout: {
              "text-field": [
                "format",
                ["get", "thousands"],
                {},
                ["get", "hundreds"],
                { "font-scale": 0.68 },
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 11,
              // 让开航路和导航台：它们是内容，这是背景参考。
              "text-allow-overlap": false,
              "text-ignore-placement": false,
            },
            paint: {
              "text-color": c.mora,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            // 情报区名字**沿着边界重复**（symbol-placement: line），而不是落在
            // 多边形中心 —— 情报区大到中心点常常在几百海里之外，那个位置的标注
            // 对着屏幕上的边界说不出话。这也是纸质航图的画法。
            //
            // 排在导航台**之后**：MapLibre 的符号避让按图层顺序定优先级，靠前
            // 的赢。边界名是背景信息，撞上导航台时该让它。
            id: "fir-labels",
            type: "symbol",
            source: "firs",
            minzoom: 4,
            layout: {
              "symbol-placement": "line",
              "symbol-spacing": 400,
              "text-field": ["get", "code"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              "text-letter-spacing": 0.12,
              "text-max-angle": 30,
            },
            paint: {
              "text-color": c.fir,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            /* 衬线：比主线宽，深色，压在它下面。见配色里 routeCasing 那段。 */
            id: "route-casing",
            type: "line",
            source: "route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": c.routeCasing,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                4,
                8,
                6.5,
              ] as never,
              "line-opacity": 0.9,
            },
          },
          {
            /* 航路段和程序段分成**两个图层**，靠 filter 分，而不是用一个
             * `case` 表达式去喂 `line-dasharray`。
             *
             * 表达式那条路在这个版本的规范里其实是允许的（`line-dasharray` 是
             * `cross-faded-data-driven`，参数含 feature，查过），但"实线"得写成
             * `[1, 0]` —— 一个零长度的间隔。那是个赌运气的写法：规范没说零间隔
             * 该怎么画，而画错的样子是整条线变成一串点，还不报错。两个图层没有
             * 这种含糊。 */
            id: "route",
            type: "line",
            source: "route",
            filter: ["!=", ["get", "procedure"], 1],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": c.route,
              // 比航路网粗一倍以上，而且随缩放一起长 —— 缩小时它仍然要是图上最
              // 显眼的那条线，那正是缩小时最难做到的。
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                2,
                8,
                3.4,
              ] as never,
            },
          },
          {
            /* 程序段（SID/STAR）画虚线：它们是"按图走"的部分，和航路段不是一回
             * 事，航图上也这么分。 */
            id: "route-procedure",
            type: "line",
            source: "route",
            filter: ["==", ["get", "procedure"], 1],
            layout: { "line-cap": "butt", "line-join": "round" },
            paint: {
              "line-color": c.route,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                2,
                8,
                3.4,
              ] as never,
              "line-dasharray": [2, 1.5],
            },
          },
          {
            /* 沿着航路标航路代号。航图上读一条计划就是"点—航路—点"，只画线不
             * 说走哪条，等于把这条航路里一半的信息藏起来了。
             *
             * `symbol-placement: line` 让它贴着线走；间距给得大一些，因为一条
             * 腿往往横跨半个屏幕，重复太密反而吵。 */
            id: "route-airways",
            type: "symbol",
            source: "route",
            minzoom: 4,
            filter: ["!=", ["get", "via"], ""],
            layout: {
              "symbol-placement": "line",
              "symbol-spacing": 220,
              "text-field": ["get", "via"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              "text-letter-spacing": 0.08,
              "text-max-angle": 25,
              "text-offset": [0, -0.9],
            },
            paint: {
              "text-color": c.route,
              "text-halo-color": c.routeCasing,
              "text-halo-width": 1.6,
            },
          },
          {
            // 管制席位。圆点加「呼号 频率」——**频率是飞行员真正要的那一样**，
            // 所以它和呼号一起进标注，而不是等人去点。
            id: "atc",
            type: "circle",
            source: "atc",
            paint: {
              "circle-radius": 4,
              // **按席位分色，不再是一律琥珀。** 以前这一层所有点同一个颜色，塔台
              // 和区域在图上分不开 —— 而对飞行员那是"我现在该叫谁"和"我巡航时该
              // 叫谁"的区别。色表在 `lib/atc.ts`，列表和这里共用一份。
              "circle-color": facilityCircleColor() as never,
              "circle-stroke-width": 1,
              "circle-stroke-color": c.ocean,
            },
          },
          {
            id: "atc-labels",
            type: "symbol",
            source: "atc",
            layout: {
              "text-field": [
                "concat",
                ["get", "callsign"],
                "  ",
                ["get", "frequency"],
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              "text-offset": [0, 1.1],
              "text-anchor": "top",
            },
            paint: {
              // 标注和点用同一个席位色 —— 点是红的、字是琥珀的，会让人以为那是两
              // 样东西。
              "text-color": facilityCircleColor() as never,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            /* 有人上席的空域，标上是谁、频率多少。
             *
             * `symbol-placement: "line"` 让字**沿着边界走**而不是堆在多边形中心：
             * 一个区域席位覆盖整个情报区，中心那一点往往在荒无人烟的地方，而且几
             * 个嵌套的空域中心会叠在一起。沿边走还有一个好处 —— 它天然回答了"这
             * 条边界是谁的"。
             *
             * 和情报区那层的名字（`fir-labels`）用同一种放法，但排在它**之后**，
             * 所以重叠时保留的是这一条：有人管的席位比一个静态的区名要紧。 */
            id: "atc-area-labels",
            type: "symbol",
            source: "atcAreas",
            minzoom: 4,
            layout: {
              "symbol-placement": "line",
              "symbol-spacing": 500,
              "text-field": [
                "concat",
                ["get", "callsign"],
                "  ",
                ["get", "frequency"],
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              "text-letter-spacing": 0.08,
              "text-max-angle": 30,
            },
            paint: {
              "text-color": facilityCircleColor() as never,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.6,
            },
          },
          {
            // 其余在线航班：小三角，按航向转。**没有标注** —— 满屏呼号会把航图
            // 盖掉，而"别人在哪"这件事看点就够了。
            /* 其余在线航班。
             *
             * **按高度分色**（`lib/traffic.ts` 的 viridis 色带，和 can-radar 同一
             * 套）。以前整层是一个颜色，只看得出"有人在"；分色之后一眼分得出谁在爬
             * 升、谁在巡航 —— 而那正是看这一层的目的。
             *
             * **地面上的画小一号、压淡。** 一个大机场停着几十架飞机全叠在一个点
             * 上，会把周围的航路和航路点整片糊掉，而"谁停在机坪上"是这张图上最不需
             * 要的信息。不是隐藏：它们仍然在，只是让位。 */
            id: "traffic",
            type: "symbol",
            source: "traffic",
            layout: {
              "icon-image": "aircraft",
              /* 尺寸 = 随缩放的基准 × 在不在地面。
               *
               * **底图是 22px 画布、`pixelRatio: 2`**，所以 `icon-size: 1` 只画出
               * 11 CSS px。原来在飞的是 0.62，也就是**不到 7px** —— 一个三角形在
               * 那个尺寸上基本只是个点，看不出机头朝哪儿。
               *
               * 随缩放变而不是给一个定值：全国视野下几十架大图标会糊成一团，而放
               * 大到看一个机场周围时恰恰要看清朝向。三个锚点覆盖了这张图的常用范
               * 围（4 是全国、7 是一个情报区、10 是一个终端区）。
               *
               * **`interpolate` 必须是最外层，`case` 放进取值里。** 上一版写成了
               * `["*", ["interpolate", …], ["case", …]]`，而 MapLibre 要求
               * `["zoom"]` 只能作为**顶层** step/interpolate 的输入 —— 包进乘法之
               * 后整个 style 校验失败，这一层和下面 own 那层一起不画。它不抛异常，
               * 只从 `map.on("error")` 出来一行 console，所以在浏览器之外看不见：
               * lint 和 build 都当它是普通数组。`atc.test.ts` 现在拿真的表达式解析
               * 器钉住这一条。
               *
               * 地面那一档因此写进每个锚点（×0.65），不是再乘一次。 */
              "icon-size": [
                "interpolate",
                ["linear"],
                ["zoom"],
                4,
                ["case", ["==", ["get", "onGround"], 1], 0.52, 0.8],
                7,
                ["case", ["==", ["get", "onGround"], 1], 0.68, 1.05],
                10,
                ["case", ["==", ["get", "onGround"], 1], 0.88, 1.35],
              ],
              "icon-rotate": ["get", "heading"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
            },
            paint: {
              "icon-color": altitudeBandColor() as never,
              "icon-opacity": [
                "case",
                ["==", ["get", "onGround"], 1],
                0.45,
                1,
              ] as never,
            },
          },
          {
            /* 航班标注：呼号加高度层。
             *
             * **放大到 7 级才出现**，而且地面上的不标。以前这一层完全没有标注，理由
             * 是"满屏呼号会把航图盖掉" —— 那句话在全国视野下是对的，但放大到看一个
             * 机场周围的时候，"那架是谁、在什么高度"恰恰是要知道的，而 MapLibre 自
             * 带碰撞检测，密的地方它会自己让位。
             *
             * `icon-allow-overlap` 只给了图标，没给文字：飞机符号该全画出来（它是位
             * 置），标注可以互相挤掉（它是补充）。 */
            id: "traffic-labels",
            type: "symbol",
            source: "traffic",
            minzoom: 7,
            filter: ["!=", ["get", "onGround"], 1],
            layout: {
              "text-field": [
                "concat",
                ["get", "callsign"],
                "  ",
                ["get", "level"],
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 9,
              "text-offset": [0, 1.2],
              "text-anchor": "top",
            },
            paint: {
              "text-color": altitudeBandColor() as never,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.4,
            },
          },
          {
            // 自己那架。大一号、最亮、**永远画在最上面**，而且带呼号高度地速。
            id: "own",
            type: "symbol",
            source: "own",
            layout: {
              "icon-image": "aircraft",
              /* 跟着 traffic 一起提，**而且必须比它大**。
               *
               * 这一层原来是定值 1，而 traffic 提到 z7 上的 1.05 之后，自己那架反
               * 而会比别人小 —— 「大一号」那句话就成了假的。所以用同一条缩放曲线，
               * 每个锚点都是 traffic 在飞那一档的 1.35 倍。
               *
               * **1.35 直接乘进锚点，不写成 `["*", …]`** —— 同 traffic 那段的理由：
               * `["zoom"]` 只能作为顶层 interpolate 的输入。 */
              "icon-size": [
                "interpolate",
                ["linear"],
                ["zoom"],
                4,
                1.08,
                7,
                1.42,
                10,
                1.82,
              ],
              "icon-rotate": ["get", "heading"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
              "text-field": [
                "concat",
                ["get", "callsign"],
                "\n",
                ["to-string", ["get", "altitude"]],
                "ft  ",
                ["to-string", ["get", "groundspeed"]],
                "kt",
              ],
              "text-font": ["Noto Sans Regular"],
              "text-size": 11,
              "text-offset": [0, 1.4],
              "text-anchor": "top",
              "text-line-height": 1.1,
              // 自己那架的标注**不参与避让**：它被别的标注挤掉就等于这一层白做了。
              "text-allow-overlap": true,
              "text-ignore-placement": true,
            },
            paint: {
              "icon-color": c.own,
              "text-color": c.own,
              "text-halo-color": c.ocean,
              "text-halo-width": 1.6,
            },
          },
          {
            id: "markers",
            type: "circle",
            source: "markers",
            paint: {
              "circle-color": c.marker,
              "circle-radius": ["case", ["==", ["get", "airport"], 1], 4, 2.5],
              "circle-stroke-color": c.marker,
              "circle-stroke-width": 0.8,
              "circle-opacity": [
                "case",
                ["==", ["get", "airport"], 1],
                1,
                0.45,
              ],
            },
          },
          {
            /* 航路点的名字。**只标这条航路上的点**（filter 见下），理由写在
             * Point.onRoute 上面。
             *
             * 标注不参与避让：这条航路是用户刚刚亲手算出来的东西，它的点名被背景
             * 里的导航台或航路点标注挤掉，是这张图上最说不通的一种让路。 */
            id: "route-labels",
            type: "symbol",
            source: "markers",
            filter: ["==", ["get", "onRoute"], 1],
            layout: {
              "text-field": ["get", "ident"],
              "text-font": ["Noto Sans Regular"],
              "text-size": 10,
              "text-offset": [0, 0.8],
              "text-anchor": "top",
              "text-allow-overlap": true,
              "text-ignore-placement": true,
            },
            paint: {
              "text-color": c.marker,
              "text-halo-color": c.routeCasing,
              "text-halo-width": 1.6,
            },
          },
        ],
      },
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
      // 滚轮缩放：三栏排布下开，堆叠排布下关 —— 堆叠时页面是会滚的，滚轮停在地
      // 图上会把它卡住。
      //
      // **问 CSS，不再自己写一份断点。** 以前这里是
      // `matchMedia("(min-width: 1024px)")`，和 globals.css 里的媒体查询各写一
      // 份 —— 而断点一改（正是这次，1024 → 1152），两份就分叉了，表现是某个宽度
      // 区间里滚轮把页面卡住，而那是没人查得到的那种毛病。现在断点只有媒体查询
      // 里一个定义处，它翻 `--shell-layout`，这里读它。
      scrollZoom: shellIsColumns(),
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
  applyAttribution();

  /* 比例尺。航图上判断距离靠它，而这张图没有任何别的尺度参照 —— 网格线是整度
   * 的，纬度上一度约 60 海里，经度上随纬度收窄，用它读距离会错。
   *
   * 公制单位：这张网络的高度用英尺、距离用海里，但比例尺是给"这一段大概多远"用
   * 的目测参照，而 MapLibre 的 `nautical` 单位在小比例尺下会给出 0.5 海里这种刻
   * 度。米/公里的刻度更好读，也不会被误当成航图上的精确距离。 */
  map.addControl(
    new ScaleControl({ maxWidth: 90, unit: "metric" }),
    "bottom-right",
  );

  map.on("load", () => {
    registerIcons();
    render();
    updateCorners();
    emitViewport();
    void loadLand();
  });
  map.on("move", updateCorners);
  map.on("moveend", emitViewport);

  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(container.value);

  themeObserver = new MutationObserver(applyPalette);
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
    props.navaids,
    props.firs,
    props.mora,
    props.airspaces,
    props.traffic,
    props.atc,
    props.atcAreas,
    props.own,
  ],
  render,
);

/* 署名单独一个 watch，不跟着 render 走：它换的是控件不是图层数据，而 render 每
   次视野变化都会跑好几趟 —— 挂在那上面等于每拖一次地图就摘挂一次控件。 */
watch(() => props.extraAttribution, applyAttribution, { deep: true });

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
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
