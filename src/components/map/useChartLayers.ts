/**
 * 图层登记处：航路、导航台、情报区、Grid MORA、三层空域，以及按缩放补上的机场
 * 和跑道。这些都是静态资料（can-db 或随站发的文件），按需取、取过留着。
 *
 * 从 MapSurface.vue 搬来，规矩一条没变，注释随代码一起搬。新加的只有一件事：失
 * 败时除了退回关，还要在地图角上说一声并给一个重试（`notice.noteFailure`）。
 */
import { computed, ref, type Ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  fetchAirwayNetwork,
  markNavaidFixes,
  toAirwayFixes,
  toAirwayLines,
} from "@/lib/airways";
import {
  fetchAirspaces,
  fetchNavaids,
  onlyParents,
  toAirspacePolygons,
  toNavaidPoints,
  type Airspace,
} from "@/lib/aip";
import {
  blocksFor,
  fetchMORABlock,
  toMORAPoints,
  type MORACell,
} from "@/lib/mora";
import { fetchFIRs, firBoundaries } from "@/lib/firs";
import { fetchAirportPins, toAirportPoints } from "@/lib/airports";
import {
  airportRunwaySummary,
  fetchRunways,
  toRunwayFeatures,
} from "@/lib/runways";
import { MAJOR_AIRPORT_MIN_RUNWAY_M, ZOOM } from "@/lib/chartStyle";
import { writePrefs, type LayerPrefs } from "@/lib/mapPrefs";
import {
  isDenied,
  type LayerId,
  type LayerNotice,
} from "@/components/map/useLayerNotice";

/** 视野框。RouteMap 的 `viewport` 事件就是这个形状。 */
export interface Viewport {
  south: number;
  west: number;
  north: number;
  east: number;
  zoom: number;
}

export type ChartLayerToggle = Exclude<LayerId, "live">;
/** 图层菜单里的九个开关。实时那两层各一个，但失败时算同一次取数（`live`）。 */
export type LayerToggle = ChartLayerToggle | "traffic" | "atcLive";

/**
 * 「不使用受限汇编」每变一次加一。MapStage 持有这一个对象，传给每个取 can-db 的
 * 层；取数 await 回来时号不对，就是按旧值取的，不许进缓存也不许上图。
 */
export interface AipGeneration {
  gen: number;
}

export interface ChartLayerOptions {
  /** 航路网。MapStage 持有，因为航路层也要写它（高亮换一个新对象）。 */
  airways: Ref<FeatureCollection | null>;
  notice: LayerNotice;
  /** MapStage 持有的那一份偏好，开关时就地改、写回 localStorage。 */
  prefs: LayerPrefs;
  /** 见 `AipGeneration`。 */
  aip: AipGeneration;
  text: { emptyAirways: string; emptyNavaids: string; emptyGeneric: string };
  /** 航路网换了 —— 开、关、取回来、失败。计划高亮要跟着重算。 */
  onAirwaysChange: () => void;
}

export function useChartLayers(options: ChartLayerOptions) {
  const { airways, notice, prefs, aip, text, onAirwaysChange } = options;

  /** 见 toggleAirways 上面的注释：跨组件重建保留。 */
  let airwayCache: {
    lines: FeatureCollection;
    fixes: FeatureCollection;
  } | null = null;

  let navaidCache: FeatureCollection | null = null;

  /**
   * 航路图层：开 / 关。
   *
   * **高低空两层一次取齐，按缩放决定画哪层**：缩小只有高空（和两层都有的），放大
   * 加上低空（门槛在 `lib/chartStyle.ts` 的 `ZOOM`）。以前是一个高空 / 低空的三选
   * 一，而人在缩放时想要的正是这件事自动发生。
   *
   * **按需拉，而且拉过的留着。** 整张全国航路网是几百 KB。缓存放在模块作用域：这块
   * 地图跨页面存活，但保活失败时组件会重建，那时缓存还在就不必重拉。
   */
  const showAirways = ref(false);
  const airwayFixes = ref<FeatureCollection | null>(null);
  const airwayBusy = ref(false);

  async function toggleAirways(on = !showAirways.value) {
    showAirways.value = on;
    prefs.airways = on;
    writePrefs(prefs);
    if (!on) {
      airways.value = null;
      airwayFixes.value = null;
      onAirwaysChange();
      notice.clearNotice("airways");
      return;
    }

    if (airwayCache) {
      airways.value = airwayCache.lines;
      airwayFixes.value = airwayCache.fixes;
      onAirwaysChange();
      // 缓存命中也要判一次空：缓存的正是"空"，而提示不该只在第一次出现。
      if (airwayCache.lines.features.length) notice.clearNotice("airways");
      else notice.setNotice("airways", text.emptyAirways);
      return;
    }

    if (notice.isDeniedThisSession()) return;
    airwayBusy.value = true;
    const gen = aip.gen;
    try {
      const graph = await fetchAirwayNetwork();
      if (gen !== aip.gen) return;
      const lines = toAirwayLines(graph);
      // 航路点和线一起来一起走：它们是同一份图的两个面，分开缓存迟早不同步。
      const fixes = toAirwayFixes(graph);
      airwayCache = { lines, fixes };
      notice.clearFailure("airways");
      // 取的途中被关掉了：数据照样缓存，但不许把图层写回来。
      if (!showAirways.value) return;
      airways.value = lines;
      onAirwaysChange();
      airwayFixes.value = fixes;

      // **取回来是空的，不是失败。** 开关留在打开状态，用一句话说明它为什么空。
      if (lines.features.length) notice.clearNotice("airways");
      else notice.setNotice("airways", text.emptyAirways);
    } catch (error) {
      // 用户明确打开的图层，失败要说话并退回关，否则开关亮着却什么都没画。
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("airways");
      console.error("[efb:map] 航路网加载失败:", error);
      showAirways.value = false;
      airways.value = null;
      airwayFixes.value = null;
      onAirwaysChange();
    } finally {
      // 过期的这一次不收忙碌态：重取的那一次还在路上。
      if (gen === aip.gen) airwayBusy.value = false;
    }
  }

  /**
   * 其余三个图层：导航台、扇区、限制区。各自独立开关。
   *
   * 独立而不是做成一个「显示全部」：这几层的用途不一样 —— 看扇区归属和看限制区是
   * 两件事，一次全打开只会把图糊掉。
   *
   * 和航路一样按需拉、拉过留着。
   */
  const showNavaids = ref(false);
  const navaids = ref<FeatureCollection | null>(null);

  /**
   * 情报区边界。**独立开关，默认开** —— 它是航图的底子，不是叠加物。
   *
   * 单独一个 ref 而不是并进 airspaceFamily 那个单选，理由见 RouteMap 里 firs
   * 这个 prop 的注释：并进去就意味着打开限制区会让边界消失。
   *
   * **数据不来自 can-db**，来自随站点发的静态文件（VATSpy，见 lib/firs.ts）：汇编
   * 没有发布完整的边界，沿国境线的那一段不在数据里，闭合成环会切一条直线横穿过
   * 去。由此这一层也不受 aipAccess 影响，没有登录门槛之外的权限要求。
   */
  /* 和导航台重合的航路点打标记，导航台出现时让位（`markNavaidFixes`）。computed：
   * 两份输入都没变时引用不变，RouteMap 的 setSource 照样跳过。 */
  const shownFixes = computed(() =>
    markNavaidFixes(airwayFixes.value, navaids.value),
  );

  const showFirs = ref(false);
  const firs = ref<FeatureCollection | null>(null);
  let firCache: FeatureCollection | null = null;

  /**
   * 取回边界底图并缓存，**和"要不要画边界这一层"无关**。
   *
   * 两个消费者：边界图层自己（`toggleFirs`），以及实时那一层 —— 它要拿边界去圈出
   * 「这块空域现在有人管」。后者在边界图层关着的时候也需要这份数据，所以取数不能挂
   * 在开关上。
   */
  async function loadFirCache(): Promise<FeatureCollection> {
    if (!firCache) firCache = await fetchFIRs();
    return firCache;
  }

  /**
   * Grid MORA。**唯一一个按视野取的图层**，其余几层都是一次拉全国。
   *
   * 理由是量级：航路网全国八千段，格子光是覆盖框内就有几千个，而且它只在放大到
   * 读得出数字时才有用。所以按 10 度分块取、块内整块缓存 —— 平移不重取，因为格
   * 子本身固定不动。
   */
  const showMora = ref(false);
  const mora = ref<FeatureCollection | null>(null);

  /**
   * 全部机场的点。**没有开关，也不按视野裁** —— 见 lib/airports.ts。
   *
   * 缩放阶梯上它排在情报区之后、航路之前：缩到最小只剩情报区，放一级先看到「这一片
   * 有哪些机场」。出不出现由图层的 minzoom 管，这里只负责把点备好。
   */
  const airports = ref<FeatureCollection | null>(null);
  /**
   * 全库跑道。**整份取一次，不按视野裁** —— 34 kB，而缩放阶梯要它在比例尺 20 公里那
   * 一档就出现，那个视野里有十几个机场。出不出现由图层的 minzoom 管。
   */
  const runways = ref<FeatureCollection | null>(null);

  /** 已取回的格子，跨块累积；键是 `lat,lon`。 */
  const moraCells = new Map<string, MORACell>();
  /** 已经取过（或正在取）的块，键是块的左下角。避免同一块并发重复请求。 */
  const moraBlocks = new Set<string>();
  let lastViewport: Viewport | null = null;

  /**
   * 空域三层。**同一次请求**（can-db 的 `?family=controlled` 一次给全部 672 块），
   * 按 `kind` 在本地分成区域和进近 —— 拆成两次请求只是把同一份数据取两遍。
   *
   * 只画**父区**（`CTA` / `APP`），不画它们内部的席位划分：29 个区域管制区被切成
   * 307 个扇区、50 个进近被切成 287 个，全铺开是每个父区一圈外框加几条内部分割
   * 线，叠成一张网 —— 那是管制席位的图，不是飞行员看的航图。
   */
  const showCtr = ref(false);
  const showApp = ref(false);
  const showRestricted = ref(false);

  /** can-db 那一族的原始清单，取一次就够。 */
  let controlledCache: Airspace[] | null = null;
  let restrictedCache: Airspace[] | null = null;

  /**
   * 因为边界不完整而没画的块数，分层记着。
   *
   * **要显示出来。** 汇编对将近一半的区域管制区只发布了边界的一段（其余沿国境线
   * 走，而国境线不在数据里），照着画会得到一条看起来合理的错边界，所以那些块被跳
   * 过了 —— 但**静默地少画和静默地画错一样糟**，得让人知道图上缺了几块。
   */
  const skipped = ref({ ctr: 0, app: 0, restricted: 0 });
  const airspaces = ref<FeatureCollection | null>(null);

  const layerBusy = ref(false);

  async function toggleNavaids() {
    prefs.navaids = !showNavaids.value;
    writePrefs(prefs);
    if (showNavaids.value) {
      showNavaids.value = false;
      navaids.value = null;
      notice.clearNotice("navaids");
      return;
    }
    if (navaidCache) {
      navaids.value = navaidCache;
      showNavaids.value = true;
      if (navaidCache.features.length) notice.clearNotice("navaids");
      else notice.setNotice("navaids", text.emptyNavaids);
      return;
    }
    if (notice.isDeniedThisSession()) return;
    layerBusy.value = true;
    const gen = aip.gen;
    try {
      const list = await fetchNavaids();
      if (gen !== aip.gen) return;
      navaidCache = toNavaidPoints(list);
      notice.clearFailure("navaids");
      navaids.value = navaidCache;
      showNavaids.value = true;
      // 和航路那层同一条：空不是错，开关留在打开状态，用一句话说明它为什么空。
      if (navaidCache.features.length) notice.clearNotice("navaids");
      else notice.setNotice("navaids", text.emptyNavaids);
    } catch (error) {
      // 和航路那层同一条规矩：用户明确打开的图层，失败要说话并退回关，否则开关亮
      // 着却什么都没画，看起来像这一带没有导航台。
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("navaids");
      console.error("[efb:map] 导航台加载失败:", error);
      showNavaids.value = false;
    } finally {
      layerBusy.value = false;
    }
  }

  async function toggleFirs() {
    prefs.firs = !showFirs.value;
    writePrefs(prefs);

    if (showFirs.value) {
      showFirs.value = false;
      firs.value = null;
      return;
    }
    if (firCache) {
      firs.value = firBoundaries(firCache);
      showFirs.value = true;
      return;
    }

    layerBusy.value = true;
    try {
      firs.value = firBoundaries(await loadFirCache());
      notice.clearFailure("firs");
      showFirs.value = true;
    } catch (error) {
      // 这里不记 deniedThisSession：静态文件不会返回 401，而把一次网络抖动记成
      // 「被拒过」会让这一层在整个会话里再也不重试。
      console.error("[efb:map] 情报区加载失败:", error);
      notice.noteFailure("firs");
      showFirs.value = false;
      firs.value = null;
    } finally {
      layerBusy.value = false;
    }
  }

  /**
   * 每一层各自的取数门槛，**和它自己的 `minzoom` 一致**。
   *
   * 从前这些是一进页面就无条件拉的 —— 而地图的开图视野是 z3，那时候机场和跑道一个
   * 像素都画不出来。于是**每打开任何一页都要为看不见的东西付两次请
   * 求**，而这块地图是常驻的，每一页都会经历一次。
   *
   * 现在按需要才取。门槛必须和图层的 `minzoom` 对齐：定得比它高，会出现「层该显示
   * 了、数据还没到」的空窗；定得低，就退回成白拉。
   */
  const NEED_ZOOM = {
    /**
     * 主要机场的符号（`airport-symbols` 的 minzoom）。**跑道也在这一级取**：哪个机场
     * 算主要、跑道杠朝哪，都是从跑道数据算的（整库 34 kB）。
     */
    airports: ZOOM.airportMajor,
  } as const;

  /**
   * 按当前缩放，把该有的底数据补上。
   *
   * 两份数据各自记住自己取没取过（`fetchAirportPins` / `fetchRunways` 内部就有那道
   * 闸），所以这里重复调是廉价的 —— `moveend` 每次都会调。
   */
  async function loadForZoom(zoom: number) {
    if (zoom < NEED_ZOOM.airports || (airports.value && runways.value)) return;
    const gen = aip.gen;
    const [pins, list] = await Promise.all([
      fetchAirportPins(),
      fetchRunways(),
    ]);
    if (gen !== aip.gen) return;
    if (list.length && !runways.value) runways.value = toRunwayFeatures(list);
    /* 跑道没取到时机场照样画（全部按非主要机场、画圆），下次视野变化再试一次跑道，
     * 取到后重建一遍机场点，把主要机场和跑道杠补上。 */
    if (pins.length && (!airports.value || list.length)) {
      airports.value = toAirportPoints(
        pins,
        airportRunwaySummary(list, MAJOR_AIRPORT_MIN_RUNWAY_M),
      );
    }
  }

  async function loadMoraFor(v: Viewport) {
    const wanted = blocksFor(v.south, v.west, v.north, v.east).filter(
      (b) => !moraBlocks.has(`${b.lat},${b.lon}`),
    );
    if (!wanted.length) return;
    // 先记下来再取：同一块的第二次请求在第一次回来之前就该被挡掉。
    for (const b of wanted) moraBlocks.add(`${b.lat},${b.lon}`);

    const gen = aip.gen;
    try {
      const batches = await Promise.all(
        wanted.map((b) => fetchMORABlock(b.lat, b.lon)),
      );
      if (gen !== aip.gen) return;
      for (const cells of batches) {
        for (const c of cells) moraCells.set(`${c.lat},${c.lon}`, c);
      }
      notice.clearFailure("mora");
      /* 取的途中可能已经被关掉了。格子照样进缓存，但**不许**把图层写回来 —— 否则
       * 关掉 MORA 之后，还在路上的那一批一回来网格就又出现了。
       *
       * 不需要像地面那样按号作废：MORA 是累加的，每次写的都是**全部**已取格子的并
       * 集，回来的先后不影响结果；关掉再打开时，还在路上的这一批正是新那次被
       * `moraBlocks` 挡掉、指望它补上的那几块，作废反而会漏。 */
      if (!showMora.value) return;
      mora.value = toMORAPoints([...moraCells.values()]);
    } catch (error) {
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("mora");
      // 取失败的块要放回去，否则这次会话里再也不会重试它。
      if (gen !== aip.gen) return;
      for (const b of wanted) moraBlocks.delete(`${b.lat},${b.lon}`);
      console.error("[efb:map] Grid MORA 加载失败:", error);
    }
  }

  async function toggleMora() {
    prefs.mora = !showMora.value;
    writePrefs(prefs);

    if (showMora.value) {
      showMora.value = false;
      // **缓存留着**：关掉再打开是常见操作，而格子不会变。
      mora.value = null;
      return;
    }
    showMora.value = true;
    if (moraCells.size) mora.value = toMORAPoints([...moraCells.values()]);
    if (notice.isDeniedThisSession()) return;

    layerBusy.value = true;
    try {
      // 还没收到过视野就先不取 —— `moveend` 和地图 load 都会送一次过来。
      if (lastViewport) await loadMoraFor(lastViewport);
    } finally {
      layerBusy.value = false;
    }
  }

  /* 取的途中「不使用受限汇编」变了：旧那份不进缓存，按新值再取一次。 */
  async function loadControlled(): Promise<Airspace[]> {
    if (controlledCache) return controlledCache;
    const gen = aip.gen;
    const list = await fetchAirspaces("controlled");
    if (gen !== aip.gen) return loadControlled();
    controlledCache = list;
    return list;
  }

  async function loadRestricted(): Promise<Airspace[]> {
    if (restrictedCache) return restrictedCache;
    const gen = aip.gen;
    const list = await fetchAirspaces("restricted");
    if (gen !== aip.gen) return loadRestricted();
    restrictedCache = list;
    return list;
  }

  /**
   * 三层合成一个要素集合再交给地图。
   *
   * 一个 source 而不是三个：它们的画法只差颜色（靠要素上的 `cls` 分），而三个
   * source 意味着 RouteMap 里三套图层、三份主题切换 —— 换来的只是能分别控制层序，
   * 而这三层本来就该在同一层。
   */
  function composeAirspaces() {
    const parts: Airspace[] = [];
    const counts = { ctr: 0, app: 0, restricted: 0 };

    if (showCtr.value && controlledCache) {
      const list = onlyParents(controlledCache, "CTA");
      const built = toAirspacePolygons(list);
      counts.ctr = built.skipped;
      parts.push(...list);
    }
    if (showApp.value && controlledCache) {
      const list = onlyParents(controlledCache, "APP");
      counts.app = toAirspacePolygons(list).skipped;
      parts.push(...list);
    }
    if (showRestricted.value && restrictedCache) {
      counts.restricted = toAirspacePolygons(restrictedCache).skipped;
      parts.push(...restrictedCache);
    }

    skipped.value = counts;
    airspaces.value = parts.length ? toAirspacePolygons(parts).features : null;
  }

  /** 一个开关的通用形状：拉数据（带缓存）、翻状态、重新合成。 */
  async function toggleAirspace(which: "ctr" | "app" | "restricted") {
    const flag =
      which === "ctr" ? showCtr : which === "app" ? showApp : showRestricted;

    prefs[which] = !flag.value;
    writePrefs(prefs);

    if (flag.value) {
      flag.value = false;
      composeAirspaces();
      // 三层都关掉了才撤提示 —— 还开着一层就说明那句话仍然在描述屏幕上的情况。
      if (
        !airspaces.value?.features.length &&
        !showCtr.value &&
        !showApp.value
      ) {
        if (!showRestricted.value) notice.clearNotice("airspace");
      }
      return;
    }
    if (notice.isDeniedThisSession()) return;

    layerBusy.value = true;
    try {
      if (which === "restricted") await loadRestricted();
      else await loadControlled();
      flag.value = true;
      notice.clearFailure(which);
      composeAirspaces();
      // 三层共用一个要素集合，所以空不空要看合成之后的结果，不看单独哪一族。
      if (airspaces.value?.features.length) notice.clearNotice("airspace");
      else notice.setNotice("airspace", text.emptyGeneric);
    } catch (error) {
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure(which);
      console.error("[efb:map] 空域加载失败:", error);
      flag.value = false;
      composeAirspaces();
    } finally {
      layerBusy.value = false;
    }
  }

  /** 三层里一共跳过了多少块，给那条提示用。 */
  const skippedTotal = computed(
    () => skipped.value.ctr + skipped.value.app + skipped.value.restricted,
  );

  /**
   * 「不使用受限汇编」变了（设置页，或另一个标签页）。
   *
   * 图上每一层 can-db 数据都是按旧值取的，**全部作废、开着的重取**。只重取一部分，
   * 图上就同时画着两个级别的资料 —— 看起来完全正常，而那正是这个开关要避免的。
   * 情报区边界不来自 can-db，不动。
   *
   * 这里只管登记处这一半；地面和计划各在自己的 use* 里。代号 `aip.gen` 由 MapStage
   * 的 `watch(hideNaip)` 先加一，再调这里 —— 号只有一个，各层共用。
   */
  function reloadAip() {
    airwayCache = null;
    navaidCache = null;
    controlledCache = null;
    restrictedCache = null;
    moraCells.clear();
    moraBlocks.clear();
    airports.value = null;
    runways.value = null;

    if (showAirways.value) void toggleAirways(true);
    if (showNavaids.value) {
      // toggleNavaids 是翻转式的：先摆回关，它再按新值打开。
      showNavaids.value = false;
      navaids.value = null;
      void toggleNavaids();
    }
    if (showCtr.value || showApp.value || showRestricted.value) {
      void reloadAirspaces();
    }
    if (showMora.value) {
      mora.value = null;
      if (lastViewport) void loadMoraFor(lastViewport);
    }
    if (lastViewport) void loadForZoom(lastViewport.zoom);
  }

  async function reloadAirspaces() {
    const gen = aip.gen;
    // 失败时三层一起退回关，而重试只重开一层：记下开着的第一层，给重试用。
    const first: ChartLayerToggle = showCtr.value
      ? "ctr"
      : showApp.value
        ? "app"
        : "restricted";
    layerBusy.value = true;
    try {
      await Promise.all([
        showCtr.value || showApp.value ? loadControlled() : null,
        showRestricted.value ? loadRestricted() : null,
      ]);
    } catch (error) {
      if (gen !== aip.gen) return;
      // 和打开时同一条规矩：失败要退回关，否则开关亮着却画的是空。
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure(first);
      console.error("[efb:map] 空域加载失败:", error);
      showCtr.value = false;
      showApp.value = false;
      showRestricted.value = false;
    } finally {
      layerBusy.value = false;
    }
    if (gen === aip.gen) composeAirspaces();
  }

  /**
   * 视野变了。原来这一段在 MapSurface 的 onViewport 里和地面层挤在一起；地面层搬
   * 走之后这里只剩机场、跑道和 MORA。
   *
   * MORA 关着就什么都不做 —— 地图一直在动，而不看的东西不该产生流量。
   */
  function onViewport(v: Viewport) {
    lastViewport = v;
    void loadForZoom(v.zoom);
    if (!showMora.value || notice.isDeniedThisSession()) return;
    void loadMoraFor(v);
  }

  /**
   * 挂载时按偏好把图层打开。**这是"打开就看到航图"的那一步** —— 没有它，默认值
   * 只是一个没人读的常量。不 await：地图不该等航路网下载完才出现。
   */
  function restore(saved: LayerPrefs) {
    if (saved.airways) void toggleAirways(true);
    if (saved.firs) void toggleFirs();
    if (saved.mora) void toggleMora();
    if (saved.navaids) void toggleNavaids();
    if (saved.ctr) void toggleAirspace("ctr");
    if (saved.app) void toggleAirspace("app");
    if (saved.restricted) void toggleAirspace("restricted");
  }

  /**
   * 地图角上那个「重试」。失败的层已经退回关，重试就是再开一次；MORA 失败时开关
   * 留着（它按视野取，取失败的块已经放回去了），重试是把当前视野再补一次。
   */
  function retry(id: ChartLayerToggle) {
    switch (id) {
      case "airways":
        if (!showAirways.value) void toggleAirways(true);
        return;
      case "navaids":
        if (!showNavaids.value) void toggleNavaids();
        return;
      case "firs":
        if (!showFirs.value) void toggleFirs();
        return;
      case "mora":
        if (lastViewport) void loadMoraFor(lastViewport);
        return;
      default: {
        const flag =
          id === "ctr" ? showCtr : id === "app" ? showApp : showRestricted;
        if (!flag.value) void toggleAirspace(id);
      }
    }
  }

  return {
    showAirways,
    airwayFixes,
    shownFixes,
    airwayBusy,
    toggleAirways,
    showNavaids,
    navaids,
    toggleNavaids,
    showFirs,
    firs,
    toggleFirs,
    loadFirCache,
    showMora,
    mora,
    toggleMora,
    showCtr,
    showApp,
    showRestricted,
    airspaces,
    skippedTotal,
    toggleAirspace,
    layerBusy,
    airports,
    runways,
    onViewport,
    restore,
    retry,
    reloadAip,
  };
}

export type ChartLayers = ReturnType<typeof useChartLayers>;
