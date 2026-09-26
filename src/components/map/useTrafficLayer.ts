/**
 * 实时：在线机组、在线管制、自己那架和它的航迹。datafeed 每 30 秒一轮。
 *
 * 从 MapSurface.vue 搬来。两个开关共用一次取数和一个定时器，理由在下面那段原注释
 * 里。新加的只有：取数失败时在地图角上说一声（`live`），成功一次就撤掉。
 */
import { computed, ref } from "vue";
import type { FeatureCollection } from "geojson";
import type { MapFocus } from "@/lib/mapBus";
import { appendTrack, toTrackLine, type OwnTrack } from "@/lib/ownTrack";
import {
  fetchDatafeed,
  hasPosition,
  onlineControllers,
  ownPilot,
  toControllerPoints,
  toOwnPoint,
  toTrafficPoints,
} from "@/lib/datafeed";
import {
  buildCoverage,
  indexBoundaries,
  indexTracons,
  wantsTracons,
  type BoundaryIndex,
  type TraconIndex,
} from "@/lib/atcCoverage";
import { loadFirs } from "@/lib/firTable";
import BOUNDARIES_URL from "@/basemap/atc/boundaries.geojson?url";
import TRACONS_URL from "@/basemap/atc/tracon.geojson?url";
import { altitudeBand, flightLevel, isOnGround } from "@/lib/traffic";
import { writePrefs, type LayerPrefs } from "@/lib/mapPrefs";
import type { LayerNotice } from "@/components/map/useLayerNotice";

/**
 * 管制范围用的两份几何，各取一次。**不是情报区图层那份 `firs.json`**：那份筛掉了
 * 扇区划分，而画管制范围正要它们（`RJDG_01_CTR` 是 F01 扇区，不是整个福冈）。这两
 * 份和 can-radar 发的是同一批文件，见 `lib/atcCoverage.ts`。
 *
 * 失败记成 null 而不是抛：席位退回画点或画圈，下一轮再试。
 */
let boundaryIndex: BoundaryIndex | null = null;
let traconIndex: TraconIndex | null = null;

async function fetchCollection(url: string): Promise<FeatureCollection> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as FeatureCollection;
}

async function loadBoundaryIndex(): Promise<BoundaryIndex | null> {
  if (!boundaryIndex) {
    const [collection] = await Promise.all([
      fetchCollection(BOUNDARIES_URL).catch(() => null),
      loadFirs(),
    ]);
    if (collection) boundaryIndex = indexBoundaries(collection);
  }
  return boundaryIndex;
}

/** 2.7 MB，只在有进近在线（或 Covering 名字要它）时才取。 */
async function loadTraconIndex(): Promise<TraconIndex | null> {
  if (!traconIndex) {
    const collection = await fetchCollection(TRACONS_URL).catch(() => null);
    if (collection) traconIndex = indexTracons(collection);
  }
  return traconIndex;
}

export function useTrafficLayer(options: {
  /**
   * 自己的 CAN ID。没登录是 null。
   *
   * **用来在 datafeed 里认出自己那架飞机**，按 CID 而不是呼号 —— 呼号是每次连线
   * 自己填的，两个人可以填成一样，而认错的后果是把别人的飞机标成"你"。
   */
  cid: string | null;
  prefs: LayerPrefs;
  notice: LayerNotice;
}) {
  const { cid, prefs, notice } = options;

  /**
   * 实时数据：在线机组、在线管制、自己那架飞机。
   *
   * ## 从一个开关拆成两个
   *
   * 这里原来是一个「实时」开关管三层，注释写的理由是「它们是同一份数据的三个部分，
   * 拆开也省不下任何请求，只是多两颗按钮」。
   *
   * **那句话只算了请求，没算屏幕。** 省不省请求确实一样，但这两层在图上是完全不同的
   * 两种噪音：一屏几十架飞机和几块铺满的管制区，想看航路的时候要关掉的往往只是其中一
   * 样。多一颗按钮换的是"能只留下要看的那层"，那笔账是划算的。
   *
   * ## 自己那架跟着机组走
   *
   * 它是机组的一员，而且是最要紧的那一个。关掉机组这一层连它一起收掉是说得通的 ——
   * 想只看管制的时候，图上留一架自己也是噪音。「定位到我」那颗按钮因此也跟着消失，这
   * 是对的：按下去没反应比没有按钮更让人怀疑。
   *
   * ## 两个开关共用一次取数
   *
   * 只要有一个开着就轮询，两个都关就停。datafeed 是一份文档，取一次两层都有 —— 分两
   * 次取才是真的浪费。
   *
   * 直接打 can-fsd 的 datafeed，不走本站反代（它公开、无鉴权、带 `ACAO: *`），理
   * 由见 lib/datafeed.ts。
   */
  const showTraffic = ref(false);
  const showAtc = ref(false);
  /** 两层里有任何一层开着，就该在轮询。 */
  const liveOn = computed(() => showTraffic.value || showAtc.value);
  const traffic = ref<FeatureCollection | null>(null);
  /** 场面席位（放行/地面/塔台），外加没能对上任何范围的那些。画成点。 */
  const atc = ref<FeatureCollection | null>(null);
  /** 区域 / FSS / 进近管的那片空域，和进近的范围圈。`lib/atcCoverage.ts`。 */
  const atcAreas = ref<FeatureCollection | null>(null);
  /** 范围的标注点，「呼号 频率」。 */
  const atcLabels = ref<FeatureCollection | null>(null);
  const own = ref<FeatureCollection | null>(null);
  /**
   * 自己的航迹，从每一轮轮询里攒（`lib/ownTrack.ts`）。只活在这次会话；关掉机组那层
   * 时只是不画，攒下的留着 —— 断得太久的话 `appendTrack` 自己会重新开始。
   */
  let track: OwnTrack | null = null;
  const ownTrack = ref<FeatureCollection | null>(null);
  /** 在线管制席位数，给按钮上那个角标用。 */
  const atcCount = ref(0);
  /**
   * 自己那架飞机的当前位置，给「定位到我」用。没连线是 null，那颗按钮也就不出现。
   *
   * 单独存一份而不是从 `own` 那个要素集合里挖：挖出来要走
   * `own.features[0].geometry.coordinates`，而那串下标一旦和构造那边对不上，错法
   * 是安静地定位到别处。
   */
  const ownAt = ref<{ lat: number; lon: number; callsign: string } | null>(
    null,
  );

  /**
   * 30 秒一轮。
   *
   * 不是秒级：这是飞行前后看的图，而 datafeed 本身也是每秒重算一次快照，取得再密
   * 也只是拿到同一批数字。can-fsd 还有 `/v1/events` 增量流，管制端该用那个。
   */
  const LIVE_INTERVAL_MS = 30_000;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  /** 首次取数期间不再并发取第二次，见 toggleLive。 */
  let liveInFlight = false;
  /**
   * 取数途中又打开了另一层：等这一次回来再补取一次。
   *
   * 以前途中那次点击是直接被丢掉的 —— 按钮不亮、不报错，看起来像没点上。
   */
  let liveAgain = false;

  /**
   * 从别的标签页切回来时立刻补一次。
   *
   * 没有这一下，藏起来期间跳过的那些轮次会让画面停在最多 30 秒前 —— 而"切回来第一
   * 眼看到的是旧位置"正是这一层最不该有的样子。
   */
  function onVisible() {
    if (!document.hidden && liveOn.value) void refreshLive();
  }

  async function refreshLive() {
    // **标签页看不见就不取。** 这一层每 30 秒一次、只要开着就永远在跑 —— 而飞行包
    // 常常是开着一整晚的第二块屏。看不见的时候取回来的数据没有任何人读，却照样占
    // 着流量和 can-fsd 的一次请求。
    //
    // 不用停掉定时器：`visibilitychange` 回来时会立刻补一次（见下面），而让定时器
    // 继续空转比"停掉再重建"少一处状态。
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const feed = await fetchDatafeed();
      notice.clearFailure("live");

      /* 两层各自按自己的开关算。**取数只有一次** —— datafeed 是一份文档，管制和机组
         都在里面，分两次取才是浪费。关着的那层不去算要素，省的是 CPU 不是流量。 */
      if (showTraffic.value) {
        traffic.value = toTrafficPoints(
          feed,
          cid,
          altitudeBand,
          isOnGround,
          flightLevel,
        );
        const mine = ownPilot(feed, cid);
        own.value = toOwnPoint(mine);
        // 「定位到我」那颗按钮要有一个真的坐标才有意义。刚连上、还没发过位置包
        // 的时候 datafeed 里没有经纬度（见 `lib/datafeed.ts` 的 `DatafeedPilot`），
        // 从前这里会存下一对 undefined，然后按钮照常出现、按下去把地图飞去
        // `NaN` —— MapLibre 对此的反应是整张图不动，看起来像按钮坏了。
        ownAt.value =
          mine && hasPosition(mine)
            ? {
                lat: mine.latitude!,
                lon: mine.longitude!,
                callsign: mine.callsign,
              }
            : null;
        if (ownAt.value) {
          track = appendTrack(track, { ...ownAt.value, at: Date.now() });
          ownTrack.value = toTrackLine(track);
        }
      }
      // 关着就保证是空的，而不只是不画：清空本来由关掉那一下做，这里兜一次底。
      if (!showAtc.value) {
        clearAtc();
        return;
      }

      const controllers = onlineControllers(feed);

      /* 区域、FSS、进近画**范围**，场面席位画点。判据整个照 can-radar，见
         `lib/atcCoverage.ts`。

         几何**按需现取**，和边界图层开不开无关：这一层默认是开的，而边界那一层可以
         关掉。进近多边形只在用得上时才取。 */
      const boundaries = await loadBoundaryIndex();
      const tracons = wantsTracons(controllers)
        ? await loadTraconIndex()
        : traconIndex;
      /* 第一次要现下几何，这一段 await 里管制那层可能已经被关掉了 —— 那次关掉时已经
         清过，这里再写回去就是一个按钮灭着、图上却铺着管制区的状态。 */
      if (!showAtc.value) {
        clearAtc();
        return;
      }
      const coverage = buildCoverage(controllers, boundaries, tracons);
      atcAreas.value = coverage.areas;
      atcLabels.value = coverage.labels;
      // 点这一层留给场面席位，外加**没能对上任何范围的那些** —— 它们不该从图上消失。
      atc.value = toControllerPoints(coverage.points);
      atcCount.value = controllers.length;
    } catch (error) {
      // **不关掉这一层，也不清空已画的东西。** 实时数据每 30 秒重试一次，一次抖动
      // 就把飞机从图上抹掉比让它停在 30 秒前的位置糟得多 —— 后者至少是真的发生过
      // 的位置。
      console.error("[efb:map] 实时数据加载失败:", error);
      notice.noteFailure("live");
    }
  }

  /** 管制那层清干净。关掉时、以及取数途中被关掉时都走这里。 */
  function clearAtc() {
    atc.value = null;
    atcAreas.value = null;
    atcLabels.value = null;
    atcCount.value = 0;
  }

  /**
   * 机组和管制各一个开关，**共用一个定时器**。
   *
   * 两个都关才停轮询：datafeed 是一份文档，两层都从它来，只要还有一层开着就得继续
   * 取。定时器只有一个，因为取一次就够两层用。
   */
  async function toggleLive(which: "traffic" | "atc") {
    // **先翻状态再取数**，而不是取完再翻。中间那一段 await 是可以被再点一次的：
    // 「开」还在等第一份数据时又点了「关」，若状态留到 await 之后才写，关的那次
    // 会被开的那次覆盖 —— 界面显示关着，定时器却活着，而且没有任何办法再关掉它。
    const flag = which === "traffic" ? showTraffic : showAtc;
    const next = !flag.value;
    flag.value = next;
    prefs[which === "traffic" ? "traffic" : "atcLive"] = next;
    writePrefs(prefs);

    if (!next) {
      // 关掉的那一层清干净。自己那架跟着机组走 —— 它是机组的一员，而且只看管制的时
      // 候，图上留一架自己也是噪音。
      if (which === "traffic") {
        traffic.value = null;
        own.value = null;
        ownAt.value = null;
        ownTrack.value = null;
      } else {
        clearAtc();
      }
      // 另一层还开着就继续轮询，两个都关了才停。
      if (!liveOn.value && liveTimer) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
      return;
    }

    /* 上一次取数还在路上：不并发再取，记一笔，等它回来补一次。状态已经翻好了，按钮
       立刻就亮；补取那次按那时的开关算，所以期间来回点几下也只落到最后的状态。 */
    if (liveInFlight) {
      liveAgain = true;
      return;
    }
    liveInFlight = true;
    try {
      do {
        liveAgain = false;
        await refreshLive();
      } while (liveAgain && liveOn.value);
    } finally {
      liveInFlight = false;
    }
    // 取数途中两层可能都被关掉了 —— 那时不该再把定时器建起来。
    // 定时器建一次就够两层用；已经在跑就别重建，否则第二个开关会把周期重新计时。
    if (liveOn.value && !liveTimer) {
      liveTimer = setInterval(() => void refreshLive(), LIVE_INTERVAL_MS);
    }
  }

  /**
   * 「定位到我」要对焦的那个点。原来这里直接写 focus；现在 focus 归航路层，这里
   * 只给出目标。
   *
   * **每次都造一个新对象**，因为 RouteMap 按引用判断 focus 变没变（否则实时数据每
   * 30 秒会把镜头拽回来一次）。连点两次要都生效，就不能复用同一个对象。
   */
  function locateTarget(): MapFocus | null {
    const at = ownAt.value;
    if (!at) return null;
    return { kind: "point", lat: at.lat, lon: at.lon };
  }

  /**
   * 挂载时按偏好恢复。两层各自恢复，**不调两遍 toggleLive**：两层共用一次取数，直
   * 接把状态摆好、交给一次 refresh 就够了。
   */
  function start(saved: LayerPrefs) {
    document.addEventListener("visibilitychange", onVisible);
    if (saved.traffic) showTraffic.value = true;
    if (saved.atcLive) showAtc.value = true;
    if (liveOn.value) {
      void refreshLive();
      liveTimer = setInterval(() => void refreshLive(), LIVE_INTERVAL_MS);
    }
  }

  /**
   * 定时器必须停。这块地图是 `transition:persist` 的，一般不会走到这里 —— 但真走
   * 到了而定时器还活着，就是一个每 30 秒发一次请求、谁也看不见的泄漏。
   */
  function stop() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }

  return {
    showTraffic,
    showAtc,
    liveOn,
    traffic,
    atc,
    atcAreas,
    atcLabels,
    own,
    ownTrack,
    atcCount,
    ownAt,
    toggleLive,
    refreshLive,
    locateTarget,
    start,
    stop,
  };
}

export type TrafficLayer = ReturnType<typeof useTrafficLayer>;
