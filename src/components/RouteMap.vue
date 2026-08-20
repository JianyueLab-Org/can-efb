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
 * 底图是 CARTO 的浅色/深色两套，**跟着主题走**。主题在这个站是 `<html>` 上的
 * `dark` 类，而 `ThemeLangControls` 换主题时不发任何事件 —— 所以这里挂了一个
 * `MutationObserver` 盯 class。没有别的通道：那个组件是从 can-web 同步来的，为
 * 了地图在它里面加一个事件，就等于让四个站的公共文件为一个站的需求分叉。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { arc, type LatLon } from "@/lib/geo";

interface Point {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
}

const props = defineProps<{ points: Point[]; label: string }>();

/** CARTO 的两套底图。`{r}` 是高清后缀，`{s}` 是子域，两个都要留着。 */
const TILES = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};

/**
 * 归属声明不是装饰，是 OSM 和 CARTO 的授权条件，不能删。
 */
const ATTRIBUTION = "© OpenStreetMap contributors © CARTO";

const container = ref<HTMLDivElement | null>(null);

let map: L.Map | null = null;
let tiles: L.TileLayer | null = null;
let routeLayer: L.LayerGroup | null = null;
let themeObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

function tileUrl(): string {
  return isDark() ? TILES.dark : TILES.light;
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
    attributionControl: true,
    // 航路图是拿来看形状的，不是拿来漫游的；滚轮缩放会抢走页面滚动。
    scrollWheelZoom: false,
    worldCopyJump: true,
  }).setView([34, 110], 4);

  tiles = L.tileLayer(tileUrl(), {
    attribution: ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 18,
  }).addTo(map);

  routeLayer = L.layerGroup().addTo(map);
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

  // 容器尺寸会变（侧栏折叠、窗口缩放、手机转屏），不告诉 Leaflet 就会画出灰
  // 边和错位的瓦片。
  resizeObserver = new ResizeObserver(() => map?.invalidateSize());
  resizeObserver.observe(container.value);

  themeObserver = new MutationObserver(() => {
    tiles?.setUrl(tileUrl());
    render();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  render();
});

watch(() => props.points, render, { deep: true });

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
  map?.remove();
  map = null;
  tiles = null;
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
