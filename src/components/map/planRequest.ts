/**
 * `map:plan`（`showPlanOnMap`）收到时，航路层该变成什么样。纯函数，测试见
 * planRequest.test.ts；用它的是 useRouteLayer 里那个订阅。
 *
 * 这一声的意思是「地图，回到我已提交的那份计划」。别的页面留下的东西都得走：
 *
 * - 焦点（机场页挑过一个机场）：留着的话镜头一直对着它，`fitPoints` 永远轮不到。
 * - 标注（机场页推来的点）：它们也参与框选，会把视野撑到计划之外。
 * - 图上画的**不是**计划时，面板推来的点和角标也清掉。计划随后读不到、解析不出
 *   来的话，留着的旧航路就在冒充计划 —— `clearPlanRoute` 只在画的是计划时才调，
 *   管不到这一种。画的是计划就留着，等 `loadPlanRoute` 重读后原地替换。
 */
import type { MapFocus, MapPoint } from "@/lib/mapBus";

export interface RouteLayerView {
  points: MapPoint[];
  markers: MapPoint[];
  focus: MapFocus | null;
  label: string;
}

export function viewForPlanRequest(
  current: RouteLayerView & { planShown: boolean },
  defaultLabel: string,
): RouteLayerView & { pointsChanged: boolean } {
  const keep = current.planShown;
  return {
    points: keep ? current.points : [],
    markers: [],
    focus: null,
    label: keep ? current.label : defaultLabel,
    pointsChanged: !keep && current.points.length > 0,
  };
}
