/**
 * 轨此刻收着还是展开：从 DOM 上读（`currentRail`），往 DOM 上写（`setRail`）。
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

/**
 * 把轨设成收起或展开：写 `data-rail`，并存成偏好（`RailScript` 下次首屏读它）。
 *
 * 只写 `data-rail`，不碰谁的 state：AppRail 用 MutationObserver 从它读回来，设置页
 * 的开关也一样。两处的写法曾经各有一份，这里是唯一的写入口。
 */
export function setRail(next: RailState): void {
  document.documentElement.dataset.rail = next;
  try {
    localStorage.setItem("efb.rail", next);
  } catch {
    // 隐私模式下 localStorage 会抛。折叠这件事不值得为它中断，本次会话内仍然
    // 生效，只是下次打开回到默认（按宽度定，见 RailScript）。
  }
}
