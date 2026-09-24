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
 * ## 样式在 `lib/chartStyle.ts`
 *
 * 颜色、线宽、字号、缩放门槛、图层顺序全在那一个文件里，这里只把它交给 MapLibre、
 * 灌数据、切主题。符号是 `lib/chartIcons.ts` 画的。
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
import { legKey } from "@/lib/airways";
import { escapeHtml, formatLatLon } from "@/lib/mapText";
import {
  buildStyle,
  themedProperties,
  ZOOM,
  type Theme,
} from "@/lib/chartStyle";
import { registerChartIcons } from "@/lib/chartIcons";

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

/**
 * 窗口缩放时重新问一次布局，把滚轮缩放对上。
 *
 * 构造时只判一次是不够的：地图 `transition:persist` 跨页面常驻，平板横竖屏一转、
 * 窗口一拉就可能跨过断点，而停在旧的设定上就是「堆叠时滚轮把页面卡住」或「三栏
 * 时滚轮不缩放」—— 都不报错。**仍然问 CSS**，不在这里写断点。
 *
 * 挂在 `resize` 上而不是 `matchMedia`：后者要把断点抄进 JS，正是上面那条规矩不许
 * 的；读一次计算样式很便宜，只有答案变了才动 MapLibre。
 */
function syncScrollZoom() {
  if (!map) return;
  const want = shellIsColumns();
  if (want === map.scrollZoom.isEnabled()) return;
  if (want) map.scrollZoom.enable();
  else map.scrollZoom.disable();
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
 * 航路线：相邻两点之间走大圆弧。
 *
 * **已经在航路网上点亮了的那些腿不画。** 那正是「不要另加元素」的做法：沿航路飞的
 * 部分由航段本身高亮表达，这一层只补上**没有航路可点亮**的那些 —— DCT、SID/STAR，
 * 以及航段虽然在计划里、却不在当前这份航路集合里的（图层关着、被高低空过滤掉、端
 * 点解析不出坐标）。
 *
 * `suppressed` 是**真正标到的那些键**，不是「有 via 的那些」。这个区别是要紧的：假
 * 设有 via 就一定被点亮了的话，没点上的腿会从图上消失，而**航路断在中间看不出来**
 * —— 剩下的线本身都对。
 */
/**
 * 计划的每条腿画成一条线。
 *
 * **`onAirway` 的那几条腿仍然在这份集合里**，只是在航路网接手的缩放级上被压成透明
 * （见 `route` / `route-casing` 的 `line-opacity`）。
 *
 * 从前是直接 `continue` 把它们**整条丢掉**，理由是「航路网会点亮它，别画两条」。
 * 那句话只在航路网出现之后（`ZOOM.airwaysHigh`）成立。缩到全国视野（一条
 * ZBAA→ZGGG 的计划正好要 z4）之后航路网整层不画，而这几条腿已经被丢掉了，于是**谁
 * 都不画**：计划线上出现几个洞，剩下的直飞段和程序段照旧画着，看起来完全正常。
 *
 * `markRouteOnAirways` 的文档里数过三种「点不亮」（图层关着、被高低空过滤掉、端点
 * 没坐标），并说「航路断在中间是看不出来的」。缩放是第四种，当时没数进去 —— 而它
 * 和前三种不同：前三种一旦成立就没有高亮可言，这一种是**同一条计划在不同缩放下
 * 时有时无**。
 *
 * 所以判断从「画不画」改成「谁来画」：交接由缩放决定，两边都在，永远只有一条可见。
 */
function routeLines(
  points: Point[],
  onAirway?: Set<string> | null,
): FeatureCollection {
  const features: Feature[] = [];
  // 进近和 SID/STAR 一样画虚线：它们都是「按图走」的部分，和航路段不是一回事。
  // 加进来而不是另开一类，是因为图上要表达的区别只有「按图走 vs 沿航路飞」这一
  // 条 —— 三种程序各给一种线型，读的人得先学会一套图例。
  const isProcedure = (p: Point) =>
    p.kind === "sid" || p.kind === "star" || p.kind === "approach";

  for (let i = 1; i < points.length; i++) {
    const via = points[i].via;
    const handedOff = Boolean(
      via && onAirway?.has(legKey(via, points[i - 1].ident, points[i].ident)),
    );
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
        // 这条腿在航路网上被点亮了 —— 高缩放交给那一层画，见上面那段。
        onAirway: handedOff ? 1 : 0,
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
  void loadDetail();
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
 * 常驻的那几行署名。
 *
 * VATSpy 是 CC BY-SA 4.0，**署名是许可条款不是装饰**；陆地那份（Natural Earth）
 * 属公有领域，一并列出是礼貌不是义务。
 *
 * 「情报区」那个词按语言来（`firsLabel`），所以这是函数不是常量。它会进 HTML，
 * 同样先转义。
 */
function baseAttribution(): string {
  return (
    `${escapeHtml(props.firsLabel)} ` +
    '<a href="https://github.com/vatsimnetwork/vatspy-data-project" ' +
    'target="_blank" rel="noreferrer">VATSpy</a> (CC BY-SA 4.0) · ' +
    "Natural Earth"
  );
}

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
  /* 随数据来的那几行**当纯文本**：`customAttribution` 按 HTML 渲染，而这些串来自
     can-db 的地面数据，不是我们写的 —— 原样拼进去等于让数据往页面里插标签。 */
  const extra = (props.extraAttribution ?? []).filter(Boolean).map(escapeHtml);
  attributionControl = new AttributionControl({
    compact: true,
    customAttribution: [baseAttribution(), ...extra].join(" · "),
  });
  map.addControl(attributionControl, "top-right");
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

/** 上一次真正对过焦的那个点，见 render() 里的说明。 */
let lastFocus: unknown = null;
/** 上一次真的框选过的那批点的签名。见 render() 结尾。 */
let lastFitted = "";

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
 * 门槛是 `ZOOM.borders`：国界比陆地细节早一级。**按最早需要的那一层定**，否则会出现「层
 * 该显示了、数据还没到」的一两秒空窗。
 *
 * `detailPending` 挡的是并发：`moveend` 会连着触发，没有它第一次放大就会同时飞出
 * 去好几个一样的请求。失败不写 `detailLoaded`，所以下次移动会再试。
 */
let detailLoaded = false;
let detailPending = false;

async function loadDetail() {
  if (detailLoaded || detailPending || !map) return;
  if (map.getZoom() < ZOOM.borders) return;
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
      // 滚轮缩放：三栏排布下开，堆叠排布下关 —— 堆叠时页面是会滚的，滚轮停在地
      // 图上会把它卡住。
      //
      // **问 CSS，不再自己写一份断点。** 以前这里是
      // `matchMedia("(min-width: 1024px)")`，和 globals.css 里的媒体查询各写一
      // 份 —— 而断点一改（正是这次，1024 → 1152），两份就分叉了，表现是某个宽度
      // 区间里滚轮把页面卡住，而那是没人查得到的那种毛病。现在断点只有媒体查询
      // 里一个定义处，它翻 `--shell-layout`，这里读它。
      //
      // 这里只是**初值**：地图跨页面常驻、也跨窗口缩放存活，窗口拉过断点之后要再
      // 问一次 CSS，见下面的 `syncScrollZoom`。
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
    render();
    updateCorners();
    emitViewport();
    void loadLand();
  });
  map.on("move", updateCorners);
  map.on("moveend", emitViewport);

  resizeObserver = new ResizeObserver(() => map?.resize());
  resizeObserver.observe(container.value);
  window.addEventListener("resize", syncScrollZoom);

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
watch(() => [props.extraAttribution, props.firsLabel], applyAttribution, {
  deep: true,
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  resizeObserver?.disconnect();
  window.removeEventListener("resize", syncScrollZoom);
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
