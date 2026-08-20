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
 * 由此也不需要归属声明，`attributionControl` 关着。**这一条和「不用瓦片」绑在一
 * 起**：哪天加回任何一个瓦片源，那行字必须一起回来，否则就是违反许可。
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
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  Map as MapLibreMap,
  NavigationControl,
  LngLatBounds,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// eslint-disable-next-line import/no-unresolved -- Vite 的 worker 后缀，不是真实路径
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Feature, FeatureCollection } from "geojson";
import { arc, type LatLon } from "@/lib/geo";

/**
 * 排查用的调用轨迹。**这一批日志是临时的**，等「一片蓝、没有 canvas」定位完就该
 * 删掉 —— 它们不是产品行为，是一次故障留下的脚手架。
 *
 * 前缀统一成 `[efb:map]`，一是好在控制台里过滤，二是删的时候一搜就全在。
 *
 * 打在模块顶层的那一行有独立价值：它证明这个异步 chunk **真的被执行了**。在它之
 * 前，我们连「组件加载了没有」都只能靠翻 DOM 猜。
 */
function trace(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[efb:map] ${step}`);
  else console.log(`[efb:map] ${step}`, detail);
}

trace("module evaluated");

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
trace("worker url set", workerUrl);

interface Point {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
}

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
  label: string;
}>();

const LAND_URL = "/basemap/land-50m.json";

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
    route: "#7ab8e0",
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
  },
  light: {
    ocean: "#dde5ea",
    land: "#f4f5f3",
    landLine: "#c8d2d8",
    grid: "#cbd5db",
    route: "#2f6f9e",
    marker: "#1d4e70",
    airwayV: "#5c7180",
    airwayHigh: "#2f6f9e",
    airwayOther: "#8aa4b5",
    label: "#5a6b78",
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
const failure = ref<string | null>(null);

trace("setup");

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
      properties: { procedure: isProcedure(points[i]) ? 1 : 0 },
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
      properties: { ident: p.ident, airport: p.kind === "airport" ? 1 : 0 },
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
  map.setPaintProperty("route", "line-color", c.route);
  map.setPaintProperty("markers", "circle-color", c.marker);
  map.setPaintProperty("markers", "circle-stroke-color", c.marker);
}

/** 把当前 props 灌进 source。source 已经在，只换数据 —— 不重建图层。 */
function render() {
  trace("render", {
    hasMap: !!map,
    styleLoaded: map?.isStyleLoaded(),
    points: props.points?.length ?? 0,
    markers: props.markers?.length ?? 0,
    airways: props.airways?.features.length ?? 0,
  });
  if (!map || !map.isStyleLoaded()) return;

  const points = props.points ?? [];
  const markers = props.markers ?? [];

  (map.getSource("route") as GeoJSONSource | undefined)?.setData(
    routeLines(points),
  );
  (map.getSource("markers") as GeoJSONSource | undefined)?.setData(
    pointFeatures([...markers, ...points]),
  );
  (map.getSource("airways") as GeoJSONSource | undefined)?.setData(
    props.airways ?? { type: "FeatureCollection", features: [] },
  );
  (map.getSource("airwayFixes") as GeoJSONSource | undefined)?.setData(
    props.airwayFixes ?? { type: "FeatureCollection", features: [] },
  );

  // 视野：focus 优先 —— 「在一堆点里挑一个看」不该把用户刚才的缩放丢掉。
  if (props.focus) {
    map.easeTo({
      center: [props.focus.lon, props.focus.lat],
      zoom: Math.max(map.getZoom(), 7),
    });
    return;
  }

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
      trace("land fetch start", LAND_URL);
      const response = await fetch(LAND_URL);
      trace("land fetch done", response.status);
      if (!response.ok) return;
      landCache = await response.json();
      trace("land parsed", {
        features: (landCache as { features?: unknown[] })?.features?.length,
      });
    }
    if (!map) return;
    const source = map.getSource("land") as GeoJSONSource | undefined;
    trace("land setData", { hasSource: !!source });
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
  trace("onMounted", { hasContainer: !!container.value });

  // 这一条以前是静默 return，而它正是「有容器、没 canvas」那个现象的唯一出口 ——
  // MapLibre 的 canvas 在构造函数里同步创建，所以没有 canvas 就意味着构造没执行。
  if (!container.value) {
    failure.value = "map-container-missing";
    console.error("[efb] 地图容器没有挂上，MapLibre 没有初始化");
    return;
  }

  // 容器尺寸。为 0 的话 MapLibre 仍然会建 canvas，但什么都看不见 —— 这两种故障
  // 长得很像，所以把数字打出来分开。
  const rect = container.value.getBoundingClientRect();
  trace("container rect", { width: rect.width, height: rect.height });

  // **WebGL 能不能拿到。** MapLibre 5 以后拿不到上下文会直接抛，而那正是「有容
  // 器、没 canvas」最像的原因。这里单独探一次，不依赖 MapLibre 自己的报错。
  try {
    const probe = document.createElement("canvas");
    const gl =
      probe.getContext("webgl2") ||
      probe.getContext("webgl") ||
      probe.getContext("experimental-webgl");
    trace("webgl probe", gl ? "available" : "**unavailable**");
  } catch (error) {
    trace("webgl probe threw", error);
  }

  const c = palette();

  try {
    trace("constructing MapLibre");
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
            // 航路网压在计划航路**之下**：它是背景参考，不该盖住你正在看的那条。
            id: "airways",
            type: "line",
            source: "airways",
            paint: {
              "line-color": airwayColor(c) as never,
              "line-width": 0.7,
              "line-opacity": 0.8,
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
            },
          },
          {
            id: "route",
            type: "line",
            source: "route",
            paint: { "line-color": c.route, "line-width": 1.4 },
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
        ],
      },
      center: [110, 34],
      zoom: 3,
      attributionControl: false,
      // 汉字用本机字体画，不请求 glyphs —— 全套 CJK 切片是几十 MB，为几个
      // 地名背这个体积不值得。
      localIdeographFontFamily:
        'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      // 滚轮缩放：宽屏开、窄屏关，和上一版同一条规矩 —— 窄屏下页面会滚，滚轮停在
      // 地图上会把它卡住。
      scrollZoom: window.matchMedia("(min-width: 1024px)").matches,
    });

    trace("constructed", {
      canvas: !!map.getCanvas(),
      width: map.getCanvas()?.width,
      height: map.getCanvas()?.height,
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-left");
  } catch (error) {
    // WebGL 不可用、构造参数不合法都会走到这里。以前它会作为一个未捕获异常冒到
    // Vue 的生命周期里 —— 而那条路径在生产构建下未必留下任何可读的东西。
    failure.value = "map-init-failed";
    console.error("[efb] MapLibre 初始化失败:", error);
    return;
  }

  // MapLibre 的样式、瓦片、数据错误**全部**从这个事件出来，不接就等于看不见。
  map.on("error", (event) => {
    console.error("[efb] 地图错误:", event.error ?? event);
  });

  map.on("styledata", () => trace("styledata"));
  map.on("load", () => {
    trace("load");
    registerIcons();
    render();
    updateCorners();
    void loadLand();
  });
  map.on("move", updateCorners);

  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(container.value);

  themeObserver = new MutationObserver(applyPalette);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});

watch(() => [props.points, props.markers, props.focus, props.airways], render, {
  deep: true,
});

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
    <p v-if="failure" class="map-failure">{{ failure }}</p>

    <!-- 角落坐标标注：航路图上用来读当前视野范围的那两个数。 -->
    <span class="map-corner map-corner-nw">{{ corners.nw }}</span>
    <span class="map-corner map-corner-se">{{ corners.se }}</span>
  </div>
</template>
