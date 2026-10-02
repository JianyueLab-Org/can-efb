/** 航图类别的颜色。机场详情的航图标签、地图的航图列表和底部钉板共用。 */
import type { ChartCategory } from "@/lib/charts";
import type { StripColour } from "@/lib/pinboard";

export const CHART_TAG_CLASS: Record<ChartCategory, string> = {
  STAR: "text-emerald-700 dark:text-emerald-300",
  APP: "text-orange-700 dark:text-orange-300",
  TAXI: "text-blue-700 dark:text-blue-300",
  SID: "text-pink-700 dark:text-pink-300",
  REF: "text-violet-700 dark:text-violet-300",
};

/** 钉板标签顶上那道色条（`lib/pinboard.ts` 的 `STRIP_COLOUR`）。和上面同一组色相。 */
export const CHART_STRIP_CLASS: Record<StripColour, string> = {
  green: "border-t-emerald-500",
  orange: "border-t-orange-500",
  blue: "border-t-blue-500",
  pink: "border-t-pink-500",
  violet: "border-t-violet-500",
};
