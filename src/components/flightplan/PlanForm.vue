<script setup lang="ts">
/**
 * 计划表单本身：只管字段、错误和提交按钮，不发任何请求。
 *
 * 错误是 can-api 422 的 `fields`（字段 → 错误码），翻译在这里做；**这里不重写任何
 * 校验规则** —— 规则只在 can-api 一处，前端再抄一份就会有两份不一致的规则。
 *
 * 宽面板下两列、窄面板下一列，由 FieldGrid 按面板宽度决定。时分两格用 `group`，
 * 读屏软件读到的是「航路时间，小时」「航路时间，分钟」。
 */
import { createTranslator } from "@/lib/i18n";
import { FLIGHT_RULES, type Plan } from "@/lib/flightPlan";
import Field from "@/components/ui/Field.vue";
import FieldGrid from "@/components/ui/FieldGrid.vue";
import PanelSection from "@/components/ui/PanelSection.vue";
import { Icon } from "@jianyuelab-org/can-ui";

const form = defineModel<Plan>("form", { required: true });
const props = defineProps<{
  messages: Record<string, unknown>;
  errors: Record<string, string>;
  disabled: boolean;
  submitLabel: string;
  /** 航路画不出来的原因，已经翻好；空串＝没什么要说的。 */
  previewNote: string;
}>();
const emit = defineEmits<{ submit: [] }>();
const t = createTranslator(props.messages);

function errorFor(...fields: string[]): string {
  for (const field of fields) {
    const code = props.errors[field];
    if (code) return t(`flightplan.errors.${code}`);
  }
  return "";
}

/** 一行纯文本输入的公共属性，省得每一格都抄一遍。 */
const TEXT_FIELDS = [
  { key: "callsign", mono: true, upper: true, placeholder: "CCA1501" },
  {
    key: "aircraft",
    mono: true,
    upper: true,
    placeholder: "A320/M-SDE2E3FGHIRWY/LB1",
  },
  {
    key: "cruiseTas",
    mono: true,
    upper: false,
    placeholder: "450",
    numeric: true,
  },
  { key: "departure", mono: true, upper: true, placeholder: "ZBAA", max: 4 },
  {
    key: "departureTime",
    mono: true,
    upper: false,
    placeholder: "1230",
    max: 4,
  },
  { key: "arrival", mono: true, upper: true, placeholder: "ZSSS", max: 4 },
  { key: "alternate", mono: true, upper: true, placeholder: "ZSPD", max: 4 },
  { key: "cruisingAltitude", mono: true, upper: true, placeholder: "FL350" },
] as const satisfies readonly {
  key: keyof Plan;
  mono: boolean;
  upper: boolean;
  placeholder: string;
  numeric?: boolean;
  max?: number;
}[];

const PAIRS = [
  {
    label: "enroute",
    hours: "hoursEnroute",
    minutes: "minutesEnroute",
    ph: ["02", "15"],
  },
  {
    label: "fuel",
    hours: "fuelHours",
    minutes: "fuelMinutes",
    ph: ["03", "30"],
  },
] as const;
</script>

<template>
  <form class="space-y-6" @submit.prevent="emit('submit')">
    <fieldset :disabled="disabled" class="space-y-6">
      <PanelSection :title="t('flightplan.sections.flight')" :level="3">
        <FieldGrid>
          <Field
            :label="t('flightplan.fields.flightRules')"
            :error="errorFor('flightRules')"
          >
            <template #default="{ id, describedby, invalid }">
              <select
                :id="id"
                v-model="form.flightRules"
                class="input"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              >
                <option v-for="rule in FLIGHT_RULES" :key="rule" :value="rule">
                  {{ t(`flightplan.rules.${rule}`) }}
                </option>
              </select>
            </template>
          </Field>

          <Field
            v-for="f in TEXT_FIELDS"
            :key="f.key"
            :label="t(`flightplan.fields.${f.key}`)"
            :error="errorFor(f.key)"
          >
            <template #default="{ id, describedby, invalid }">
              <input
                :id="id"
                v-model="form[f.key]"
                class="input"
                :class="[
                  f.mono ? 'font-mono' : '',
                  f.upper ? 'uppercase' : '',
                  invalid ? 'input-error' : '',
                ]"
                autocomplete="off"
                :inputmode="'numeric' in f ? 'numeric' : undefined"
                :maxlength="'max' in f ? f.max : undefined"
                :placeholder="f.placeholder"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              />
            </template>
          </Field>

          <Field
            v-for="p in PAIRS"
            :key="p.label"
            :label="t(`flightplan.fields.${p.label}`)"
            :error="errorFor(p.hours, p.minutes)"
            group
          >
            <template #default="{ describedby, invalid, labelledby }">
              <div
                role="group"
                :aria-labelledby="labelledby"
                :aria-describedby="describedby"
                class="flex items-center gap-2"
              >
                <input
                  v-model="form[p.hours]"
                  class="input font-mono"
                  :class="invalid ? 'input-error' : ''"
                  maxlength="2"
                  inputmode="numeric"
                  :aria-label="t('flightplan.fields.hours')"
                  :aria-invalid="invalid"
                  :placeholder="p.ph[0]"
                />
                <span class="text-faint" aria-hidden="true">:</span>
                <input
                  v-model="form[p.minutes]"
                  class="input font-mono"
                  :class="invalid ? 'input-error' : ''"
                  maxlength="2"
                  inputmode="numeric"
                  :aria-label="t('flightplan.fields.minutes')"
                  :aria-invalid="invalid"
                  :placeholder="p.ph[1]"
                />
              </div>
            </template>
          </Field>
        </FieldGrid>
      </PanelSection>

      <PanelSection :title="t('flightplan.sections.route')" :level="3">
        <FieldGrid>
          <Field
            :label="t('flightplan.fields.route')"
            :hint="previewNote || undefined"
            :error="errorFor('route')"
            wide
          >
            <template #default="{ id, describedby, invalid }">
              <textarea
                :id="id"
                v-model="form.route"
                class="input min-h-20 font-mono uppercase"
                :class="invalid ? 'input-error' : ''"
                placeholder="ELKUR A461 SASAN W82 PIMOL"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              ></textarea>
            </template>
          </Field>
          <Field
            :label="t('flightplan.fields.remarks')"
            :error="errorFor('remarks')"
            wide
          >
            <template #default="{ id, describedby, invalid }">
              <textarea
                :id="id"
                v-model="form.remarks"
                class="input min-h-16"
                :class="invalid ? 'input-error' : ''"
                :aria-describedby="describedby"
                :aria-invalid="invalid"
              ></textarea>
            </template>
          </Field>
        </FieldGrid>
      </PanelSection>
    </fieldset>

    <!-- 提交按钮贴在面板底部：长表单滚到一半也按得到。 -->
    <div
      class="panel-sticky-bar flex justify-end border-t border-subtle bg-[var(--material-regular)] py-3"
    >
      <button type="submit" class="btn btn-primary" :disabled="disabled">
        <Icon name="paperAirplane" class="size-4" />
        {{ submitLabel }}
      </button>
    </div>
  </form>
</template>
