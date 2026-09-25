/**
 * WAI-ARIA 标签页的键盘算术：当前索引 + 按键 → 下一个索引。
 *
 * 从 `RouteTabs.vue` 的 `onKey` 里抽出来，是因为这一段折返（末尾右箭头回到 0、
 * 开头左箭头到最后一个）和 Home/End 全是纯计算，而这一轮没有浏览器可以验证 ——
 * 错一位是折返方向错了还是差一，光看代码看不出来，屏幕上却要按下方向键才会
 * 暴露。见 `src/lib/tabs.test.ts`。
 */
export function nextTabIndex(
  key: string,
  current: number,
  length: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % length;
    case "ArrowLeft":
      return (current - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}
