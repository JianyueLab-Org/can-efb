import { describe, expect, test } from "bun:test";
import { railTabs } from "@jianyuelab-org/can-ui/frame";
import { buildNav } from "@/lib/nav";

/**
 * 导航是 can-ui 的 `NavItem[]`，五个平铺的链接：概览、飞行计划、航路、机场、设置。
 * `phoneTab` 标的是三页（`railTabs` 按它分）。
 */
const t = (key: string) => key;

describe("buildNav", () => {
  test("五个平铺的页面，顺序照规格", () => {
    const nav = buildNav(t);
    expect(nav.map((item) => [item.name, item.href])).toEqual([
      ["nav.dashboard", "/"],
      ["nav.flightplan", "/flightplan"],
      ["nav.route", "/route"],
      ["nav.airports", "/airports"],
      ["nav.settings", "/settings"],
    ]);
    expect(nav.every((item) => !item.children)).toBe(true);
  });

  test("每一项都有图标", () => {
    for (const item of buildNav(t)) expect(item.icon).toBeTruthy();
  });

  test("没有外链：跨站链接由外壳的 NetworkMenu 给", () => {
    expect(buildNav(t).every((item) => item.href?.startsWith("/"))).toBe(true);
  });

  test("手机标签：概览、飞行计划、航路；机场和设置进「我的」", () => {
    const { tabs, overflow } = railTabs(buildNav(t));
    expect(tabs.map((link) => link.href)).toEqual([
      "/",
      "/flightplan",
      "/route",
    ]);
    expect(overflow.map((link) => link.href)).toEqual([
      "/airports",
      "/settings",
    ]);
  });
});
