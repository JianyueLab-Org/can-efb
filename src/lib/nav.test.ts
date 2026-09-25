import { describe, expect, test } from "bun:test";
import { isCurrentPath } from "@/lib/nav";

/**
 * 当前页判错不报错：侧栏和标签栏上亮错一项，或者「概览」在每一页都亮着。侧栏和
 * 手机标签栏共用这一个判断，所以它从 SidebarNav.vue 搬到了这里。
 */
describe("isCurrentPath", () => {
  test("根路由只在根上亮", () => {
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath("/", "/route")).toBe(false);
  });

  test("子路由算在父项上，前缀相同的兄弟不算", () => {
    expect(isCurrentPath("/route", "/route")).toBe(true);
    expect(isCurrentPath("/route", "/route/expand")).toBe(true);
    expect(isCurrentPath("/route", "/routes")).toBe(false);
  });

  test("外链和空链接永远不亮", () => {
    expect(isCurrentPath("https://ceruleanavi.net", "/")).toBe(false);
    expect(isCurrentPath("#", "/")).toBe(false);
    expect(isCurrentPath("", "/")).toBe(false);
  });
});
