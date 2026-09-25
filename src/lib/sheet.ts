/**
 * 手机上面板变成底部抽屉，三档：收起（只剩把手）、一半、拉满。
 *
 * 这里只算数：每一档对应多少像素的向下平移、松手之后该落到哪一档。拖动本身在
 * `lib/panelController.ts`，那一半碰 DOM，这一半能测。
 *
 * 松手的判定借 can-ui 的 `projectToDetent`：先按速度把手势往前推一段，再挑最近
 * 的一档。只按松手位置挑的话，一次干脆的快甩和一次慢拖在同一个像素松手结果一
 * 样，快甩等于白甩。
 */
import { projectToDetent } from "@jianyuelab-org/can-ui/motion";
import type { PanelWidth } from "@/lib/panelLayout";

export type SheetSnap = "collapsed" | "half" | "full";

export interface SheetGeometry {
  /** 抽屉拉满时的高度，px。 */
  height: number;
  /** 收起时还露在外面的那一截，px —— 把手加标题行。 */
  peek: number;
}

/** 收起时露出来的高度。够放把手和一行标题，少了就没地方下手把它拉回来。 */
export const SHEET_PEEK_PX = 72;

/** 每一档对应的向下平移量。拉满是 0。 */
export function sheetOffsets({
  height,
  peek,
}: SheetGeometry): Record<SheetSnap, number> {
  const h = Math.max(0, height);
  const collapsed = Math.max(0, h - Math.max(0, peek));
  return {
    full: 0,
    half: Math.min(Math.round(h / 2), collapsed),
    collapsed,
  };
}

/**
 * 松手之后落到哪一档。
 *
 * @param offset 松手那一刻的平移量，px
 * @param velocity 松手那一刻的竖直速度，px/s，向下为正
 */
export function snapAfterDrag(
  offset: number,
  velocity: number,
  geometry: SheetGeometry,
): SheetSnap {
  const o = sheetOffsets(geometry);
  const target = projectToDetent(offset, velocity, [
    o.full,
    o.half,
    o.collapsed,
  ]);
  if (target === o.full) return "full";
  if (target === o.half) return "half";
  return "collapsed";
}

/**
 * 打开一页时抽屉停在哪一档。
 *
 * 表单页（`wide`：飞行计划、设置）要打字，一半高度放不下键盘上方的输入框；地图页
 * 停在一半，把图让出来。宽度本来就是按「是不是表单页」声明的，所以直接从它推。
 */
export function initialSnap(width: PanelWidth): SheetSnap {
  return width === "wide" ? "full" : "half";
}
