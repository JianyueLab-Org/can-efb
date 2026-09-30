import { describe, expect, test } from "bun:test";
import { railTabs } from "@jianyuelab-org/can-ui/frame";
import { buildNav, buildProfileItems } from "@/lib/nav";

/**
 * 导航是 can-ui 的 `NavItem[]`：有标题的一节是带 `children` 的组。轨、手机标签栏、
 * 「我的」面板和 ⌘K 都从这一份长出来。手机标签栏只放 `phoneTab` 的三页，其余在
 * 「我的」面板顶部。
 */
const t = (key: string) => key;

const hrefs = () =>
  buildNav(t).flatMap((item) => [
    ...(item.href ? [item.href] : []),
    ...(item.children ?? []).map((child) => child.href),
  ]);

describe("buildNav", () => {
  test("五个页面，顺序不变", () => {
    expect(hrefs()).toEqual([
      "/",
      "/flightplan",
      "/route",
      "/airports",
      "/settings",
    ]);
  });

  test("分组名来自 sections.*，链接名来自 nav.*", () => {
    const nav = buildNav(t);
    expect(nav.map((item) => item.name)).toEqual([
      "nav.dashboard",
      "sections.flight",
      "sections.briefing",
      "nav.settings",
    ]);
    expect(nav[1].href).toBeUndefined();
    expect(nav[1].children?.map((child) => child.name)).toEqual([
      "nav.flightplan",
      "nav.route",
    ]);
  });

  test("每一项和每个子项都有图标", () => {
    for (const item of buildNav(t)) {
      expect(item.icon).toBeTruthy();
      for (const child of item.children ?? []) expect(child.icon).toBeTruthy();
    }
  });

  test("没有外链：跨站链接由外壳的 NetworkMenu 给", () => {
    expect(hrefs().every((href) => href.startsWith("/"))).toBe(true);
  });

  test("手机标签：概览、飞行计划、航路；机场和设置进「我的」", () => {
    const { tabs, overflow } = railTabs(buildNav(t));
    expect(tabs).toEqual([
      { name: "nav.dashboard", href: "/", icon: "squares2x2" },
      { name: "nav.flightplan", href: "/flightplan", icon: "paperAirplane" },
      { name: "nav.route", href: "/route", icon: "map" },
    ]);
    expect(overflow.map((link) => link.href)).toEqual([
      "/airports",
      "/settings",
    ]);
  });
});

describe("buildProfileItems", () => {
  test("账户菜单里是设置", () => {
    expect(buildProfileItems(t)).toEqual([
      { name: "nav.settings", href: "/settings", icon: "cog6Tooth" },
    ]);
  });
});
