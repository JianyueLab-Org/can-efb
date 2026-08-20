/**
 * 面板 → 地图的单向通道。
 *
 * 新外壳把地图从「某个页面里的一个组件」变成了「常驻的显示面」：轨在最左，中
 * 间是当前菜单项的面板，右边那块地图跨页面存活。于是产生一个以前不存在的问
 * 题 —— 面板和地图是**两个独立的岛屿**，中间没有父组件可以传 props，也不该为
 * 此把整页塞进一个岛屿（那正是 AppRail 当初避开的水合代价，理由写在
 * globals.css 的 `--rail-current` 那一段）。
 *
 * 所以通道选了 DOM：一个挂在 `window` 上的 CustomEvent。和这个站已有的做法一
 * 致 —— 轨的折叠状态走 `<html data-rail>`，也是把跨岛屿的状态交给浏览器，而不
 * 是为此引一个状态库进来。
 *
 * **单向是刻意的。** 地图只负责显示，不回话：任何「点地图改输入」的需求都该先
 * 在面板里有一个明确的入口，而不是让两个岛屿互相写对方的状态 —— 那种双向绑定
 * 在没有共同父组件的情况下，最后一定演变成谁先加载谁赢。
 */

/** 地图能画的一个点。形状取自 `/api/v1/route` 展开后的航段，和 RouteMap 的 props 一致。 */
export interface MapPoint {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
}

/** 事件名。带前缀是因为 window 是全局的，而这个站将来可能不止一个通道。 */
export const MAP_EVENT = "efb:map";

export interface MapPayload {
  /** 要画的点。空数组＝清空地图，回到空状态。 */
  points: MapPoint[];
  /** 地图角上的说明，**已经翻译好** —— 岛屿之间不传 i18n 的键。 */
  label?: string;
}

/**
 * 面板端调用：把要显示的东西交给地图。
 *
 * 服务端渲染时 `window` 不存在，这里直接返回而不是抛 —— 调用方多半在
 * `onMounted` 之后才用它，但组件被 SSR 一次是常态，不该为此在每个调用点写守卫。
 */
export function publishToMap(payload: MapPayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<MapPayload>(MAP_EVENT, { detail: payload }),
  );
}

/**
 * 地图端调用：订阅。返回退订函数，交给 `onBeforeUnmount`。
 *
 * 地图跨页面存活、面板每次导航换一批，所以退订在地图这一侧几乎用不上 —— 仍然
 * 返回它：跨页面保活只是**通常**保住实例，一次没保住就会留下一个永远收不到画面
 * 的监听器，那种 bug 极难查。
 */
export function subscribeToMap(
  handler: (payload: MapPayload) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    handler((event as CustomEvent<MapPayload>).detail);
  };
  window.addEventListener(MAP_EVENT, listener);
  return () => window.removeEventListener(MAP_EVENT, listener);
}
