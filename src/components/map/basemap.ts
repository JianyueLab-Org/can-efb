/**
 * 底图数据：1:50m 陆地一进来就拉，1:10m 陆地和国界放大到用得上才拉。
 *
 * 从 RouteMap.vue 搬来。两份状态（缓存、是否已拉、是否在拉）按地图实例各一份，所
 * 以是一个工厂而不是模块级变量 —— 和原来 `<script setup>` 里的写法同一个作用域。
 */
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { ZOOM } from "@/lib/chartStyle";

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
 * 细节底图（10m 陆地 + 国界）**只在放大到用得上时才拉**，而且只拉一次。
 *
 * 两个文件加起来约 2 MB。开图那个视野（z3，全国）上它们一个像素都体现不出来 ——
 * 在那儿拉等于让每一次首屏都为看不见的东西付两兆。
 *
 * 门槛是 `ZOOM.borders`：国界比陆地细节早一级。**按最早需要的那一层定**，否则会出现「层
 * 该显示了、数据还没到」的一两秒空窗。
 *
 * **交给 MapLibre 的是 URL，不是解析好的对象。** 这两份和下面的陆地都只是底图，
 * 页面自己从不读里面的内容；`setData(url)` 让 MapLibre 在它的 worker 里下载、解析，
 * 主线程不再为几兆 JSON 的 `response.json()` 停顿。失败从地图的 `error` 事件出来
 * （`RouteMap.vue` 接着，记一行日志）。
 *
 * 只交一次：交出去就记 `detailLoaded`。worker 那边失败不会回到这里，于是不再像以前
 * 那样在下一次移动时重试 —— 装饰性的细节底图，重新打开页面再试就够了。
 */
export function createBasemapLoader(getMap: () => MapLibreMap | null) {
  let detailLoaded = false;

  function loadDetail() {
    const map = getMap();
    if (detailLoaded || !map) return;
    if (map.getZoom() < ZOOM.borders) return;
    const land = map.getSource("landDetail") as GeoJSONSource | undefined;
    const borders = map.getSource("borders") as GeoJSONSource | undefined;
    if (!land || !borders) return;
    land.setData(LAND_DETAIL_URL);
    borders.setData(BORDERS_URL);
    detailLoaded = true;
  }

  /**
   * 1:50m 陆地。同上，交 URL：URL 带内容哈希、浏览器存一年，所以再交一次（重建地图
   * 时）也不会真的再下载。失败同样从地图的 `error` 事件出来 —— 界面上仍然静默降级成
   * 一片海，为一张装饰性底图弹提示是把噪音摆在比信息更显眼的位置；日志里那一行由
   * `RouteMap.vue` 的 `error` 处理留下。
   */
  function loadLand() {
    const map = getMap();
    if (!map) return;
    (map.getSource("land") as GeoJSONSource | undefined)?.setData(LAND_URL);
  }

  return { loadLand, loadDetail };
}
