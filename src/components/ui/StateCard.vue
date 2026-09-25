<script setup lang="ts">
/**
 * 「这里现在是什么情况」的统一样子：还在读、真的没有、没读到、没有权限。
 *
 * 四种各有各的图标和措辞，**不许合并**：
 *
 * - `error` 必须带一个重试（`retryLabel` + `@retry`）。没读到的东西再读一次常常就
 *   有了，不给按钮等于让人去刷新整页。
 * - `forbidden` 是 can-db 的 401/403：说清楚这是权限、不是故障，和谁能开通。
 * - `empty` 只在**读到了、确实没有**时用 —— 读失败落到这里，就是那句读起来完全
 *   正常的假话（AGENTS.md〈别把「失败」画成「没有」〉）。
 *
 * 文案全部由调用方传进来、已经翻好：这个组件不认识词典，所以 Astro 页面（404）
 * 和岛屿都能直接用。外观借 can-ui 的 EmptyState，不另起一套。
 */
import { EmptyState, Spinner } from "@jianyuelab-org/can-ui";
import type { StateKind } from "@/lib/requestState";

withDefaults(
  defineProps<{
    kind: StateKind;
    title: string;
    body?: string;
    /** 只对 `error` 生效。 */
    retryLabel?: string;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{ retry: [] }>();

const ICONS: Record<Exclude<StateKind, "loading">, string> = {
  empty: "inbox",
  error: "exclamationTriangle",
  forbidden: "key",
};
</script>

<template>
  <div
    class="state-card rounded-card border border-subtle bg-surface-sunken"
    :data-state="kind"
    :role="
      kind === 'loading' ? undefined : kind === 'error' ? 'alert' : 'status'
    "
  >
    <!-- 读取中不给外层 role：Spinner 自己就是 role="status"，套两层读屏会念两遍。 -->
    <Spinner v-if="kind === 'loading'" :label="title" centered />
    <EmptyState
      v-else
      :title="title"
      :description="body"
      :icon="ICONS[kind]"
      :compact="compact"
    >
      <template
        v-if="(kind === 'error' && retryLabel) || $slots.action"
        #action
      >
        <div class="flex flex-wrap justify-center gap-2">
          <button
            v-if="kind === 'error' && retryLabel"
            type="button"
            class="btn btn-secondary"
            @click="emit('retry')"
          >
            {{ retryLabel }}
          </button>
          <slot name="action" />
        </div>
      </template>
    </EmptyState>
  </div>
</template>
