<script setup lang="ts">
/**
 * 侧栏里的链接列表。
 *
 * 形状是从 can-web/src/components/ui/SidebarNav.vue 来的，但把可折叠的 children
 * 换成了扁平的分节 —— 理由写在 src/lib/nav.ts 里：轨能收成图标态，而手风琴在
 * 图标态下没有讲得通的交互。
 *
 * 折叠态不由 prop 控制，而是读 <html data-rail>：正文那一列也要跟着变，两处共
 * 用一个 CSS 变量才不会打架（见 globals.css 的 "can-efb only" 一节）。这里只
 * 需要在折叠时把 aria-label 补上 —— 文字被 CSS 藏起来了，读屏软件不能跟着一起
 * 失明。
 */
import Icon from "@/components/ui/Icon.vue";
import type { NavSection } from "@/lib/nav";

const props = defineProps<{
  sections: NavSection[];
  pathname: string;
  /** 折叠态下给每一项挂原生 title，当作图标的悬浮提示。 */
  collapsed: boolean;
  label: string;
}>();

function isCurrentPath(href: string): boolean {
  if (!href || href === "#" || href.startsWith("http")) return false;
  // 根路由必须精确匹配，否则「概览」在每一个子路由上都亮着。
  if (href === "/") return props.pathname === "/";
  if (props.pathname === href) return true;
  if (props.pathname.startsWith(href)) {
    const nextChar = props.pathname[href.length];
    return !nextChar || nextChar === "/";
  }
  return false;
}

const baseItem =
  "rail-item group flex w-full items-center gap-x-3 rounded-control px-2.5 py-2 text-sm font-medium transition-colors duration-150";
const activeItem = "bg-surface-raised text-airwaysn shadow-card";
const idleItem = "text-muted hover:bg-surface-raised hover:text-ink";
</script>

<template>
  <nav class="flex flex-1 flex-col gap-y-5" :aria-label="label">
    <div v-for="(section, index) in sections" :key="section.label ?? index">
      <!-- 分节标题。折叠态下换成一条分隔线：标题是一串汉字，塞不进 4.75rem，
           而完全去掉分隔会让十个图标连成一片。第一节没有上边界，跳过。 -->
      <h2
        v-if="section.label"
        class="rail-label px-2.5 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-widest text-faint"
      >
        {{ section.label }}
      </h2>
      <hr
        v-if="collapsed && index > 0"
        class="mx-auto mb-2 w-6 border-t border-subtle"
      />

      <ul role="list" class="-mx-1 space-y-0.5">
        <li v-for="item in section.items" :key="item.href">
          <a
            :href="item.href"
            :target="item.external ? '_blank' : undefined"
            :rel="item.external ? 'noopener noreferrer' : undefined"
            :aria-current="isCurrentPath(item.href) ? 'page' : undefined"
            :aria-label="collapsed ? item.name : undefined"
            :title="collapsed ? item.name : undefined"
            :class="[
              baseItem,
              isCurrentPath(item.href) ? activeItem : idleItem,
            ]"
          >
            <Icon
              :name="item.icon"
              :class="[
                'size-5 shrink-0',
                isCurrentPath(item.href)
                  ? 'text-airwaysn'
                  : 'text-faint group-hover:text-muted',
              ]"
            />
            <span class="rail-label truncate">{{ item.name }}</span>
            <Icon
              v-if="item.external"
              name="arrowTopRight"
              class="rail-label ml-auto size-3.5 shrink-0 text-faint"
            />
          </a>
        </li>
      </ul>
    </div>
  </nav>
</template>
