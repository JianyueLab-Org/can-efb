<script setup lang="ts">
/**
 * 从 SimBrief 导入。
 *
 * **导入完不提交** —— 只把 OFP 填进表单，交不交由成员自己按。SimBrief 里的计划常
 * 常是几天前排的，静默提交出去就是一份他没检查过的计划挂在网上。
 *
 * 自己不写横幅：成功把计划交回容器（`imported`），失败把已经翻好的一句话交回去
 * （`failed`），横幅只有容器那一条。
 */
import { ref } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import type { Plan } from "@/lib/flightPlan";
import { Icon } from "@jianyuelab-org/can-ui";

const props = defineProps<{
  messages: Record<string, unknown>;
  disabled: boolean;
}>();
const emit = defineEmits<{
  imported: [plan: Plan];
  failed: [text: string];
  /** 导入开始（true）和结束（false）。容器拿它锁表单：导入途中改的字段会被
   *  OFP 静默盖掉，途中按提交交的是导入前那份。 */
  busy: [importing: boolean];
}>();
const t = createTranslator(props.messages);

const importing = ref(false);

async function run() {
  if (importing.value) return;
  importing.value = true;
  emit("busy", true);
  const result = await api<Plan>("/api/v1/pilot/simbrief/import");
  importing.value = false;
  emit("busy", false);

  if (!result.ok) {
    emit(
      "failed",
      result.error === "not_linked"
        ? t("flightplan.notice.notLinked")
        : describeFailure(t, result),
    );
    return;
  }
  emit("imported", result.data);
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      class="btn btn-secondary"
      :disabled="importing || disabled"
      :aria-busy="importing"
      @click="run"
    >
      <Icon name="arrowDownTray" class="size-4" />
      {{ importing ? t("common.loading") : t("flightplan.actions.import") }}
    </button>
    <p class="min-w-0 flex-1 text-xs text-muted">
      {{ t("flightplan.import.hint") }}
    </p>
  </div>
</template>
