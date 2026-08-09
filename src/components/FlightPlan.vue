<script setup lang="ts">
/**
 * 飞行计划：读、填、交、撤。
 *
 * 这一页是整个 EFB 里唯一会**写**东西的地方，所以 can-api 那三个失败分支都得
 * 在界面上有对应的样子，不能都塌成一句「保存失败」：
 *
 * - **422 validation** 带着逐字段的 `fields`，直接落到那个输入框下面。can-api
 *   的校验是权威，前端不重写一遍规则 —— 抄一份正则在这里，两边迟早会分叉，而
 *   分叉的方向一定是前端放行了后端拒绝的东西。
 * - **409 tracked** 是「这架飞机的雷达标牌正被某位管制员占着」。此时计划归他
 *   改，表单要整个锁上并说清是谁 —— can-fsd 在推送**之前**就判掉了，所以数据
 *   库里什么都没留下，重试也没用。
 * - **409 callsignInUse** 是别人正用这个呼号连着。
 *
 * SimBrief 是**导入到表单**，不是直接提交。can-api 那边的注释写得很清楚：直接
 * 提交等于把一份成员自己没看过的计划推到全网管制员面前。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import Icon from "@/components/ui/Icon.vue";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

/** 和 can-api 的 `flightplan.Plan` 逐字段对应。全是字符串，那边也是。 */
interface Plan {
  callsign: string;
  flightRules: string;
  aircraft: string;
  cruiseTas: string;
  departure: string;
  departureTime: string;
  cruisingAltitude: string;
  arrival: string;
  alternate: string;
  hoursEnroute: string;
  minutesEnroute: string;
  fuelHours: string;
  fuelMinutes: string;
  remarks: string;
  route: string;
}

interface StoredPlan extends Plan {
  filedFromClient: boolean;
  updatedAt: string;
}

function blank(): Plan {
  return {
    callsign: "",
    flightRules: "I",
    aircraft: "",
    cruiseTas: "",
    departure: "",
    departureTime: "",
    cruisingAltitude: "",
    arrival: "",
    alternate: "",
    hoursEnroute: "",
    minutesEnroute: "",
    fuelHours: "",
    fuelMinutes: "",
    remarks: "",
    route: "",
  };
}

const form = reactive<Plan>(blank());
const fieldErrors = ref<Record<string, string>>({});

const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);
const importing = ref(false);

/** 已存在的计划；null 表示这名成员现在没有计划。 */
const stored = ref<StoredPlan | null>(null);

/** 顶部那条横幅：成功、失败、或者被管制员锁住。 */
const notice = ref<{ kind: "ok" | "error" | "locked"; text: string } | null>(
  null,
);
/** 被锁时占着标牌的管制员，锁定态下表单整个禁用。 */
const lockedBy = ref<string | null>(null);

const disabled = computed(
  () => loading.value || saving.value || deleting.value || !!lockedBy.value,
);

function fill(plan: Partial<Plan>) {
  for (const key of Object.keys(form) as (keyof Plan)[]) {
    const value = plan[key];
    if (typeof value === "string") form[key] = value;
  }
}

async function load() {
  loading.value = true;
  const result = await api<StoredPlan | null>("/api/v1/pilot/flightplan");
  loading.value = false;

  if (!result.ok) {
    notice.value = { kind: "error", text: result.message };
    return;
  }
  stored.value = result.data ?? null;
  if (result.data) fill(result.data);
}

async function file() {
  if (saving.value) return;
  saving.value = true;
  notice.value = null;
  fieldErrors.value = {};

  const result = await api<StoredPlan>("/api/v1/pilot/flightplan", {
    method: "POST",
    body: JSON.stringify({ ...form }),
  });
  saving.value = false;

  if (result.ok) {
    notice.value = { kind: "ok", text: t("flightplan.notice.filed") };
    void load();
    return;
  }

  if (result.status === 422 && result.fields) {
    fieldErrors.value = result.fields;
    notice.value = { kind: "error", text: t("flightplan.notice.invalid") };
    return;
  }
  if (result.error === "tracked") {
    lockedBy.value = result.controller ?? "—";
    notice.value = {
      kind: "locked",
      text: t("flightplan.notice.tracked", { controller: lockedBy.value }),
    };
    return;
  }
  notice.value = { kind: "error", text: result.message };
}

async function remove() {
  if (deleting.value) return;
  // 原生 confirm 会冻住整个页面直到有人点掉它，在这里是可以接受的：撤销计划是
  // 不可逆的，而这一页没有别的地方能承载「你确定吗」而不打断填表。
  if (!window.confirm(t("flightplan.confirmDelete"))) return;

  deleting.value = true;
  notice.value = null;
  const result = await api("/api/v1/pilot/flightplan", { method: "DELETE" });
  deleting.value = false;

  if (!result.ok) {
    if (result.error === "tracked") {
      lockedBy.value = result.controller ?? "—";
      notice.value = {
        kind: "locked",
        text: t("flightplan.notice.tracked", { controller: lockedBy.value }),
      };
      return;
    }
    notice.value = { kind: "error", text: result.message };
    return;
  }
  stored.value = null;
  fill(blank());
  notice.value = { kind: "ok", text: t("flightplan.notice.deleted") };
}

async function importSimbrief() {
  if (importing.value) return;
  importing.value = true;
  notice.value = null;

  const result = await api<Plan>("/api/v1/pilot/simbrief/import");
  importing.value = false;

  if (!result.ok) {
    notice.value = {
      kind: "error",
      text:
        result.error === "not_linked"
          ? t("flightplan.notice.notLinked")
          : result.message,
    };
    return;
  }
  fill(result.data);
  fieldErrors.value = {};
  // 导入完**不自动提交** —— 见文件顶部。
  notice.value = { kind: "ok", text: t("flightplan.notice.imported") };
}

onMounted(load);

const RULES = ["I", "V", "S", "D"];

function errorFor(field: string): string {
  const code = fieldErrors.value[field];
  return code ? t(`flightplan.errors.${code}`) : "";
}
</script>

<template>
  <div class="space-y-5">
    <!-- 横幅 -->
    <div
      v-if="notice"
      :class="[
        'flex items-start gap-2.5 rounded-card border px-4 py-3 text-sm',
        notice.kind === 'ok'
          ? 'border-subtle bg-success-bg text-success-fg'
          : notice.kind === 'locked'
            ? 'border-subtle bg-warning-bg text-warning-fg'
            : 'border-subtle bg-danger-bg text-danger-fg',
      ]"
      role="status"
    >
      <Icon
        :name="
          notice.kind === 'ok'
            ? 'checkCircle'
            : notice.kind === 'locked'
              ? 'shieldCheck'
              : 'exclamationTriangle'
        "
        class="mt-px size-4 shrink-0"
      />
      <span>{{ notice.text }}</span>
    </div>

    <!-- 当前状态 + 动作 -->
    <div
      class="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div class="min-w-0 text-sm">
        <p v-if="loading" class="text-muted">{{ t("common.loading") }}</p>
        <template v-else-if="stored">
          <p class="font-semibold text-ink">
            {{ t("flightplan.status.filed") }}
            <span class="font-mono">{{ stored.callsign }}</span>
            <span class="text-muted">
              {{ stored.departure }} → {{ stored.arrival }}</span
            >
          </p>
          <p class="mt-0.5 text-xs text-faint">
            {{ t("flightplan.status.updatedAt") }} {{ stored.updatedAt }}
            <span v-if="stored.filedFromClient">
              · {{ t("flightplan.status.fromClient") }}</span
            >
          </p>
        </template>
        <p v-else class="text-muted">{{ t("flightplan.status.none") }}</p>
      </div>

      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="importing || disabled"
          @click="importSimbrief"
        >
          <Icon name="arrowDownTray" class="size-4" />
          {{ importing ? t("common.loading") : t("flightplan.actions.import") }}
        </button>
        <button
          v-if="stored"
          type="button"
          class="btn btn-danger"
          :disabled="disabled"
          @click="remove"
        >
          {{ t("flightplan.actions.delete") }}
        </button>
      </div>
    </div>

    <form class="card space-y-5 p-5" @submit.prevent="file">
      <fieldset :disabled="disabled" class="space-y-5">
        <!-- 航空器 -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.callsign")
            }}</span>
            <input
              v-model="form.callsign"
              class="input font-mono uppercase"
              :class="errorFor('callsign') ? 'input-error' : ''"
              autocomplete="off"
              placeholder="CCA1501"
            />
            <span
              v-if="errorFor('callsign')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("callsign") }}</span
            >
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.flightRules")
            }}</span>
            <select v-model="form.flightRules" class="input">
              <option v-for="rule in RULES" :key="rule" :value="rule">
                {{ t(`flightplan.rules.${rule}`) }}
              </option>
            </select>
            <span
              v-if="errorFor('flightRules')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("flightRules") }}</span
            >
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.aircraft")
            }}</span>
            <input
              v-model="form.aircraft"
              class="input font-mono uppercase"
              :class="errorFor('aircraft') ? 'input-error' : ''"
              placeholder="A320/M-SDE2E3FGHIRWY/LB1"
            />
            <span
              v-if="errorFor('aircraft')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("aircraft") }}</span
            >
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.cruiseTas")
            }}</span>
            <input
              v-model="form.cruiseTas"
              class="input font-mono"
              :class="errorFor('cruiseTas') ? 'input-error' : ''"
              inputmode="numeric"
              placeholder="450"
            />
            <span
              v-if="errorFor('cruiseTas')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("cruiseTas") }}</span
            >
          </label>
        </div>

        <!-- 起降 -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.departure")
            }}</span>
            <input
              v-model="form.departure"
              class="input font-mono uppercase"
              :class="errorFor('departure') ? 'input-error' : ''"
              maxlength="4"
              placeholder="ZBAA"
            />
            <span
              v-if="errorFor('departure')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("departure") }}</span
            >
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.departureTime")
            }}</span>
            <input
              v-model="form.departureTime"
              class="input font-mono"
              :class="errorFor('departureTime') ? 'input-error' : ''"
              maxlength="4"
              placeholder="1230"
            />
            <span
              v-if="errorFor('departureTime')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("departureTime") }}</span
            >
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.arrival")
            }}</span>
            <input
              v-model="form.arrival"
              class="input font-mono uppercase"
              :class="errorFor('arrival') ? 'input-error' : ''"
              maxlength="4"
              placeholder="ZSSS"
            />
            <span
              v-if="errorFor('arrival')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("arrival") }}</span
            >
          </label>

          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.alternate")
            }}</span>
            <input
              v-model="form.alternate"
              class="input font-mono uppercase"
              :class="errorFor('alternate') ? 'input-error' : ''"
              maxlength="4"
              placeholder="ZSPD"
            />
            <span
              v-if="errorFor('alternate')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("alternate") }}</span
            >
          </label>
        </div>

        <!-- 高度 / 时间 / 燃油 -->
        <div class="grid gap-4 sm:grid-cols-3">
          <label class="block">
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.cruisingAltitude")
            }}</span>
            <input
              v-model="form.cruisingAltitude"
              class="input font-mono uppercase"
              :class="errorFor('cruisingAltitude') ? 'input-error' : ''"
              placeholder="FL350"
            />
            <span
              v-if="errorFor('cruisingAltitude')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("cruisingAltitude") }}</span
            >
          </label>

          <div>
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.enroute")
            }}</span>
            <div class="flex items-center gap-2">
              <input
                v-model="form.hoursEnroute"
                class="input font-mono"
                :class="errorFor('hoursEnroute') ? 'input-error' : ''"
                maxlength="2"
                inputmode="numeric"
                :aria-label="t('flightplan.fields.hours')"
                placeholder="02"
              />
              <span class="text-faint">:</span>
              <input
                v-model="form.minutesEnroute"
                class="input font-mono"
                :class="errorFor('minutesEnroute') ? 'input-error' : ''"
                maxlength="2"
                inputmode="numeric"
                :aria-label="t('flightplan.fields.minutes')"
                placeholder="15"
              />
            </div>
            <span
              v-if="errorFor('hoursEnroute') || errorFor('minutesEnroute')"
              class="mt-1 block text-xs text-danger"
              >{{
                errorFor("hoursEnroute") || errorFor("minutesEnroute")
              }}</span
            >
          </div>

          <div>
            <span class="mb-1 block text-sm font-medium text-ink">{{
              t("flightplan.fields.fuel")
            }}</span>
            <div class="flex items-center gap-2">
              <input
                v-model="form.fuelHours"
                class="input font-mono"
                :class="errorFor('fuelHours') ? 'input-error' : ''"
                maxlength="2"
                inputmode="numeric"
                :aria-label="t('flightplan.fields.hours')"
                placeholder="03"
              />
              <span class="text-faint">:</span>
              <input
                v-model="form.fuelMinutes"
                class="input font-mono"
                :class="errorFor('fuelMinutes') ? 'input-error' : ''"
                maxlength="2"
                inputmode="numeric"
                :aria-label="t('flightplan.fields.minutes')"
                placeholder="30"
              />
            </div>
            <span
              v-if="errorFor('fuelHours') || errorFor('fuelMinutes')"
              class="mt-1 block text-xs text-danger"
              >{{ errorFor("fuelHours") || errorFor("fuelMinutes") }}</span
            >
          </div>
        </div>

        <!-- 航路 / 备注 -->
        <label class="block">
          <span class="mb-1 block text-sm font-medium text-ink">{{
            t("flightplan.fields.route")
          }}</span>
          <textarea
            v-model="form.route"
            class="input min-h-20 font-mono uppercase"
            :class="errorFor('route') ? 'input-error' : ''"
            placeholder="ELKUR A461 SASAN W82 PIMOL"
          ></textarea>
          <span
            v-if="errorFor('route')"
            class="mt-1 block text-xs text-danger"
            >{{ errorFor("route") }}</span
          >
        </label>

        <label class="block">
          <span class="mb-1 block text-sm font-medium text-ink">{{
            t("flightplan.fields.remarks")
          }}</span>
          <textarea
            v-model="form.remarks"
            class="input min-h-16"
            :class="errorFor('remarks') ? 'input-error' : ''"
          ></textarea>
          <span
            v-if="errorFor('remarks')"
            class="mt-1 block text-xs text-danger"
            >{{ errorFor("remarks") }}</span
          >
        </label>
      </fieldset>

      <div
        class="flex items-center justify-end gap-2 border-t border-subtle pt-4"
      >
        <button type="submit" class="btn btn-primary" :disabled="disabled">
          <Icon name="paperAirplane" class="size-4" />
          {{
            saving
              ? t("flightplan.actions.filing")
              : stored
                ? t("flightplan.actions.refile")
                : t("flightplan.actions.file")
          }}
        </button>
      </div>
    </form>
  </div>
</template>
