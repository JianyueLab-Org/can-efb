<script setup lang="ts">
/**
 * 航路地图。把 `/api/v1/route` 展开出来的点画成一条线。
 *
 * **这个组件永远不在服务端渲染。** Leaflet 在模块顶层就摸 `window`，SSR 会直接
 * 抛。`RoutePlanner` 用 `defineAsyncComponent` 引它，并且只在真的解出航路之后才
 * 渲染 —— 于是 Leaflet 那一百多 KB 只在用户按下「展开」并成功之后才下载。对一个
 * 可能在机上用平板打开的站来说，这不是微优化：没解航路的人一个字节都不该付。
 *
 * 画法照抄 can-radar 的 `RadarMap.vue`（`drawRouteLine`），但**只留了航路那一
 * 层**：没有航空器、没有管制席位、没有扇区边界，那些是雷达的事。两处刻意保留的
 * 一致：
 *
 * - **大圆弧，不是直线。** 墨卡托上两点之间的直线不是飞机飞的路径，长段尤其明
 *   显。`arc()` 按段长决定插值密度，短段不浪费点。
 * - **SID/STAR 画虚线**，航路段画实线，而且转折那一段同时属于两条线，所以样式
 *   变化处没有缺口。
 *
 * 底图是一层 Natural Earth 的陆地多边形（不是瓦片），**跟着主题走**。主题在这个站是 `<html>` 上的
 * `dark` 类，而 `ThemeLangControls` 换主题时不发任何事件 —— 所以这里挂了一个
 * `MutationObserver` 盯 class。没有别的通道：那个组件是从 can-web 同步来的，为
 * 了地图在它里面加一个事件，就等于让四个站的公共文件为一个站的需求分叉。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { arc, type LatLon } from "@/lib/geo";
import type { GeoJsonObject } from "geojson";

interface Point {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
}

const props = defineProps<{ points: Point[]; label: string }>();

/**
 * **没有瓦片底图。** 这块地图画的是一层陆地多边形，海洋就是容器的底色。
 *
 * 为什么不是瓦片：栅格底图（CARTO 的 positron / dark matter 那两套，包括
 * `_nolabels` 变体）里除了海陆，还烘焙着国境线、道路、城市面 —— 那些是图片的一
 * 部分，关不掉。而这块地图要的只有「航路跨过哪片陆地、哪片海」，多出来的每一条
 * 线都是噪音。换个瓦片样式解决不了，只能不用瓦片。
 *
 * 数据是 Natural Earth 1:110m 的陆地多边形，**公有领域**（NE 明确声明无需授权、
 * 无需署名）—— 所以这里也不再需要那行归属声明，`attributionControl` 因此关掉
 * 了。注意这个「可以关」**完全依赖于不再使用 OSM/CARTO 的瓦片**：哪天把瓦片加
 * 回来，那行字必须一起回来，否则就是违反许可。
 *
 * 体积：127 个多边形，坐标截到 3 位小数（约 110 m，远低于 zoom 9 下一个像素代
 * 表的距离），94 KB，gzip 后 34 KB。它**取代**了瓦片流量，而不是叠加 —— 一个视
 * 野的瓦片轻松就是几百 KB，所以这是净赚。
 *
 * 代价写清楚：1:110m 的海岸线在高缩放下是粗的。这块地图的用途是看航路形状，
 * `fitBounds` 又把 maxZoom 压在 9，所以够用；真要更细的海岸线得换 1:50m，那是
 * 1.6 MB，为这个用途不值。
 *
 * **这一处刻意和 can-radar 不一样。** 那边的地图是拿来定位飞机的，地名和边界都
 * 有用；这边不是。改之前先想清楚是哪一种用途。
 */
const LAND_URL = "/basemap/land-110m.json";

/** 海陆两色，跟着主题走。取自 positron / dark matter 的海陆色，接近但更素。 */
const PALETTE = {
  light: { ocean: "#dde5ea", land: "#f4f5f3" },
  dark: { ocean: "#12161a", land: "#252a2f" },
};

/**
 * 拿到的陆地数据在模块层缓存。
 *
 * 外壳里那块地图带 `transition:persist`，正常情况下跨页面不会重新挂载，这个缓存
 * 用不上；留着是为了不正常的那一次 —— 保活失败时组件会重建，而重新拉一遍 94 KB
 * 只为画同一张海陆图是没道理的。
 */
let landCache: unknown = null;

const container = ref<HTMLDivElement | null>(null);

let map: L.Map | null = null;
let landLayer: L.GeoJSON | null = null;
let routeLayer: L.LayerGroup | null = null;
let themeObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function palette() {
  return isDark() ? PALETTE.dark : PALETTE.light;
}

/**
 * 把海陆两色刷上去。主题一变就要重来一次。
 *
 * 海洋是**容器的背景色**而不是一个图层：整张地图除了陆地就是海，画一个覆盖全球
 * 的多边形只是把同一件事做得更贵。
 */
function applyPalette() {
  const { ocean, land } = palette();
  if (container.value) container.value.style.background = ocean;
  landLayer?.setStyle({ fillColor: land, color: land });
}

/** 线和点的颜色。深色底图上用亮一点的蓝，浅色底图上用品牌蓝。 */
function lineColor(): string {
  return isDark() ? "#7ab8e0" : "#2f6f9e";
}

const isProcedure = (point: Point) =>
  point.kind === "sid" || point.kind === "star";
const isAirport = (point: Point) => point.kind === "airport";

/**
 * 一段一段地画，样式相同的连成一条 polyline。
 *
 * 一条腿的样式取自**它到达的那个点**：SID 的第一条腿属于 SID。这条规则和
 * can-radar 一致，改之前先看那边。
 */
function drawLine(points: Point[], color: string) {
  if (!routeLayer || points.length < 2) return;

  let from: LatLon = [points[0].lat, points[0].lon];
  let run: LatLon[] = [from];
  let runProcedure = isProcedure(points[1]);

  const flush = () => {
    if (run.length < 2) return;
    L.polyline(run, {
      color,
      weight: 2,
      opacity: runProcedure ? 0.9 : 0.75,
      dashArray: runProcedure ? "4 4" : undefined,
      interactive: false,
    }).addTo(routeLayer!);
  };

  for (const point of points.slice(1)) {
    const to: LatLon = [point.lat, point.lon];
    const procedure = isProcedure(point);

    if (procedure !== runProcedure) {
      flush();
      // 转折那条腿同时属于前后两条线，样式变化处才不会裂开一个口子。
      run = [from];
      runProcedure = procedure;
    }

    run.push(...arc(from, to).slice(1));
    from = to;
  }
  flush();
}

/** 机场画成方块，航路点画成小圆点 —— 一眼分得出两头和中间。 */
function drawPoints(points: Point[], color: string) {
  if (!routeLayer) return;

  for (const point of points) {
    const airport = isAirport(point);
    const marker = L.circleMarker([point.lat, point.lon], {
      radius: airport ? 5 : 3,
      color,
      weight: airport ? 2.5 : 1.5,
      fillColor: color,
      fillOpacity: airport ? 1 : 0.35,
    });
    marker.bindTooltip(
      point.via ? `${point.ident} · ${point.via}` : point.ident,
      {
        direction: "top",
        offset: [0, -4],
        className: "route-map-tip",
      },
    );
    marker.addTo(routeLayer);
  }
}

function render() {
  if (!map || !routeLayer) return;
  routeLayer.clearLayers();

  const points = props.points;
  if (!points.length) return;

  const color = lineColor();
  drawLine(points, color);
  drawPoints(points, color);

  const bounds = L.latLngBounds(
    points.map((p) => [p.lat, p.lon] as [number, number]),
  );
  // maxZoom 挡住只有一个点（或者两点极近）时地图一头扎到街道级的情况。
  map.fitBounds(bounds, { padding: [32, 32], maxZoom: 9 });
}

onMounted(() => {
  if (!container.value) return;

  map = L.map(container.value, {
    zoomControl: true,
    // 不再需要归属声明：底图是公有领域的 Natural Earth，见 LAND_URL 上面那段。
    // **这一行和「不用瓦片」是绑在一起的**，别单独改。
    attributionControl: false,
    // 航路图是拿来看形状的，不是拿来漫游的；滚轮缩放会抢走页面滚动。
    scrollWheelZoom: false,
    worldCopyJump: true,
  }).setView([34, 110], 4);

  // 海洋先上色，别等陆地拉回来 —— 否则首帧是一块白/黑底，和主题不搭。
  applyPalette();

  routeLayer = L.layerGroup().addTo(map);

  // 容器尺寸会变（侧栏折叠、窗口缩放、手机转屏），不告诉 Leaflet 就会画出错位
  // 的图层。
  resizeObserver = new ResizeObserver(() => map?.invalidateSize());
  resizeObserver.observe(container.value);

  themeObserver = new MutationObserver(() => {
    applyPalette();
    render();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  render();
  void loadLand();
});

/**
 * 拉陆地数据并铺上去。
 *
 * 失败**不抛也不提示**：拿不到海陆图时地图仍然是可用的 —— 航路线、航路点、缩放
 * 全都在，只是底色是一片海。为一张装饰性的底图弹一个错误提示，是把噪音摆在比信
 * 息更显眼的位置。
 *
 * `interactive: false`：陆地不该吃掉点击，航路点的 tooltip 要能点到。
 */
async function loadLand() {
  try {
    if (!landCache) {
      const response = await fetch(LAND_URL);
      if (!response.ok) return;
      landCache = await response.json();
    }
    if (!map) return;
    landLayer = L.geoJSON(landCache as GeoJsonObject, {
      interactive: false,
      style: { weight: 0.5, fillOpacity: 1, opacity: 1 },
    });
    landLayer.addTo(map);
    // 陆地要压在航路下面，否则线和点会被它盖住。
    landLayer.bringToBack();
    applyPalette();
  } catch {
    // 见上：静默降级成一片海。
  }
}

watch(() => props.points, render, { deep: true });

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
  map?.remove();
  map = null;
  landLayer = null;
  routeLayer = null;
});
</script>

<template>
  <!--
    没有 card 外壳：这块地图现在是外壳里那一整列显示面（`MapSurface.vue`），
    不再是航段表上面的一张插图。圆角和边框在一块通栏的显示面上只会切掉地图的
    四个角，而且和左边面板之间已经有一条分隔线了。
  -->
  <div ref="container" class="route-map" role="img" :aria-label="label"></div>
</template>
