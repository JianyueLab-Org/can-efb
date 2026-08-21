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
  /** 在线管制席位，属性里带 `callsign` 和 `frequency`。 */
  atc?: FeatureCollection | null;
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
  },
  light: {
    ocean: "#dde5ea",
    land: "#f4f5f3",
    landLine: "#c8d2d8",
    grid: "#cbd5db",
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
}

function applyPalette() {
  if (!map || !map.isStyleLoaded()) return;
  const c = palette();
  map.setPaintProperty("ocean", "background-color", c.ocean);
  map.setPaintProperty("land", "fill-color", c.land);
  map.setPaintProperty("land-outline", "line-color", c.landLine);
  map.setPaintProperty("grid", "line-color", c.grid);
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

  // 实时那三层也要跟着换主题，否则深浅色一切换它们就留在上一套配色里。
  //
  // **管制那两层的颜色故意不在这里换。** 它们按 `facility` 分色（见
  // `facilityCircleColor`），而席位色是身份编码、两套主题下必须是同一个红同一个
  // 绿。在这里补一句 `setPaintProperty("atc", "circle-color", …)` 会把那个表达式
  // 整个换成一个平色 —— 而且只在切主题的那一刻发生，看起来像"切一次深色管制就全
  // 变一个色"。描边和光晕仍然跟主题，它们是为了在底色上压得住，不是编码。
  map.setPaintProperty("atc", "circle-stroke-color", c.ocean);
  map.setPaintProperty("atc-labels", "text-halo-color", c.ocean);
  map.setPaintProperty("traffic", "icon-color", c.traffic);
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
  if (!all.length) return;
  const bounds = new LngLatBounds();
  for (const p of all) bounds.extend([p.lon, p.lat]);
  map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 0 });
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
          airways: {
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
            id: "land-outline",
            type: "line",
            source: "land",
            paint: { "line-color": c.landLine, "line-width": 0.6 },
          },
          {
            id: "grid",
            type: "line",
            source: "grid",
            paint: { "line-color": c.grid, "line-width": 0.5 },
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
            // 航路网压在计划航路**之下**：它是背景参考，不该盖住你正在看的那条。
            id: "airways",
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
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                0.4,
                6,
                0.7,
                9,
                1.1,
              ] as never,
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3,
                0.35,
                6,
                0.8,
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
            minzoom: 5,
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
            minzoom: 5,
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
            // 其余在线航班：小三角，按航向转。**没有标注** —— 满屏呼号会把航图
            // 盖掉，而"别人在哪"这件事看点就够了。
            id: "traffic",
            type: "symbol",
            source: "traffic",
            layout: {
              "icon-image": "aircraft",
              "icon-size": 0.6,
              "icon-rotate": ["get", "heading"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
            },
            paint: { "icon-color": c.traffic },
          },
          {
            // 自己那架。大一号、最亮、**永远画在最上面**，而且带呼号高度地速。
            id: "own",
            type: "symbol",
            source: "own",
            layout: {
              "icon-image": "aircraft",
              "icon-size": 1,
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
  map.addControl(
    new AttributionControl({
      compact: true,
      customAttribution:
        '情报区 <a href="https://github.com/vatsimnetwork/vatspy-data-project" ' +
        'target="_blank" rel="noreferrer">VATSpy</a> (CC BY-SA 4.0) · ' +
        "陆地 Natural Earth",
    }),
    "top-right",
  );

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
    props.navaids,
    props.firs,
    props.mora,
    props.airspaces,
    props.traffic,
    props.atc,
    props.own,
  ],
  render,
);

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
