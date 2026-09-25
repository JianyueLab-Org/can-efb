<script setup lang="ts">
/**
 * 表单里的一格：标签、说明、错误，以及把它们连到输入框上的 `aria-describedby`。
 *
 * 以前每一格都手写 `<label><span>…</span><input/><span v-if="error">…</span></label>`，
 * 错误那一行和输入框之间没有任何关联 —— 看得见的人知道它说的是哪一格，读屏软件
 * 只读到一个孤零零的句子。
 *
 * **输入框由调用方放进插槽**：这里的输入有 input、select、textarea、两格并排的时分，
 * 形状各不相同。插槽参数给出它该挂的 `id`、`describedby`、`invalid`；`group` 时标
 * 签不是 `<label for>` 而是一个 id，调用方把 `labelledby` 挂到 `role="group"` 上。
 *
 * 错误文案来自 can-api 422 的 `fields`，翻译在调用方做 —— 这里不重写任何校验规则。
 */
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    error?: string;
    /** 两列排布下独占一整行（航路、备注）。 */
    wide?: boolean;
    /** 这一格里不止一个输入框（时 : 分）。 */
    group?: boolean;
  }>(),
  { wide: false, group: false },
);

const base = useId();
const inputId = `${base}-input`;
const labelId = `${base}-label`;
const hintId = `${base}-hint`;
const errorId = `${base}-error`;

const describedby = computed(
  () =>
    [props.hint ? hintId : "", props.error ? errorId : ""]
      .filter(Boolean)
      .join(" ") || undefined,
);
</script>

<template>
  <div class="field" :class="wide ? 'field-wide' : ''">
    <span
      v-if="group"
      :id="labelId"
      class="mb-1 block text-sm font-medium text-ink"
      >{{ label }}</span
    >
    <label
      v-else
      :id="labelId"
      :for="inputId"
      class="mb-1 block text-sm font-medium text-ink"
      >{{ label }}</label
    >
    <slot
      :id="inputId"
      :describedby="describedby"
      :invalid="!!error"
      :labelledby="labelId"
    />
    <p v-if="hint" :id="hintId" class="mt-1 text-xs text-muted">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="mt-1 text-xs text-danger">
      {{ error }}
    </p>
  </div>
</template>
