<script setup lang="ts">
/**
 * 本站的外壳：can-ui 的 `CanFrame`，`layout="rail"`。只传数据。
 *
 * 轨、手机标签栏和「我的」面板、⌘K、跨站菜单、主题语言、账户和退出登录都在
 * can-ui 里。折叠状态在 `<html data-rail>` 上，由 can-ui 的 `RailScript` 在首屏
 * 之前写好（`BaseLayout.astro`）。
 *
 * 默认插槽是浮动面板，落在 `<main id="main-content">` 里。地图不进插槽：它靠
 * `transition:persist` 跨页面存活，AppLayout 把它放在 Frame 后面。
 *
 * 退出登录 POST 本站 `/api/v1/auth/signout`，反代原样带回 can-api 的
 * `Set-Cookie`；之后去 can-web 的 `/`（`after-sign-out="web"`）。
 */
import {
  CanFrame,
  type NavChild,
  type NavItem,
  type SiteOrigins,
} from "@jianyuelab-org/can-ui";
import type { FrameUser } from "@jianyuelab-org/can-ui/frame";

defineProps<{
  locale: string;
  pathname: string;
  nav: NavItem[];
  user: FrameUser | null;
  profileItems: NavChild[];
  signInHref: string;
  /** `getMessages(locale, "efb.frame")`。 */
  messages: Record<string, unknown>;
  /** `originsFromEnv(import.meta.env)`。 */
  origins: SiteOrigins;
}>();
</script>

<template>
  <CanFrame
    layout="rail"
    current="efb"
    :locale="locale"
    :pathname="pathname"
    :nav="nav"
    :user="user"
    notifications
    :profile-items="profileItems"
    :sign-in-href="signInHref"
    after-sign-out="web"
    :messages="messages"
    :origins="origins"
  >
    <slot />
  </CanFrame>
</template>
