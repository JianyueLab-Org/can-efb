<script setup lang="ts">
/**
 * 本站的外壳：can-ui 的 `CanFrame`，`layout="map" rail`。只传数据。
 *
 * 56px 顶栏（品牌、跨站菜单、⌘K、通知、主题语言、账户和退出登录）和图标轨都在
 * can-ui 里（账户菜单是 can-ui 固定的一份，本站不再塞条目）。≥768px 本站导航在
 * 左边的图标轨上；以下没有轨也没有标签栏，汉堡菜单打开的抽屉里是导航。
 *
 * 外壳在自己的根和 `:root` 上写 `--frame-top`（顶栏高）和 `--rail-current`
 * （≥768px 是轨宽，以下是 0），面板和地图按它们让位（`globals.css`）。
 *
 * 默认插槽落在 `<main id="main-content">` 里：浮动面板，或 404 的整块内容。地图不进插槽：它靠
 * `transition:persist` 跨页面存活，AppLayout 把它放在 Frame 后面。
 *
 * 退出登录 POST 本站 `/api/v1/auth/signout`，反代原样带回 can-api 的
 * `Set-Cookie`；之后按 `afterSignOut` 走：默认去 can-web 的 `/`。
 */
import {
  CanFrame,
  type NavItem,
  type SiteOrigins,
} from "@jianyuelab-org/can-ui";
import type { FrameUser } from "@jianyuelab-org/can-ui/frame";

defineProps<{
  locale: string;
  pathname: string;
  nav: NavItem[];
  user: FrameUser | null;
  signInHref: string;
  /** 退出登录之后：`web` 去 can-web 的 `/`，`reload` 留在当前页（公开页）。 */
  afterSignOut: "web" | "reload";
  /** `getMessages(locale, "efb.frame")`。 */
  messages: Record<string, unknown>;
  /** `originsFromEnv(import.meta.env)`。 */
  origins: SiteOrigins;
}>();
</script>

<template>
  <CanFrame
    layout="map"
    rail
    current="efb"
    :locale="locale"
    :pathname="pathname"
    :nav="nav"
    :user="user"
    notifications
    :sign-in-href="signInHref"
    :after-sign-out="afterSignOut"
    :messages="messages"
    :origins="origins"
  >
    <slot />
  </CanFrame>
</template>
