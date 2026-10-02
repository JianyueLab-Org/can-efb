import { isIfrChart, type IfrChart } from "@/lib/ifrChart";

/**
 * 地图图层偏好：哪几层开着。
 *
 * 从 MapSurface.vue 搬出来，因为它是这块地图里唯一一段不碰 Vue 也不碰 DOM 的逻
 * 辑，而它错了不会被屏幕出卖：旧偏好折算错，成员上次开着的航路就悄悄没了。
 */

/**
 * 图层偏好存 localStorage。
 *
 * 这块地图跨页面存活，但**刷新一次就回到默认**——而"我要看哪几层"是一个跨会话
 * 的选择，不是一次浏览的状态。和轨的折叠状态存 `data-rail` 是同一个道理。
 *
 * 读写都包在 try 里：锁死的浏览器里 localStorage 会抛，而一个图层偏好不值得让
 * 整块地图挂掉。
 */
export const PREF_KEY = "efb.map.layers";

export interface LayerPrefs {
  /**
   * 航路开关。以前是 `airway: "off" | "high" | "low"` 的三选一，读旧偏好时折算：
   * 不是 `off` 就算开（见 `readPrefs`）。
   */
  airways: boolean;
  /**
   * IFR 高空图还是低空图（`lib/ifrChart.ts`）。管航路、航路点和禁区一族画哪些。旧偏
   * 好没有这个键：旧的 `airway: "high" | "low"` 折过来，没有就用默认值。
   */
  chart: IfrChart;
  firs: boolean;
  mora: boolean;
  /**
   * 实时那两层，各存各的。
   *
   * `atcLive` 而不是 `atc`，是为了不和空域那三个开关里的 `ctr`/`app` 混 —— 那三个
   * 画的是**空域的划分**（静态资料），这一个画的是**谁在线**（实时）。名字撞了迟早
   * 有人改错一个。
   */
  traffic: boolean;
  atcLive: boolean;
  navaids: boolean;
  /**
   * 空域从"单选一族"改成**三个独立开关**：区域管制、进近管制、限制区。
   *
   * 单选是错的形状：区域和进近是**嵌套**的两层（进近整个套在区域里），而"看巡航
   * 段归谁管"和"看进离场归谁管"经常要一起看。限制区更是和它们互不相干。
   */
  ctr: boolean;
  app: boolean;
  restricted: boolean;
  /**
   * 降水（OpenWeather，经 can-api）。这个键是后来加的：旧偏好里没有它，`readPrefs`
   * 按默认值补上。
   */
  weather: boolean;
  /**
   * 地图底部的钉板（`MapPinboard.vue`）露不露出来。只管平板和桌面：手机上没有那条
   * 栏。后来加的键，旧偏好里没有，`readPrefs` 按默认值补上。
   */
  pinboard: boolean;
}

/**
 * **默认是打开的。** 这个站的地图是一张航图，不是一块等着被点亮的空底图 ——
 * 打开就该看到航路、航路点和导航台。扇区默认关着：它是一大片填充，和航路叠在
 * 一起会把线糊掉，要看的人自己开。
 */
export const DEFAULT_PREFS: LayerPrefs = {
  airways: true,
  // 默认低空图：离场、进场和转场都从低空开始，低空图也画两层共用（`both`）的航路。
  chart: "low",
  firs: true,
  // **默认关。** 它是全图铺满的数字，和航路点、导航台标注抢同一片空白 —— 开着
  // 好看，但要读航路的时候是噪音。需要它的人（雷达引导、绕飞、备降）自己开。
  mora: false,
  navaids: true,
  // CTR / APP 默认关：大片填充，叠在航路上会把线糊掉。要看的人自己开。
  ctr: false,
  app: false,
  // 禁区、限制区、危险区默认开，从 z5 起画（`ZOOM.specialUse`）。
  restricted: true,
  // **两层都默认开。** 它们回答的是"现在谁在线、我在哪"，而那正是打开飞行包的人第
  // 一眼想知道的；数据也很轻（整张网络一次几 KB，两层共用同一次取数）。
  //
  // 拆成两个开关是为了**能分别关掉**，不是为了默认少画一层 —— 默认行为没变。
  traffic: true,
  atcLive: true,
  // **默认关。** 一整片半透明色块，盖在航路上；瓦片还要花 can-api 的 OpenWeather 额度。
  weather: false,
  // **默认开。** 钉住的航图是这次飞行要看的那几张，第一眼就该在。
  pinboard: true,
};

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readPrefs(
  storage: Pick<Storage, "getItem"> | null = localStorageOrNull(),
): LayerPrefs {
  try {
    const raw = storage?.getItem(PREF_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const saved = JSON.parse(raw) as Partial<LayerPrefs> & { airway?: string };
    // 旧的三选一偏好：`off` 以外都是开。折算后丢掉旧键，下次写回时就是新形状。
    if (typeof saved.airway === "string" && saved.airways === undefined) {
      saved.airways = saved.airway !== "off";
    }
    // 旧偏好选的是哪一层，就是哪张航图；`off` 不带层级，用默认值。
    if (saved.chart === undefined && isIfrChart(saved.airway)) {
      saved.chart = saved.airway;
    }
    delete saved.airway;
    if (!isIfrChart(saved.chart)) delete saved.chart;
    if (typeof saved.pinboard !== "boolean") delete saved.pinboard;
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(
  prefs: LayerPrefs,
  storage: Pick<Storage, "setItem"> | null = localStorageOrNull(),
): void {
  try {
    storage?.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下就算了，下次回到默认 —— 不值得为此打扰用户。
  }
}
