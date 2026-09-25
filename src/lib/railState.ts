/**
 * 轨此刻收着还是展开，从 DOM 上读。
 *
 * AppRail 的箭头和设置页的「收起侧栏」开关问的是同一个问题，答案必须一致：两处各
 * 写一遍，迟早有一处忘了 `auto` 要问 CSS，平板上开关就和轨对不上。判断本身在
 * `lib/panelLayout.ts` 的 `effectiveRail`（纯函数、有测试）；这里只负责把 `data-rail`
 * 和 `--rail-auto` 两个输入取出来。
 */
import { effectiveRail, type RailState } from "@/lib/panelLayout";

export function currentRail(): RailState {
  const root = document.documentElement;
  return effectiveRail(
    root.dataset.rail,
    getComputedStyle(root).getPropertyValue("--rail-auto"),
  );
}
