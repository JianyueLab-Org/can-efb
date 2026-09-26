/**
 * 图层登记处：航路、导航台、情报区、Grid MORA、三层空域，以及按缩放补上的机场
 * 和跑道。这些都是静态资料（can-db 或随站发的文件），按需取、取过留着。
 *
 * 从 MapSurface.vue 搬来，规矩一条没变，注释随代码一起搬。新加的只有一件事：失
 * 败时除了退回关，还要在地图角上说一声并给一个重试（`notice.noteFailure`）。
 */
import { computed, ref, shallowRef, type Ref } from "vue";
import type { FeatureCollection } from "geojson";
import {
  airwayBlocksFor,
  fetchAirwayNetwork,
  markNavaidFixes,
  toAirwayFixes,
  toAirwayLines,
  unionAirwayGraphs,
  AIRWAY_BLOCK,
  AIRWAY_MAX_BLOCKS,
  type TaggedAirwayGraph,
} from "@/lib/airways";
import {
  airspaceKey,
  fetchAirspaces,
  fetchNavaids,
  navaidKey,
  onlyParents,
  toAirspacePolygons,
  toNavaidPoints,
  type Airspace,
  type Navaid,
} from "@/lib/aip";
import { CHART_BLOCK, blockBox, createBlockCache } from "@/lib/blockCache";
import {
  fetchMORABlock,
  MORA_BLOCK,
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
  /** 航路网。MapStage 持有，因为航路层也要读它（算点亮哪几段）。 */
  airways: Ref<FeatureCollection | null>;
  notice: LayerNotice;
  /** MapStage 持有的那一份偏好，开关时就地改、写回 localStorage。 */
  prefs: LayerPrefs;
  /** 见 `AipGeneration`。 */
  aip: AipGeneration;
  text: { emptyNavaids: string; emptyGeneric: string };
  /** 航路网换了 —— 开、关、取回来、失败。计划高亮要跟着重算。 */
  onAirwaysChange: () => void;
}

/* 下面的要素集合、Map、Set 一律 `shallowRef` 或普通变量：它们动辄几万个要素，每次都整
 * 份换掉，没有就地改的写法。深层代理只是白白包一遍，交给 MapLibre 时还要再剥掉。 */
export function useChartLayers(options: ChartLayerOptions) {
  const { airways, notice, prefs, aip, text, onAirwaysChange } = options;

  /**
   * 导航台按块取、取过留着（`lib/blockCache.ts`）。can-db 的导航台是全球的，一次全取
   * 是一万一千多个；从 `ZOOM.vor` 起才画，门槛以下一块都不取。
   */
  const NAVAID_MIN_ZOOM = Math.floor(Math.min(ZOOM.vor, ZOOM.minorNavaids));
  const navaidBlocks = createBlockCache<Navaid>({
    size: CHART_BLOCK,
    key: navaidKey,
    fetch: (lat, lon) => fetchNavaids(blockBox(lat, lon)),
  });
  let navaidPending = 0;

  /**
   * 航路图层：开 / 关，加上按视野补块。
   *
   * **高低空两层一次取齐，按缩放决定画哪层**（门槛在 `lib/chartStyle.ts` 的 `ZOOM`）。
   *
   * **按视野分块取，和 MORA 同一个做法**（`lib/blockCache.ts`）。全球航路网约九万段，
   * 整张拉下来不现实。视野在 `ZOOM.airwaysHigh` 以下不取（那时这层也不画）；以上按
   * `AIRWAY_BLOCK` 度的块取 can-db 的 `?bbox=`，每块高低空各一次，取过的块留着，平移
   * 不重取。块按经度折回 ±180 算（`airwayBlocksFor`），所以跨日界线的视野拆成两侧的
   * 块，每块自己不跨 180°。攒下的块超过 `AIRWAY_MAX_BLOCKS` 时丢掉视野外最早取的那些。
   *
   * 所有块并成一张图（`unionAirwayGraphs`，按图键去重）再转线和点：跨块边界的航段
   * 两块里各有一份，只画一条。
   */
  const showAirways = ref(false);
  const airwayFixes = shallowRef<FeatureCollection | null>(null);
  const airwayBusy = ref(false);
  /** 一块取回来的图。块的左下角当键：一块一个条目。 */
  interface AirwayBlock {
    id: string;
    graph: TaggedAirwayGraph;
  }
  const airwayBlocks = createBlockCache<AirwayBlock>({
    size: AIRWAY_BLOCK,
    key: (b) => b.id,
    blocks: airwayBlocksFor,
    maxBlocks: AIRWAY_MAX_BLOCKS,
    fetch: async (lat, lon) => [
      {
        id: `${lat},${lon}`,
        graph: await fetchAirwayNetwork([
          lat,
          lon,
          lat + AIRWAY_BLOCK,
          lon + AIRWAY_BLOCK,
        ]),
      },
    ],
  });
  /** 并好的图转出来的线和点，只在块清单变了时重算。 */
  let airwayCache: {
    from: AirwayBlock[];
    lines: FeatureCollection;
    fixes: FeatureCollection;
  } | null = null;
  let airwayPending = 0;
  let airwayTimer: ReturnType<typeof setTimeout> | null = null;

  /** 把已取回的块画上图。关着就不画。 */
  function publishAirways() {
    if (!showAirways.value) return;
    const list = airwayBlocks.values();
    if (!list.length) {
      airways.value = null;
      airwayFixes.value = null;
      onAirwaysChange();
      return;
    }
    if (airwayCache?.from !== list) {
      const graph = unionAirwayGraphs(list.map((b) => b.graph));
      // 航路点和线一起来一起走：它们是同一份图的两个面。
      airwayCache = {
        from: list,
        lines: toAirwayLines(graph),
        fixes: toAirwayFixes(graph),
      };
    }
    airways.value = airwayCache.lines;
    airwayFixes.value = airwayCache.fixes;
    onAirwaysChange();
    /* 按视野取的块是空的，只说明这一片没有航路（比如海上），不说明库里没有 ——
     * 所以不提示「没有航段」，什么都不说。 */
    notice.clearNotice("airways");
  }

  async function loadAirwaysFor(v: Viewport) {
    if (!showAirways.value || v.zoom < ZOOM.airwaysHigh) return;
    if (notice.isDeniedThisSession()) return;
    const gen = aip.gen;
    airwayPending++;
    airwayBusy.value = true;
    try {
      const changed = await airwayBlocks.load(v);
      if (gen !== aip.gen) return;
      notice.clearFailure("airways");
      // 取的途中被关掉了：块照样留着，但不许把图层写回来（publishAirways 自己挡）。
      // 没带来新块就不重灌 —— 重灌一次是整层重建瓦片。
      if (changed || !airways.value) publishAirways();
    } catch (error) {
      // 过期的这一次（NAIP 开关翻过）：块已经清过，也不替新的那一次报失败。
      if (gen !== aip.gen) return;
      // 取失败的块 `airwayBlocks` 放回去了，下次视野变化或重试时再取。开关留着，和
      // MORA 同一条。
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("airways");
      console.error("[efb:map] 航路网加载失败:", error);
    } finally {
      airwayPending--;
      airwayBusy.value = airwayPending > 0;
    }
  }

  /** 视野停下来 250 ms 再取：连续缩放几下只取最后那个视野。 */
  function scheduleAirways(v: Viewport) {
    if (airwayTimer) clearTimeout(airwayTimer);
    airwayTimer = setTimeout(() => {
      airwayTimer = null;
      void loadAirwaysFor(v);
    }, 250);
  }

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
    // 已有的块先画上，再按当前视野补。还没收到过视野就等 `moveend` 送过来。
    if (airwayBlocks.loaded()) publishAirways();
    if (lastViewport) await loadAirwaysFor(lastViewport);
  }

  const showNavaids = ref(false);
  const navaids = shallowRef<FeatureCollection | null>(null);

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
  const firs = shallowRef<FeatureCollection | null>(null);
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
   * Grid MORA。按 10 度分块取（`lib/blockCache.ts`），块内整块缓存 —— 平移不重取，
   * 因为格子本身固定不动。全球格子六万多个，而它只在放大到读得出数字时才有用：
   * `ZOOM.mora` 以下一块都不取；离视野外扩一块之外的块扔掉（`MORA_KEEP`），再看到时
   * 重取。
   */
  const showMora = ref(false);
  const mora = shallowRef<FeatureCollection | null>(null);

  /**
   * 全部机场的点。**没有开关，也不按视野裁** —— 见 lib/airports.ts。
   *
   * 缩放阶梯上它排在情报区之后、航路之前：缩到最小只剩情报区，放一级先看到「这一片
   * 有哪些机场」。出不出现由图层的 minzoom 管，这里只负责把点备好。
   */
  const airports = shallowRef<FeatureCollection | null>(null);
  /**
   * 全库跑道。**整份取一次，不按视野裁** —— 34 kB，而缩放阶梯要它在比例尺 20 公里那
   * 一档就出现，那个视野里有十几个机场。出不出现由图层的 minzoom 管。
   */
  const runways = shallowRef<FeatureCollection | null>(null);

  const MORA_MIN_ZOOM = Math.floor(ZOOM.mora);
  /** 视野四边各外扩这么多度，之外的 MORA 块扔掉。 */
  const MORA_KEEP = MORA_BLOCK;
  const moraBlocks = createBlockCache<MORACell>({
    size: MORA_BLOCK,
    key: (c) => `${c.lat},${c.lon}`,
    fetch: fetchMORABlock,
  });
  /** 留着的格子转成点，只在清单变了时重算。 */
  let moraPoints: { from: MORACell[]; out: FeatureCollection } | null = null;
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
  /**
   * 禁区、限制区、危险区按块取（`lib/blockCache.ts`）：全球一万三千多块，从
   * `ZOOM.specialUse` 起才画，门槛以下一块都不取。区域和进近仍是整份取一次 —— 它们默
   * 认关着，而且「开了就画，不设门槛」，缩到最小时视野压到的块和全图差不多。
   */
  const restrictedBlocks = createBlockCache<Airspace>({
    size: CHART_BLOCK,
    key: airspaceKey,
    fetch: (lat, lon) => fetchAirspaces("restricted", blockBox(lat, lon)),
  });
  let restrictedPending = 0;

  const airspaces = shallowRef<FeatureCollection | null>(null);

  const layerBusy = ref(false);

  /** 取到的导航台转成点，只在清单变了时重算。 */
  let navaidPoints: { from: Navaid[]; out: FeatureCollection } | null = null;

  function showNavaidBlocks() {
    // 一块都还没取到（缩放在门槛以下）：不画也不说空 —— 那不是「没有导航台」。
    if (!navaidBlocks.loaded()) return;
    const list = navaidBlocks.values();
    if (navaidPoints?.from !== list) {
      navaidPoints = { from: list, out: toNavaidPoints(list) };
    }
    navaids.value = navaidPoints.out;
    // 空不是错，开关留在打开状态，用一句话说明它为什么空。
    if (list.length) notice.clearNotice("navaids");
    else notice.setNotice("navaids", text.emptyNavaids);
  }

  async function toggleNavaids() {
    prefs.navaids = !showNavaids.value;
    writePrefs(prefs);
    if (showNavaids.value) {
      showNavaids.value = false;
      navaids.value = null;
      notice.clearNotice("navaids");
      return;
    }
    if (notice.isDeniedThisSession()) return;
    showNavaids.value = true;
    showNavaidBlocks();
    if (lastViewport) await loadNavaidsFor(lastViewport);
  }

  async function loadNavaidsFor(v: Viewport) {
    if (!showNavaids.value || v.zoom < NAVAID_MIN_ZOOM) return;
    if (notice.isDeniedThisSession()) return;
    const gen = aip.gen;
    navaidPending++;
    layerBusy.value = true;
    try {
      const changed = await navaidBlocks.load(v);
      if (gen !== aip.gen) return;
      notice.clearFailure("navaids");
      if (changed || !navaids.value) {
        if (showNavaids.value) showNavaidBlocks();
      }
    } catch (error) {
      // 过期的这一次（NAIP 开关翻过）失败了：重取的那一次还在路上或已经画上，
      // 不许把它关掉，也不报失败 —— 和航路、MORA 那两层同一条规矩。
      if (gen !== aip.gen) return;
      // 用户明确打开的图层，失败要说话并退回关，否则开关亮着却什么都没画，看起
      // 来像这一带没有导航台。
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("navaids");
      console.error("[efb:map] 导航台加载失败:", error);
      showNavaids.value = false;
      navaids.value = null;
    } finally {
      navaidPending--;
      layerBusy.value = navaidPending + restrictedPending > 0;
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

  function showMoraCells() {
    const list = moraBlocks.values();
    if (moraPoints?.from !== list) {
      moraPoints = { from: list, out: toMORAPoints(list) };
    }
    mora.value = moraPoints.out;
  }

  async function loadMoraFor(v: Viewport) {
    if (v.zoom < MORA_MIN_ZOOM) return;
    // 先扔再取：扔掉的块不会在这一轮被算进去。
    const evicted = moraBlocks.evict(v, MORA_KEEP);
    const gen = aip.gen;
    try {
      const changed = await moraBlocks.load(v);
      if (gen !== aip.gen) return;
      notice.clearFailure("mora");
      /* 取的途中可能已经被关掉了。格子照样进缓存，但**不许**把图层写回来 —— 否则
       * 关掉 MORA 之后，还在路上的那一批一回来网格就又出现了。
       *
       * 不需要像地面那样按号作废：每次写的都是缓存里**全部**留着的格子，回来的先后不
       * 影响结果；过期的那一批由 `moraBlocks` 自己挡掉（`reset` / `evict`）。 */
      if (!showMora.value) return;
      if (changed || evicted || !mora.value) showMoraCells();
    } catch (error) {
      // 过期的这一次：块已经随 NAIP 开关清过，也不替新的那一次报失败。
      if (gen !== aip.gen) return;
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("mora");
      // 扔掉的块照样画掉；取失败的块 `moraBlocks` 放回去了，下次视野变化再取。
      if (evicted && showMora.value) showMoraCells();
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
    // 关着时不扔块，缓存里可能还是上次开着时那一片：先按当前视野扔一遍。
    if (lastViewport) moraBlocks.evict(lastViewport, MORA_KEEP);
    if (moraBlocks.values().length) showMoraCells();
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

  /** 补齐视野里的禁区块。清单变了返回 true。门槛以下不取。 */
  async function loadRestricted(v: Viewport | null): Promise<boolean> {
    if (!v || v.zoom < ZOOM.specialUse) return false;
    return restrictedBlocks.load(v);
  }

  /** 视野变了：禁区开着就补块，有新的就重新合成。 */
  async function loadRestrictedFor(v: Viewport) {
    if (!showRestricted.value || notice.isDeniedThisSession()) return;
    const gen = aip.gen;
    restrictedPending++;
    layerBusy.value = true;
    try {
      const changed = await loadRestricted(v);
      if (gen !== aip.gen) return;
      notice.clearFailure("restricted");
      if (changed && showRestricted.value) composeAirspaces();
    } catch (error) {
      if (gen !== aip.gen) return;
      if (isDenied(error)) notice.noteDenied();
      else notice.noteFailure("restricted");
      console.error("[efb:map] 空域加载失败:", error);
      showRestricted.value = false;
      composeAirspaces();
    } finally {
      restrictedPending--;
      layerBusy.value = navaidPending + restrictedPending > 0;
    }
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

    if (showCtr.value && controlledCache) {
      parts.push(...onlyParents(controlledCache, "CTA"));
    }
    if (showApp.value && controlledCache) {
      parts.push(...onlyParents(controlledCache, "APP"));
    }
    if (showRestricted.value) parts.push(...restrictedBlocks.values());

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
      if (which === "restricted") await loadRestricted(lastViewport);
      else await loadControlled();
      flag.value = true;
      notice.clearFailure(which);
      composeAirspaces();
      // 三层共用一个要素集合，所以空不空要看合成之后的结果，不看单独哪一族。禁区一块
      // 都还没取（缩放在门槛以下）时不算空 —— 那不是「这一带没有」。
      const known = showCtr.value || showApp.value || restrictedBlocks.loaded();
      if (airspaces.value?.features.length) notice.clearNotice("airspace");
      else if (known) notice.setNotice("airspace", text.emptyGeneric);
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
    airwayBlocks.reset();
    airwayCache = null;
    navaidBlocks.reset();
    navaidPoints = null;
    controlledCache = null;
    restrictedBlocks.reset();
    moraBlocks.reset();
    moraPoints = null;
    airports.value = null;
    runways.value = null;

    if (showAirways.value) {
      airways.value = null;
      airwayFixes.value = null;
      onAirwaysChange();
      if (lastViewport) void loadAirwaysFor(lastViewport);
    }
    if (showNavaids.value) {
      navaids.value = null;
      if (lastViewport) void loadNavaidsFor(lastViewport);
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
        showRestricted.value ? loadRestricted(lastViewport) : null,
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
   * 走之后这里只剩机场、跑道、航路网的块和 MORA。
   *
   * 航路和 MORA 关着就什么都不做 —— 地图一直在动，而不看的东西不该产生流量。
   */
  function onViewport(v: Viewport) {
    lastViewport = v;
    void loadForZoom(v.zoom);
    if (showAirways.value) scheduleAirways(v);
    void loadNavaidsFor(v);
    void loadRestrictedFor(v);
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
        else if (lastViewport) void loadAirwaysFor(lastViewport);
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
