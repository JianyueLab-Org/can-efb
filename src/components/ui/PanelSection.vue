<script setup lang="ts">
/**
 * 面板里的一节：一个标题，下面是内容。
 *
 * 替掉各页里那种光秃秃的 `<h2 class="mb-3 text-sm …">`：一样的字号和间距各写一遍，
 * 就是 can-web 上页面之间开始漂移的样子（PageHeader.astro 顶上那段）。`section`
 * 用 `aria-labelledby` 挂上标题，读屏的「区域」列表里就能跳到它。
 */
import { useId } from "vue";

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** 面板里页面标题是 h1，节标题默认 h2；节里再套一节用 3。 */
    level?: 2 | 3;
  }>(),
  { level: 2 },
);

const headingId = useId();
</script>

<template>
  <section class="panel-section" :aria-labelledby="headingId">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <component
          :is="level === 3 ? 'h3' : 'h2'"
          :id="headingId"
          class="text-sm font-semibold text-ink"
        >
          {{ title }}
        </component>
        <p v-if="description" class="mt-1 text-sm text-muted">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
    <div class="mt-3">
      <slot />
    </div>
  </section>
</template>
