/**
 * 导航是**一份**数据：can-ui 的 `NavItem[]`。
 *
 * 轨、手机标签栏、「我的」面板和 ⌘K 都从它长出来（can-ui 的 `CanFrame`）。加一个
 * 页面只在这里加一行。
 *
 * 名字写 i18n 的**键**，文案在 `buildNav()` 里解析：岛屿拿到的是已经翻好的字符串。
 *
 * 有标题的一节是一个带 `children` 的组，没有 `href`。
 *
 * `phoneTab`：手机标签栏放这三页（概览、飞行计划、航路 —— 飞行途中最常开的三页），
 * 组里组外都可以标。机场和设置在「我的」面板顶部。
 *
 * 跨站链接不在这里：外壳的 `NetworkMenu` 给。
 */
import type { Translator } from "@/lib/i18n";
// 深路径：包入口会顺带 import 一堆 .vue，`bun test` 读不了。
import type { NavChild, NavItem } from "@jianyuelab-org/can-ui/nav";
import type { IconName } from "@jianyuelab-org/can-ui/icons";

interface NavLinkSpec {
  key: string;
  href: string;
  icon: IconName;
  phoneTab?: boolean;
}
interface NavGroupSpec {
  labelKey: string;
  icon: IconName;
  items: NavLinkSpec[];
}
type NavSpec = NavLinkSpec | NavGroupSpec;

/**
 * 分节而不是可折叠的手风琴：轨能收成图标态，手风琴在图标态下没有讲得通的交互。
 *
 * 「资料」一节只剩机场。航图没有页面（版权数据）；按站查 METAR 的气象页删了，起
 * 降两地的 METAR 在概览的飞行计划简报里。
 */
const NAV: NavSpec[] = [
  { key: "dashboard", href: "/", icon: "squares2x2", phoneTab: true },
  {
    labelKey: "sections.flight",
    icon: "paperAirplane",
    items: [
      {
        key: "flightplan",
        href: "/flightplan",
        icon: "paperAirplane",
        phoneTab: true,
      },
      { key: "route", href: "/route", icon: "map", phoneTab: true },
    ],
  },
  {
    labelKey: "sections.briefing",
    icon: "buildingOffice",
    items: [{ key: "airports", href: "/airports", icon: "buildingOffice" }],
  },
  { key: "settings", href: "/settings", icon: "cog6Tooth" },
];

function link(t: Translator, spec: NavLinkSpec): NavChild {
  return {
    name: t(`nav.${spec.key}`),
    href: spec.href,
    icon: spec.icon,
    ...(spec.phoneTab ? { phoneTab: true } : {}),
  };
}

/** 把上面的键解析成当前语言的文案。在 Astro 侧调用，结果作为 props 进岛屿。 */
export function buildNav(t: Translator): NavItem[] {
  return NAV.map((spec) =>
    "items" in spec
      ? {
          name: t(spec.labelKey),
          icon: spec.icon,
          children: spec.items.map((item) => link(t, item)),
        }
      : { ...link(t, spec), icon: spec.icon },
  );
}

/** 账户菜单里、退出登录上面的链接。 */
export function buildProfileItems(t: Translator): NavChild[] {
  return [{ name: t("nav.settings"), href: "/settings", icon: "cog6Tooth" }];
}
