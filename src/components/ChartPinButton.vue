<script setup lang="ts">
/** 钉住 / 取消钉住一张航图。地图的航图弹出层和机场详情的航图标签共用。 */
import { Icon } from "@jianyuelab-org/can-ui";

defineProps<{
  pinned: boolean;
  /** 已翻译，带航图名：「取消钉住 ILSDMEyRWY16L」。 */
  label: string;
}>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="flex w-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-overlay)]"
    :aria-pressed="pinned"
    :aria-label="label"
    :title="label"
    @click="emit('toggle')"
  >
    <Icon
      name="star"
      class="size-4"
      :class="pinned ? 'fill-current text-amber-500' : 'text-faint'"
    />
  </button>
</template>
