<script setup lang="ts">
/**
 * 外壳。**这个站没有站头** —— 凡是会被放进顶栏的东西都在这条轨里。
 *
 * 为什么没有：EFB 是给飞行员在飞行途中看的，屏幕多半是横放的平板或者副屏，
 * 竖直方向是最紧张的资源。一条 64px 的顶栏在 1280×800 上吃掉 8% 的高度，而它
 * 装的东西 —— 品牌、搜索、主题、账户 —— 每一样在侧栏里都放得下，因为侧栏紧
 * 张的是**水平**方向，而那正是这条轨可以收成一列图标的原因。
 *
 * 由此带来的三个后果，都是这里必须自己解决的：
 *
 * 1. 手机上没有顶栏可以挂汉堡按钮。所以左下角有一颗浮动按钮拉开抽屉 —— 放左
 *    下而不是右上，是因为没有顶栏的页面里那颗按钮离拇指最近，右下留给了将来
 *    的页面级动作。
 * 2. can-web 的顶栏里那颗 ⌘K 快速跳转不能跟着顶栏一起消失，它现在是轨里品牌
 *    下面的第一件东西。折叠态退化成一个放大镜方块。
 * 3. 主题、语言、账户在轨脚。轨脚是 `mt-auto` 撑下去的，不是绝对定位 —— 导航
 *    项多到需要滚动时，轨脚要跟着滚走，而不是盖在最后一个链接上。
 *
 * 折叠状态存在 <html data-rail> 上而不是这个组件的 state 里，因为正文那一列的
 * 左内边距也要跟着变，而正文是 Astro 渲染的静态 HTML，和这个岛屿之间没有响应
 * 式通道。详见 globals.css 的 "can-efb only" 一节和 RailScript.astro。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { useOverlay } from "@/lib/useOverlay";
import Icon from "@/components/ui/Icon.vue";
import SidebarNav from "@/components/ui/SidebarNav.vue";
import ThemeLangControls from "@/components/ui/ThemeLangControls.vue";
import type { NavSection } from "@/lib/nav";
import type { EfbUser } from "@/lib/session";

const props = withDefaults(
  defineProps<{
    sections: NavSection[];
    crossLinks: NavSection;
    pathname: string;
    messages: Record<string, unknown>;
    locale?: string;
    /**
     * 当前成员。中间件保证了页面路由上它一定有值（整站要登录），所以下面那个
     * 「未登录」分支实际上走不到 —— 留着是因为组件不该假设调用方一定先做过重
     * 定向，而且 can-api 不可达时它是唯一还能渲染出来的东西。
     */
    user?: EfbUser | null;
    /** 登录页地址；由 `@/lib/config` 的 `signInUrl()` 给出（指向 can-web）。 */
    signInHref?: string;
  }>(),
  { locale: "zh-cn", user: null },
);

const t = createTranslator(props.messages);

/* --------------------------------------------------------------------------
   折叠
-------------------------------------------------------------------------- */
const collapsed = ref(false);

function applyCollapsed(next: boolean) {
  collapsed.value = next;
  document.documentElement.dataset.rail = next ? "collapsed" : "expanded";
  try {
    localStorage.setItem("efb.rail", next ? "collapsed" : "expanded");
  } catch {
    // 隐私模式下 localStorage 会抛。折叠这件事不值得为它中断，本次会话内仍然
    // 生效，只是下次打开回到默认展开。
  }
}

/* --------------------------------------------------------------------------
   手机抽屉
-------------------------------------------------------------------------- */
const drawerOpen = ref(false);
const drawerPanel = useOverlay(drawerOpen);

/* --------------------------------------------------------------------------
   快速跳转（⌘K）。顶栏没了，它得有个新家；这是轨里最上面的那颗按钮。
   只收本站页面：跨站链接点过去是另一个域，混在同一个列表里会让「跳转」这个
   动作有两种完全不同的后果。
-------------------------------------------------------------------------- */
const searchOpen = ref(false);
const query = ref("");
const highlighted = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);
const searchPanel = useOverlay(searchOpen, { initialFocus: searchInput });

interface FlatNavItem {
  name: string;
  href: string;
  icon: string;
  section?: string;
}

const flatNav = computed<FlatNavItem[]>(() =>
  props.sections.flatMap((section) =>
    section.items
      .filter((item) => !item.external && item.href && item.href !== "#")
      .map((item) => ({
        name: item.name,
        href: item.href,
        icon: item.icon,
        section: section.label,
      })),
  ),
);

const results = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return flatNav.value;
  return flatNav.value.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) ||
      item.section?.toLowerCase().includes(needle) ||
      item.href.toLowerCase().includes(needle),
  );
});

function openSearch() {
  query.value = "";
  highlighted.value = 0;
  searchOpen.value = true;
}
function go(href: string) {
  window.location.href = href;
}
function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlighted.value = Math.min(
      highlighted.value + 1,
      results.value.length - 1,
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    highlighted.value = Math.max(highlighted.value - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const target = results.value[highlighted.value];
    if (target) go(target.href);
  }
  // Escape 由 useOverlay 处理，它同时负责把焦点还给触发按钮。
}

/* --------------------------------------------------------------------------
   账户
-------------------------------------------------------------------------- */
const accountOpen = ref(false);
const accountRoot = ref<HTMLElement | null>(null);
const accountButton = ref<HTMLElement | null>(null);

const initials = computed(() => {
  const parts = (props.user?.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
});

/**
 * 退出登录。
 *
 * 清 cookie 是 can-api 的活 —— 属性（域、SameSite、Secure）是它设的，这边补一
 * 个对不上的 Set-Cookie 只会让浏览器同时留着两个。跳转是我们的，而且**无论成
 * 败都跳**：按了退出的人不该因为请求失败就还停在一个登录态的页面上。
 */
const signingOut = ref(false);
function handleSignOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  api("/api/v1/auth/signout", { method: "POST" }).finally(() => {
    window.location.assign("/");
  });
}

/* -------------------------------------------------------------------------- */

function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (searchOpen.value) searchOpen.value = false;
    else openSearch();
  } else if (event.key === "Escape" && accountOpen.value) {
    accountOpen.value = false;
    accountButton.value?.focus();
  }
}
function onGlobalClick(event: MouseEvent) {
  if (!accountRoot.value?.contains(event.target as Node)) {
    accountOpen.value = false;
  }
}

onMounted(() => {
  // RailScript 已经在首屏之前把 data-rail 写好了；这里只是把它读回来，而不是
  // 第二次判断 —— 两处各读一次 localStorage 就会有两种可能不一致的答案。
  collapsed.value = document.documentElement.dataset.rail === "collapsed";
  document.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("click", onGlobalClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("click", onGlobalClick);
});
</script>

<template>
  <div>
    <!-- 键盘用户第一站，可以整条轨跳过去。 -->
    <a
      href="#main-content"
      class="btn btn-primary sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60]"
    >
      {{ t("skipToContent") }}
    </a>

    <!-- ===================== 桌面轨（lg 起） ===================== -->
    <div
      class="app-rail hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:flex lg:flex-col"
    >
      <div
        class="flex grow flex-col gap-y-4 overflow-y-auto overscroll-contain border-r border-subtle bg-surface-sunken px-3 py-4"
      >
        <!-- 品牌 -->
        <a
          href="/"
          class="rail-item flex items-center gap-2.5 rounded-control px-1.5 py-1 transition-colors hover:bg-surface-raised"
          :title="collapsed ? t('siteName') : undefined"
        >
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-control bg-airwaysn text-xs font-bold tracking-tight text-white"
          >
            {{ t("shortName") }}
          </span>
          <span class="rail-label min-w-0">
            <span class="block truncate text-sm font-semibold text-ink">
              {{ t("siteName") }}
            </span>
          </span>
        </a>

        <!-- 快速跳转。顶栏里那颗搬到了这里。 -->
        <button
          type="button"
          class="rail-item flex w-full items-center gap-2 rounded-control border border-subtle bg-surface px-2.5 py-2 text-sm text-faint transition-colors hover:border-strong hover:text-muted"
          :aria-label="t('search.label')"
          :title="collapsed ? t('search.label') : undefined"
          @click="openSearch"
        >
          <Icon name="magnifyingGlass" class="size-4 shrink-0" />
          <span class="rail-label truncate">{{ t("search.placeholder") }}</span>
          <kbd
            class="rail-label ml-auto shrink-0 rounded border border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[0.625rem]"
          >
            ⌘K
          </kbd>
        </button>

        <SidebarNav
          :sections="sections"
          :pathname="pathname"
          :collapsed="collapsed"
          :label="t('rail.label')"
        />

        <!-- 轨脚：跨站链接 + 主题语言 + 账户 + 折叠开关。mt-auto 而不是绝对
             定位，导航长到要滚动时它跟着滚。 -->
        <div class="mt-auto flex flex-col gap-y-3 pt-4">
          <SidebarNav
            :sections="[crossLinks]"
            :pathname="pathname"
            :collapsed="collapsed"
            :label="crossLinks.label ?? ''"
          />

          <div class="border-t border-subtle pt-3">
            <!-- 账户 -->
            <div ref="accountRoot" class="relative">
              <button
                v-if="user"
                ref="accountButton"
                type="button"
                class="rail-item flex w-full items-center gap-2.5 rounded-control px-1.5 py-1.5 transition-colors hover:bg-surface-raised"
                :aria-expanded="accountOpen"
                aria-haspopup="menu"
                :aria-label="t('account.menu')"
                :title="collapsed ? user.name : undefined"
                @click="accountOpen = !accountOpen"
              >
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-full bg-airwaysn text-xs font-semibold text-white"
                >
                  {{ initials }}
                </span>
                <span class="rail-label min-w-0 flex-1 text-left">
                  <span class="block truncate text-sm font-semibold text-ink">
                    {{ user.name }}
                  </span>
                  <span class="block truncate font-mono text-xs text-faint">
                    #{{ user.id }}
                  </span>
                </span>
                <Icon
                  name="chevronUpDown"
                  class="rail-label size-4 shrink-0 text-faint"
                />
              </button>

              <!-- 未登录。这里**不画**登录按钮，除非上层传了地址进来 —— 理由
                   见 props 上的注释。 -->
              <a
                v-else-if="signInHref"
                :href="signInHref"
                class="rail-item flex w-full items-center gap-2.5 rounded-control px-1.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-raised hover:text-ink"
                :title="collapsed ? t('account.signIn') : undefined"
              >
                <Icon
                  name="arrowLeftOnRectangle"
                  class="size-5 shrink-0 text-faint"
                />
                <span class="rail-label truncate">{{
                  t("account.signIn")
                }}</span>
              </a>
              <div
                v-else
                class="rail-item flex items-center gap-2.5 px-1.5 py-1.5"
                :title="collapsed ? t('account.signedOut') : undefined"
              >
                <Icon name="userCircle" class="size-8 shrink-0 text-faint" />
                <span class="rail-label min-w-0">
                  <span class="block truncate text-sm font-medium text-muted">
                    {{ t("account.signedOut") }}
                  </span>
                  <span class="block text-xs leading-snug text-faint">
                    {{ t("account.signedOutHint") }}
                  </span>
                </span>
              </div>

              <div
                v-if="accountOpen && user"
                role="menu"
                class="absolute bottom-full left-0 z-50 mb-2 w-56 origin-bottom-left overflow-hidden rounded-card border border-subtle bg-surface-overlay py-1 shadow-popover"
              >
                <a
                  href="/settings"
                  role="menuitem"
                  class="flex items-center gap-2.5 px-4 py-2.5 text-sm text-muted transition-colors hover:bg-surface-sunken hover:text-ink"
                >
                  <Icon name="cog6Tooth" class="size-4" />
                  {{ t("nav.settings") }}
                </a>
                <button
                  type="button"
                  role="menuitem"
                  :disabled="signingOut"
                  class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-muted transition-colors hover:bg-surface-sunken hover:text-danger disabled:opacity-50"
                  @click="handleSignOut"
                >
                  <Icon name="arrowRightOnRectangle" class="size-4" />
                  {{ t("account.signOut") }}
                </button>
              </div>
            </div>

            <!-- 主题 / 语言 / 折叠。折叠态下这一行竖过来，否则三颗按钮挤不进
                 4.75rem。 -->
            <div
              :class="[
                'mt-1 flex items-center gap-0.5',
                collapsed ? 'flex-col' : '',
              ]"
            >
              <ThemeLangControls :locale="locale" />
              <!-- 展开时 ml-auto 把折叠钮推到最右；折叠时这一行是竖排的，
                   ml-auto 反而会把它顶出去，所以那一档不加。两个类同时挂上去
                   是**不行**的：Tailwind 的胜负由生成样式表里的先后决定，不是
                   class 属性里的顺序 —— can-radar 的 ThemeLangControls 正被这
                   一条咬过一次（fixed 输给了 relative）。 -->
              <button
                type="button"
                class="flex size-9 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-raised hover:text-ink"
                :class="collapsed ? '' : 'ml-auto'"
                :aria-label="collapsed ? t('rail.expand') : t('rail.collapse')"
                :title="collapsed ? t('rail.expand') : t('rail.collapse')"
                @click="applyCollapsed(!collapsed)"
              >
                <Icon
                  :name="collapsed ? 'chevronDoubleRight' : 'chevronDoubleLeft'"
                  class="size-5"
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===================== 手机：浮动按钮 + 抽屉 ===================== -->
    <button
      type="button"
      class="fixed bottom-4 left-4 z-40 flex size-12 items-center justify-center rounded-full border border-subtle bg-chrome text-ink shadow-popover transition-colors hover:bg-surface-raised lg:hidden"
      :aria-label="t('rail.open')"
      :aria-expanded="drawerOpen"
      @click="drawerOpen = true"
    >
      <Icon name="bars3" class="size-6" />
    </button>

    <div
      v-if="drawerOpen"
      class="relative z-50 lg:hidden"
      role="dialog"
      aria-modal="true"
      :aria-label="t('rail.label')"
    >
      <div
        class="animate-overlay-in fixed inset-0 bg-gray-900/50 backdrop-blur-sm"
        @click="drawerOpen = false"
      ></div>
      <div class="fixed inset-0 flex">
        <div
          ref="drawerPanel"
          class="animate-drawer-in relative mr-16 flex w-full max-w-xs flex-1"
          tabindex="-1"
        >
          <div class="absolute left-full top-0 flex w-16 justify-center pt-5">
            <button
              type="button"
              class="-m-2.5 p-2.5 text-white/80 transition-colors hover:text-white"
              :aria-label="t('rail.close')"
              @click="drawerOpen = false"
            >
              <Icon name="xMark" class="size-6" />
            </button>
          </div>

          <!-- 抽屉里从不折叠：它已经是全宽的了，而 .rail-* 那组规则被
               `.app-rail` 限定在桌面轨上，所以这里不会被 data-rail 波及。 -->
          <div
            class="flex grow flex-col gap-y-4 overflow-y-auto overscroll-contain border-r border-subtle bg-surface px-4 py-4"
          >
            <a href="/" class="flex items-center gap-2.5 px-1.5 py-1">
              <span
                class="flex size-9 shrink-0 items-center justify-center rounded-control bg-airwaysn text-xs font-bold tracking-tight text-white"
              >
                {{ t("shortName") }}
              </span>
              <span class="truncate text-sm font-semibold text-ink">
                {{ t("siteName") }}
              </span>
            </a>

            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control border border-subtle bg-surface-sunken px-2.5 py-2 text-sm text-faint transition-colors hover:border-strong hover:text-muted"
              :aria-label="t('search.label')"
              @click="
                drawerOpen = false;
                openSearch();
              "
            >
              <Icon name="magnifyingGlass" class="size-4 shrink-0" />
              <span class="truncate">{{ t("search.placeholder") }}</span>
            </button>

            <SidebarNav
              :sections="sections"
              :pathname="pathname"
              :collapsed="false"
              :label="t('rail.label')"
            />

            <div class="mt-auto flex flex-col gap-y-3 pt-4">
              <SidebarNav
                :sections="[crossLinks]"
                :pathname="pathname"
                :collapsed="false"
                :label="crossLinks.label ?? ''"
              />
              <div
                class="flex items-center justify-between border-t border-subtle pt-3"
              >
                <span class="truncate text-sm text-muted">
                  {{ user ? user.name : t("account.signedOut") }}
                </span>
                <ThemeLangControls :locale="locale" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ===================== 快速跳转面板 ===================== -->
    <div
      v-if="searchOpen"
      class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-16 sm:pt-24"
      role="dialog"
      aria-modal="true"
      :aria-label="t('search.label')"
    >
      <div
        class="animate-overlay-in fixed inset-0 bg-gray-900/50 backdrop-blur-sm"
        @click="searchOpen = false"
      ></div>
      <div
        ref="searchPanel"
        class="animate-panel-in relative w-full max-w-lg overflow-hidden rounded-card border border-subtle bg-surface-overlay shadow-popover"
        tabindex="-1"
      >
        <div class="flex items-center gap-3 border-b border-subtle px-4">
          <Icon name="magnifyingGlass" class="size-5 shrink-0 text-faint" />
          <input
            ref="searchInput"
            v-model="query"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="quicknav-results"
            :placeholder="t('search.placeholder')"
            :aria-label="t('search.label')"
            class="h-12 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-faint sm:text-sm"
            @keydown="onSearchKeydown"
            @input="highlighted = 0"
          />
          <button
            type="button"
            class="-mr-2 inline-flex size-10 shrink-0 items-center justify-center rounded-control text-faint transition-colors hover:text-ink"
            :aria-label="t('rail.close')"
            @click="searchOpen = false"
          >
            <Icon name="xMark" class="size-5" />
          </button>
        </div>

        <ul
          v-if="results.length"
          id="quicknav-results"
          role="listbox"
          class="max-h-[50dvh] overflow-y-auto overscroll-contain p-2 sm:max-h-80"
        >
          <li
            v-for="(item, index) in results"
            :key="item.href"
            role="option"
            :aria-selected="index === highlighted"
          >
            <button
              type="button"
              tabindex="-1"
              :class="[
                'flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left text-sm transition-colors',
                index === highlighted
                  ? 'bg-surface-sunken text-ink'
                  : 'text-muted hover:bg-surface-sunken hover:text-ink',
              ]"
              @mouseenter="highlighted = index"
              @click="go(item.href)"
            >
              <Icon :name="item.icon" class="size-4 shrink-0 text-faint" />
              <span class="truncate font-medium">{{ item.name }}</span>
              <span v-if="item.section" class="truncate text-xs text-faint">
                {{ item.section }}
              </span>
              <Icon
                name="arrowRight"
                class="ml-auto size-4 shrink-0 text-faint"
              />
            </button>
          </li>
        </ul>
        <p v-else class="px-4 py-8 text-center text-sm text-muted">
          {{ t("search.noResults") }}
        </p>
      </div>
    </div>
  </div>
</template>
