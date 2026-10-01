<script setup lang="ts">
/** 航图弹出层的一行：类别、名称、页码、「自动」标记，右边是钉住按钮。 */
import ChartPinButton from "@/components/ChartPinButton.vue";
import { CHART_TAG_CLASS } from "@/components/chartTags";
import type { ChartEntry } from "@/lib/charts";

defineProps<{
  chart: ChartEntry;
  pinned: boolean;
  /** 计划和程序选择自动挑中的。 */
  auto: boolean;
  labels: { auto: string; pin: string; unpin: string };
}>();
const emit = defineEmits<{ open: []; toggle: [] }>();
</script>

<template>
  <li class="flex items-stretch gap-1">
    <button type="button" class="map-chart-pin-row" @click="emit('open')">
      <span
        class="w-10 shrink-0 font-mono text-xs font-semibold"
        :class="CHART_TAG_CLASS[chart.category]"
      >
        {{ chart.category }}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-ink">{{ chart.name }}</span>
        <span
          v-if="chart.page || auto"
          class="mt-0.5 flex items-center gap-2 text-xs text-muted"
        >
          <span v-if="chart.page" class="font-mono">{{ chart.page }}</span>
          <span v-if="auto" class="badge">{{ labels.auto }}</span>
        </span>
      </span>
    </button>
    <ChartPinButton
      :pinned="pinned"
      :label="`${pinned ? labels.unpin : labels.pin} ${chart.name}`"
      @toggle="emit('toggle')"
    />
  </li>
</template>
