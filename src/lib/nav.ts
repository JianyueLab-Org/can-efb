/**
 * 导航是**一份**数据：can-ui 的 `NavItem[]`。
 *
 * 轨、手机标签栏、「我的」面板和 ⌘K 都从它长出来（can-ui 的 `CanFrame`）。加一个
 * 页面只在这里加一行。
 *
 * 名字写 i18n 的**键**，文案在 `buildNav()` 里解析：岛屿拿到的是已经翻好的字符串。
 *
 * 照网络规格是五个平铺的链接，没有分组：概览、飞行计划、航路、机场、设置。
 *
 * `phoneTab`：手机标签栏放这三页（概览、飞行计划、航路 —— 飞行途中最常开的三页）。
 * 机场和设置在「我的」面板顶部。
 *
 * 跨站链接不在这里：外壳的 `NetworkMenu` 给。
 */
import type { Translator } from "@/lib/i18n";
// 深路径：包入口会顺带 import 一堆 .vue，`bun test` 读不了。
import type { NavItem } from "@jianyuelab-org/can-ui/nav";
import type { IconName } from "@jianyuelab-org/can-ui/icons";

interface NavLinkSpec {
  key: string;
  href: string;
  icon: IconName;
  phoneTab?: boolean;
}

/** 航图没有页面（版权数据）；按站查 METAR 的气象页删了，起降两地的 METAR 在概览的飞行计划简报里。 */
const NAV: NavLinkSpec[] = [
  { key: "dashboard", href: "/", icon: "squares2x2", phoneTab: true },
  {
    key: "flightplan",
    href: "/flightplan",
    icon: "paperAirplane",
    phoneTab: true,
  },
  { key: "route", href: "/route", icon: "map", phoneTab: true },
  { key: "airports", href: "/airports", icon: "buildingOffice" },
  { key: "settings", href: "/settings", icon: "cog6Tooth" },
];

/** 把上面的键解析成当前语言的文案。在 Astro 侧调用，结果作为 props 进岛屿。 */
export function buildNav(t: Translator): NavItem[] {
  return NAV.map((spec) => ({
    name: t(`nav.${spec.key}`),
    href: spec.href,
    icon: spec.icon,
    ...(spec.phoneTab ? { phoneTab: true } : {}),
  }));
}
