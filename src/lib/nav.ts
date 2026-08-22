/**
 * 导航是**一份**数据，不是每个页面各自拼的一串链接。
 *
 * can-web 上每个页面自己拼站头和页脚，几十个页面之后它们就开始漂移；这里从第
 * 一天起就只有这一处。它同时喂三个消费者 —— 侧栏、快速跳转（⌘K）、以及将来
 * 的面包屑 —— 加一个页面只需要在这里加一行，三处一起长。
 *
 * 名字是 i18n 的**键**，不是文案：翻译发生在 `buildNav()` 里，因为岛屿拿到的
 * 必须是已经解析好的字符串（把整本词典序列化进 props 是 can-dev 特意避开的
 * 事，那会让每个页面的 HTML 里多出十几 KB）。
 */
import type { Translator } from "@/lib/i18n";

export interface NavLink {
  name: string;
  href: string;
  icon: string;
  /** 外链在侧栏里画一个小箭头，也不参与「当前页」判断。 */
  external?: boolean;
}

export interface NavSection {
  /** 分组标题；省略就是一组没有标题的链接（折叠态下退化成一条分隔线）。 */
  label?: string;
  items: NavLink[];
}

interface NavLinkSpec {
  key: string;
  href: string;
  icon: string;
  external?: boolean;
}
interface NavSectionSpec {
  labelKey?: string;
  items: NavLinkSpec[];
}

/**
 * 分节而不是可折叠的手风琴。
 *
 * can-web 的侧栏用的是带 children 的折叠组，那是为了塞下几十个页面。EFB 只有
 * 十个，而且轨可以收成一条图标栏 —— 手风琴在图标态下无处安放（点一个图标是
 * 展开还是跳转？），分节标题则可以直接隐藏掉，剩下的图标序列仍然可用。
 */
const SECTIONS: NavSectionSpec[] = [
  {
    items: [{ key: "dashboard", href: "/", icon: "squares2x2" }],
  },
  {
    labelKey: "sections.flight",
    items: [
      { key: "flightplan", href: "/flightplan", icon: "paperAirplane" },
      { key: "route", href: "/route", icon: "map" },
    ],
  },
  {
    /* 「简报」这一节现在只剩机场。
     *
     * 航图（`/charts`）从来只是一个 `Placeholder` —— 一个点下去只有占位的入口会
     * 被当成坏掉的页面，而不是还没做的页面，所以撤掉而不是留着占位。
     *
     * 气象（`/weather`）那一页是按站查 METAR 的浏览器。起降两地的 METAR 仍然
     * 在，长在 Dashboard 的飞行计划简报里（`v-if="plan"`）—— 那一块回答的是
     * 「我这趟飞的两头天气如何」，和一个通用的查站工具不是一件事。 */
    labelKey: "sections.briefing",
    items: [{ key: "airports", href: "/airports", icon: "buildingOffice" }],
  },
  {
    items: [{ key: "settings", href: "/settings", icon: "cog6Tooth" }],
  },
];

/**
 * 钉在轨底的跨站链接。
 *
 * 四个站是同一个网络的四张脸，而 EFB 没有站头也没有页脚 —— 不放在这里，从
 * EFB 回主站就只能靠改地址栏。
 */
const CROSS_LINKS: NavLinkSpec[] = [
  {
    key: "web",
    href: "https://ceruleanavi.net",
    icon: "globeAlt",
    external: true,
  },
  {
    key: "radar",
    href: "https://radar.ceruleanavi.net",
    icon: "signal",
    external: true,
  },
  {
    key: "dev",
    href: "https://platform.ceruleanavi.net",
    icon: "commandLine",
    external: true,
  },
];

/** 把上面的键解析成当前语言的文案。在 Astro 侧调用，结果作为 props 进岛屿。 */
export function buildNav(t: Translator): NavSection[] {
  return SECTIONS.map((section) => ({
    label: section.labelKey ? t(section.labelKey) : undefined,
    items: section.items.map((item) => ({
      name: t(`nav.${item.key}`),
      href: item.href,
      icon: item.icon,
      external: item.external,
    })),
  }));
}

export function buildCrossLinks(t: Translator): NavSection {
  return {
    label: t("links.label"),
    items: CROSS_LINKS.map((item) => ({
      name: t(`links.${item.key}`),
      href: item.href,
      icon: item.icon,
      external: item.external,
    })),
  };
}
