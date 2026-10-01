/** 航图类别的文字色。机场详情的航图标签和地图的航图弹出层共用。 */
import type { ChartCategory } from "@/lib/charts";

export const CHART_TAG_CLASS: Record<ChartCategory, string> = {
  STAR: "text-emerald-700 dark:text-emerald-300",
  APP: "text-orange-700 dark:text-orange-300",
  TAXI: "text-blue-700 dark:text-blue-300",
  SID: "text-pink-700 dark:text-pink-300",
  REF: "text-violet-700 dark:text-violet-300",
};
