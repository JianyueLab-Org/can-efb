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
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection } from "geojson";
import { arc, type LatLon } from "@/lib/geo";

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
  },
  light: {
    ocean: "#dde5ea",
    land: "#f4f5f3",
    landLine: "#c8d2d8",
    grid: "#cbd5db",
    route: "#2f6f9e",
    marker: "#1d4e70",
  },
};

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

function applyPalette() {
  if (!map || !map.isStyleLoaded()) return;
  const c = palette();
  map.setPaintProperty("ocean", "background-color", c.ocean);
  map.setPaintProperty("land", "fill-color", c.land);
  map.setPaintProperty("land-outline", "line-color", c.landLine);
  map.setPaintProperty("grid", "line-color", c.grid);
  map.setPaintProperty("route", "line-color", c.route);
  map.setPaintProperty("markers", "circle-color", c.marker);
  map.setPaintProperty("markers", "circle-stroke-color", c.marker);
}

/** 把当前 props 灌进 source。source 已经在，只换数据 —— 不重建图层。 */
function render() {
  if (!map || !map.isStyleLoaded()) return;

  const points = props.points ?? [];
  const markers = props.markers ?? [];

  (map.getSource("route") as GeoJSONSource | undefined)?.setData(
    routeLines(points),
  );
  (map.getSource("markers") as GeoJSONSource | undefined)?.setData(
    pointFeatures([...markers, ...points]),
  );

  // 视野：focus 优先 —— 「在一堆点里挑一个看」不该把用户刚才的缩放丢掉。
  if (props.focus) {
    map.easeTo({
      center: [props.focus.lon, props.focus.lat],
      zoom: Math.max(map.getZoom(), 7),
    });
    return;
  }

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
    (map.getSource("land") as GeoJSONSource | undefined)?.setData(
      landCache as FeatureCollection,
    );
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
    failure.value = "map-container-missing";
    console.error("[efb] 地图容器没有挂上，MapLibre 没有初始化");
    return;
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
          route: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
          markers: {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          },
        },
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
      // 滚轮缩放：宽屏开、窄屏关，和上一版同一条规矩 —— 窄屏下页面会滚，滚轮停在
      // 地图上会把它卡住。
      scrollZoom: window.matchMedia("(min-width: 1024px)").matches,
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

  map.on("load", () => {
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

watch(() => [props.points, props.markers, props.focus], render, { deep: true });

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
