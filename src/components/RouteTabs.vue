<script setup lang="ts">
/**
 * 航路页的两件事：生成、展开。**先生成，后展开** —— 还没有航路的人要第一件，已经有
 * 一串航路的人要第二件（route.astro 原来的顺序和理由）。
 *
 * 做成标签页而不是上下两段：面板只有 26rem 宽，两段叠着的话展开那一段永远在折叠
 * 线以下，手机上更是整整一屏之外。
 *
 * 两个面板用 `v-show` 而不是 `v-if`：切过去再切回来，生成的结果、选好的程序、展开
 * 的表格都还在。生成器里的程序缓存本来就是模块级的，这里只是不把组件本身卸掉。
 *
 * 键盘按 WAI-ARIA 标签页的做法：左右箭头换标签并激活，Home/End 到两端，只有当前
 * 那个标签在 Tab 顺序里。索引算术（折返、Home/End）抽到 `lib/tabs.ts` 的
 * `nextTabIndex` 里单独测 —— 这一轮没有浏览器可以验证按键效果，错了只有真的按
 * 下方向键才看得出来。
 *
 * **没有 `aipAccess` prop。** 以前这里要把它转给 RouteGenerator 去出「不使用受限
 * 汇编」那个开关；那个开关现在是设置页的全站开关（lib/naip.ts），生成这一侧不用
 * 再知道权限档位。Generate 对所有人可见，can-db 的 401/403 由 RouteGenerator 自己
 * 画成 forbidden 状态卡 —— 见它顶上的说明。
 */
import { nextTick, ref, useId } from "vue";
import { createTranslator } from "@/lib/i18n";
import { nextTabIndex } from "@/lib/tabs";
import PanelSection from "@/components/ui/PanelSection.vue";
import RouteGenerator from "./RouteGenerator.vue";
import RoutePlanner from "./RoutePlanner.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

const TABS = ["generate", "expand"] as const;
type Tab = (typeof TABS)[number];

const base = useId();
const active = ref<Tab>("generate");
const tabEls = ref<HTMLButtonElement[]>([]);

function select(tab: Tab) {
  active.value = tab;
}

async function onKey(event: KeyboardEvent) {
  // 折返和 Home/End 的算术在 lib/tabs.ts（纯函数，见 tabs.test.ts）；这里只管
  // 副作用：换状态、防默认滚动、把焦点带过去。
  const next = nextTabIndex(event.key, TABS.indexOf(active.value), TABS.length);
  if (next === null) return;
  event.preventDefault();
  select(TABS[next]);
  await nextTick();
  tabEls.value[next]?.focus();
}
</script>

<template>
  <div class="space-y-5">
    <div
      role="tablist"
      :aria-label="t('route.tabs.label')"
      class="flex gap-1 rounded-control bg-surface-sunken p-1"
      @keydown="onKey"
    >
      <button
        v-for="tab in TABS"
        :id="`${base}-tab-${tab}`"
        :key="tab"
        ref="tabEls"
        type="button"
        role="tab"
        :aria-selected="active === tab"
        :aria-controls="`${base}-panel-${tab}`"
        :tabindex="active === tab ? 0 : -1"
        class="flex-1 rounded-control px-3 py-1.5 text-sm font-medium transition-colors"
        :class="
          active === tab
            ? 'bg-surface text-ink shadow-sm'
            : 'text-muted hover:text-ink'
        "
        @click="select(tab)"
      >
        {{ t(`route.tabs.${tab}`) }}
      </button>
    </div>

    <div
      v-show="active === 'generate'"
      :id="`${base}-panel-generate`"
      role="tabpanel"
      :aria-labelledby="`${base}-tab-generate`"
      tabindex="0"
    >
      <PanelSection :title="t('route.generate.title')">
        <RouteGenerator :messages="messages" />
      </PanelSection>
    </div>

    <div
      v-show="active === 'expand'"
      :id="`${base}-panel-expand`"
      role="tabpanel"
      :aria-labelledby="`${base}-tab-expand`"
      tabindex="0"
    >
      <PanelSection :title="t('route.expand.title')">
        <RoutePlanner :messages="messages" />
      </PanelSection>
    </div>
  </div>
</template>
