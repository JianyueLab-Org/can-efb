/**
 * 航路层：面板推来的点、成员已提交的计划、计划在航路网上点亮的那几段、镜头焦点。
 *
 * 从 MapSurface.vue 搬来。航路网本身归图层登记处；这里只读它、在高亮变了时换一个
 * 新对象写回去（原因见 refreshHighlight 里的注释）。
 */
import { ref, type Ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  PLAN_CHANGED_EVENT,
  subscribeToMap,
  subscribeMapFocus,
  subscribePlanRequest,
  type MapFocus,
  type MapPoint,
} from "@/lib/mapBus";
import { markRouteOnAirways, routeLegKeys } from "@/lib/airways";
import { unwrapList } from "@/lib/aip";
import { api } from "@/lib/canApi";
import { dbFetch } from "@/lib/naip";

export function useRouteLayer(options: {
  airways: Ref<FeatureCollection | null>;
  /** `label` 是外壳给的默认角标；`planOnMap` 带 `{from}` / `{to}`。都已翻译。 */
  text: { label: string; planOnMap: string };
}) {
  const { airways, text } = options;

  const points = ref<MapPoint[]>([]);
  const markers = ref<MapPoint[]>([]);
  const focus = ref<MapFocus | null>(null);
  const label = ref(text.label);

  /**
   * 计划里**真正被点亮**的那些航段。
   *
   * 传给地图，让它跳过这些腿不再另画线 —— 沿航路飞的部分由航段本身高亮表达，那正是
   * 「不要另加元素」。是「标到的」而不是「有 via 的」：没点上的腿仍然要画，否则航路会
   * 断在中间，而断掉在图上看不出来。
   */
  const highlightedLegs = ref<Set<string> | null>(null);

  /* 面板发过东西没有。**发过就不要再被计划盖掉** —— 计划是异步取的，而面板可能在它
     回来之前就已经推了自己的内容（航路规划器一进页面就推）。没有这道闸，「打开 /route
     画好一条航路，两秒后被自己的飞行计划顶掉」是一定会发生的。 */
  let panelPublished = false;

  /**
   * 图上现在画的是不是**已提交的计划**，以及是哪一份（起降 + 航路串）。
   *
   * 地图跨页面常驻，计划却会变：交了、改了、撤了。每换一页重读一次计划（见
   * `onPageSwap`），这两个值决定要不要重画、要不要撤掉 —— 没变就不重复展开，撤了就
   * 把那条线拿走，而面板推来的东西一律不碰。
   */
  let planShown = false;
  let planKey = "";
  /** 每次读计划领一个号，回来时号不是最新的就不写，和地面那层同一道闸。 */
  let planSeq = 0;

  /** 撤掉图上的计划线，角标回到外壳给的那一句。只在画的确实是计划时调。 */
  function clearPlanRoute() {
    planShown = false;
    planKey = "";
    points.value = [];
    refreshHighlight();
    label.value = text.label;
  }

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
    if (panelPublished) return;
    const seq = ++planSeq;
    const plan = await api<{
      departure?: string;
      arrival?: string;
      route?: string;
    } | null>("/api/v1/pilot/flightplan");
    if (seq !== planSeq || panelPublished) return;
    // 没读上：图上是什么就留着什么。读失败不等于撤了计划。
    if (!plan.ok) return;

    const departure = plan.data?.departure;
    const arrival = plan.data?.arrival;
    const route = plan.data?.route;
    if (!departure || !arrival) {
      // 读上了、确实没有计划（撤掉了）：之前画着的那条要拿走，否则撤掉的计划还挂在
      // 图上，角标还写着「已提交的飞行计划」。
      if (planShown) clearPlanRoute();
      return;
    }
    const key = `${departure}|${arrival}|${route ?? ""}`;
    // 还是同一份计划，就别每换一页都重新展开一遍。
    if (planShown && key === planKey) return;

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
    const response = await dbFetch(`aip/resolve?${params}`).catch(() => null);
    if (seq !== planSeq || panelPublished) return;
    const resolved = response?.ok
      ? unwrapList<MapPoint>(await response.json().catch(() => null))
      : [];
    if (seq !== planSeq || panelPublished) return;
    if (!resolved.length) {
      // 新的这份画不出来。旧的那份已经不是他的计划了，不能留着冒充 —— 撤掉，和「没
      // 画出来」在这一层是同一回事（见上面「失败一律安静」）。
      if (planShown) clearPlanRoute();
      return;
    }

    planShown = true;
    planKey = key;
    points.value = resolved;
    // 计划到了，把它在航路网上点亮。航路网可能还没加载好 —— 那边加载完也会再算一次。
    refreshHighlight();
    label.value = text.planOnMap
      .replace("{from}", departure)
      .replace("{to}", arrival);
  }

  /**
   * 重算高亮。**航路网变了要算，计划变了也要算**，所以两处都调它。
   *
   * 漏掉任何一边的后果都是安静的：切了图层级别之后高亮消失，或者换了一条计划之后旧
   * 的还亮着。
   */
  /** 上一次算出来的那批高亮键，拼成一个串用来比。见 refreshHighlight。 */
  let highlightSignature = "";

  function refreshHighlight() {
    const collection = airways.value;
    if (!collection) {
      highlightedLegs.value = null;
      highlightSignature = "";
      return;
    }

    const legs = routeLegKeys(points.value);

    /* **航路没变就什么都不做。**
     *
     * 这个函数在四处被调（航路网加载完两条路、计划解析完、面板推来新航路），其中好
     * 几次的航路其实是同一条。而它每次都要遍历八千多条航段、再换一个新集合对象 ——
     * 换对象会让下游把整份重新上传给 MapLibre，那是一次看得见的顿。
     *
     * 比的是**算出来的键**而不是 `points` 的引用：面板可能推来一份内容相同的新数组
     * （重新解析同一条计划就是这样），那时候不该重传。 */
    const signature = [...legs].sort().join("|");
    if (signature === highlightSignature && highlightedLegs.value) return;
    highlightSignature = signature;

    const marked = markRouteOnAirways(collection, legs);
    highlightedLegs.value = marked;
    /* 换一个新对象，否则 Vue 的 watch 看不出变化 —— `markRouteOnAirways` 改的是里面
       那些 feature 的属性，集合本身还是同一个引用。这也是上面那道闸存在的理由：这一
       步不便宜。 */
    airways.value = { ...collection, features: [...collection.features] };
  }

  let unsubscribe: (() => void) | null = null;
  let unsubscribeFocus: (() => void) | null = null;
  let unsubscribePlanRequest: (() => void) | null = null;

  /**
   * 每次页面导航之后重读一次计划。
   *
   * 地图是 `transition:persist` 的，`onMounted` 一辈子只跑一次 —— 以前计划那条线
   * 因此只在第一次打开时画，之后交了、改了、撤了，图上都还是那一条旧的。
   *
   * 挂 `astro:after-swap`（只在导航时触发，首次加载不触发，那一次 onMounted 已经
   * 读过）。在飞行计划那一页交或撤**不导航**，所以那一页另发一个
   * `PLAN_CHANGED_EVENT`（`lib/mapBus.ts`），走的是同一个处理函数。
   */
  function onPageSwap() {
    void loadPlanRoute();
  }

  /**
   * 「不使用受限汇编」变了。图上画着的计划是按旧值展开的（`aip/resolve` 走 can-db），
   * 清掉 planKey 让它按新值再展开一次；画的不是计划就不碰 —— 面板推来的东西归面板。
   */
  function reloadPlan() {
    if (!planShown) return;
    planKey = "";
    void loadPlanRoute();
  }

  function start() {
    // 计划那条线不 await：地图不该等它回来才出现，和航路网是同一条道理。
    void loadPlanRoute();
    document.addEventListener("astro:after-swap", onPageSwap);
    window.addEventListener(PLAN_CHANGED_EVENT, onPageSwap);
    unsubscribe = subscribeToMap((payload) => {
      panelPublished = true;
      // 面板接管了这块地图，图上画的不再是计划 —— 之后导航时不要去撤它。
      planShown = false;
      planKey = "";
      points.value = payload.points ?? [];
      // 面板换了一条航路：旧的高亮必须撤掉，否则图上会同时亮着两条。
      refreshHighlight();
      markers.value = payload.markers ?? [];
      // 面板换了内容：旧焦点作废，否则 RouteMap 一直当它是「在挑一个看」而不框选新内容。
      focus.value = null;
      // 面板可以覆盖角标；没给就沿用外壳传进来的那一份。
      label.value = payload.label ?? text.label;
    });
    unsubscribeFocus = subscribeMapFocus((target) => {
      focus.value = target;
    });
    /* 「地图，回到我已提交的那份计划」——概览页打开时发一次（`mapBus.ts` 的
       `showPlanOnMap`）。面板可能之前已经推过东西（`panelPublished`），这一声
       要能把地图从那种状态拉回来，所以要清掉 `panelPublished` 和 `planKey` 再
       重读，不能只调 `loadPlanRoute()`——否则它会在第一行 `if (panelPublished)
       return;` 直接退出。 */
    unsubscribePlanRequest = subscribePlanRequest(() => {
      panelPublished = false;
      planKey = "";
      void loadPlanRoute();
    });
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeFocus?.();
    unsubscribeFocus = null;
    unsubscribePlanRequest?.();
    unsubscribePlanRequest = null;
    document.removeEventListener("astro:after-swap", onPageSwap);
    window.removeEventListener(PLAN_CHANGED_EVENT, onPageSwap);
  }

  return {
    points,
    markers,
    focus,
    label,
    highlightedLegs,
    refreshHighlight,
    reloadPlan,
    start,
    stop,
  };
}

export type RouteLayer = ReturnType<typeof useRouteLayer>;
