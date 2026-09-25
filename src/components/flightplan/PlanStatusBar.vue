<script setup lang="ts">
/**
 * 「我现在有没有一份计划」那一行，外加撤销。
 *
 * **失败排在「没有」前面**：先判 `stored` 的话，读取失败会落进「当前没有已提交的飞
 * 行计划」—— 而他可能有，此时再交一份就是拿空白表单覆盖他没看到的那份。
 */
import { createTranslator } from "@/lib/i18n";
import { formatUtc, type StoredPlan } from "@/lib/flightPlan";
import StateCard from "@/components/ui/StateCard.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  loading: boolean;
  loadFailed: boolean;
  stored: StoredPlan | null;
  disabled: boolean;
}>();
const emit = defineEmits<{ reload: []; delete: [] }>();
const t = createTranslator(props.messages);
</script>

<template>
  <StateCard
    v-if="loading"
    kind="loading"
    :title="t('common.loading')"
    compact
  />
  <StateCard
    v-else-if="loadFailed"
    kind="error"
    :title="t('flightplan.status.failed')"
    :retry-label="t('common.refresh')"
    compact
    @retry="emit('reload')"
  />
  <div
    v-else
    class="flex flex-col gap-3 rounded-card border border-subtle p-4 @sm:flex-row @sm:items-center @sm:justify-between"
  >
    <div v-if="stored" class="min-w-0 text-sm">
      <p class="font-semibold text-ink">
        {{ t("flightplan.status.filed") }}
        <span class="font-mono">{{ stored.callsign }}</span>
        <span class="text-muted">
          {{ stored.departure }} → {{ stored.arrival }}</span
        >
      </p>
      <p class="mt-0.5 text-xs text-faint">
        {{ t("flightplan.status.updatedAt") }}
        {{ formatUtc(stored.updatedAt) }}
        <span v-if="stored.filedFromClient">
          · {{ t("flightplan.status.fromClient") }}</span
        >
      </p>
    </div>
    <p v-else class="text-sm text-muted">{{ t("flightplan.status.none") }}</p>

    <button
      v-if="stored"
      type="button"
      class="btn btn-danger shrink-0"
      :disabled="disabled"
      @click="emit('delete')"
    >
      {{ t("flightplan.actions.delete") }}
    </button>
  </div>
</template>
