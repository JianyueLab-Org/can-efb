import { describe, expect, test } from "bun:test";
import { nextTabIndex } from "@/lib/tabs";

/**
 * 标签页键盘换标签的索引算术，从 RouteTabs.vue 的 `onKey` 里抽出来单独测：
 * 折返、Home/End、以及标签数变了（比如以后加第三个标签）的时候最容易错，而错了
 * 只在人真的按方向键时才看得出来 —— 没有浏览器可验的这一轮尤其要靠测试钉住。
 */
describe("nextTabIndex", () => {
  test("ArrowRight 在末尾折返到 0", () => {
    expect(nextTabIndex("ArrowRight", 1, 2)).toBe(0);
  });

  test("ArrowLeft 在开头折返到最后一个", () => {
    expect(nextTabIndex("ArrowLeft", 0, 2)).toBe(1);
  });

  test("Home 总是回到 0", () => {
    expect(nextTabIndex("Home", 1, 2)).toBe(0);
  });

  test("End 总是到最后一个", () => {
    expect(nextTabIndex("End", 0, 2)).toBe(1);
  });

  test("不认识的键返回 null", () => {
    expect(nextTabIndex("Enter", 0, 2)).toBeNull();
    expect(nextTabIndex(" ", 1, 2)).toBeNull();
  });

  test("三个标签：中间往右、往左都不折返", () => {
    expect(nextTabIndex("ArrowRight", 1, 3)).toBe(2);
    expect(nextTabIndex("ArrowLeft", 1, 3)).toBe(0);
  });

  test("三个标签：两端折返", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  test("三个标签：Home/End", () => {
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
  });
});
