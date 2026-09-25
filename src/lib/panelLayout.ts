/**
 * 浮动面板和地图之间的几何换算。
 *
 * 地图铺满整个视口，面板浮在它上面。于是「地图的可见区」不再是地图容器本身，而是
 * 容器减去面板盖住的那一块 —— MapLibre 的 `setPadding` 正是为这件事存在的：给了
 * 内边距之后，`fitBounds`、`easeTo` 的中心落在露出来的那一块中间，而不是落在被面
 * 板压住的视口中心。
 *
 * 这里只做换算、不碰 DOM，所以能测。量面板的是 `lib/panelController.ts`，用结果
 * 的是 `components/map/MapStage.vue`。
 */

/** 外壳的三种排布。断点只在 `globals.css` 里定义，JS 读 `--shell-mode`。 */
export type ShellMode = "desktop" | "tablet" | "phone";

/** 页面声明的面板宽度。平板上 `wide` 由 CSS 退回 `standard`，这里不管。 */
export type PanelWidth = "standard" | "wide";

export type RailState = "collapsed" | "expanded";

/** 面板在视口里的位置，就是 `getBoundingClientRect()` 的那四个数。 */
export interface PanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PanelLayout {
  mode: ShellMode;
  /** 桌面 / 平板上收成一条，或手机上抽屉收到只剩把手。 */
  collapsed: boolean;
  rect: PanelRect;
}

export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 面板离视口边缘的留白，和 `globals.css` 的 `--shell-inset` 同值。 */
export const PANEL_GAP_PX = 12;

/**
 * 地图可见区至少留这么宽（手机上是这么高）。
 *
 * 窗口窄到面板几乎占满时照算，内边距会大过视口，MapLibre 对负的可见区的反应是镜
 * 头乱跳 —— 看起来像地图坏了，而不是像窗口太窄。
 */
export const MIN_VISIBLE_PX = 160;

export function parseShellMode(raw: string): ShellMode {
  const value = raw.trim();
  return value === "desktop" || value === "tablet" ? value : "phone";
}

/**
 * 轨此刻到底是收着还是展开。
 *
 * `data-rail="auto"` 是「成员没选过」：RailScript 找不到存下来的值时写它，由 CSS
 * 按宽度给出 `--rail-auto`。成员一旦点过折叠钮，写进去的就是确定值，auto 不再参与。
 */
export function effectiveRail(
  dataRail: string | undefined,
  autoValue: string,
): RailState {
  if (dataRail === "collapsed" || dataRail === "expanded") return dataRail;
  return autoValue.trim() === "collapsed" ? "collapsed" : "expanded";
}

/**
 * 面板盖住了哪一块，换成地图的内边距。
 *
 * 桌面和平板上面板在左边，让出 `rect.right`；手机上它是底部的抽屉，让出视口底边
 * 到 `rect.top` 那一截。其余三边只留一道留白，让控件不贴边。
 *
 * 用的是**面板此刻的矩形**而不是它声明的宽度：折叠、抽屉拖到一半、平板上 wide 退
 * 回 standard，都已经反映在矩形里了，这里不必再知道一遍规则。
 */
export function mapPaddingFor(
  layout: PanelLayout,
  viewport: { width: number; height: number },
): MapPadding {
  const gap = PANEL_GAP_PX;
  if (layout.mode === "phone") {
    const covered = Math.max(0, viewport.height - layout.rect.top);
    const bottom = Math.min(
      covered + gap,
      Math.max(0, viewport.height - MIN_VISIBLE_PX),
    );
    return { top: gap, right: gap, bottom, left: gap };
  }
  const left = Math.min(
    Math.max(0, layout.rect.right) + gap,
    Math.max(0, viewport.width - gap - MIN_VISIBLE_PX),
  );
  return { top: gap, right: gap, bottom: gap, left };
}
