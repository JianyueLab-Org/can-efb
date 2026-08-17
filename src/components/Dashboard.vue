<script setup lang="ts">
/**
 * 概览：这次飞行开始之前要看的那几件事，一屏之内。
 *
 * 它自己**不产生任何数据** —— 全部是别的页面已经在用的那几个接口的组合：当前
 * 计划、起降两地的 METAR、飞行时间统计。所以这一页永远不会显示别处看不到的东
 * 西，也就不会和别处对不上。
 *
 * 三个请求是**并发**发出去的，而且互相不阻塞：METAR 要等计划回来才知道查哪两
 * 个机场，但统计不用等，所以它单独走。一个失败不影响另外两个渲染 —— 天气挂了
 * 不该让人看不到自己的计划。
 */
import { onMounted, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { Icon } from "@jianyuelab-org/can-ui";

const props = defineProps<{
  messages: Record<string, unknown>;
  userName: string;
}>();
const t = createTranslator(props.messages);

interface Plan {
  callsign: string;
  aircraft: string;
  departure: string;
  arrival: string;
  alternate: string;
  departureTime: string;
  cruisingAltitude: string;
  route: string;
  updatedAt: string;
}
interface Summary {
  totalFlights: number;
  formattedTotalTime: string;
}

const plan = ref<Plan | null>(null);
const planLoading = ref(true);
const summary = ref<Summary | null>(null);
const metars = ref<Record<string, string | null>>({});

async function loadMetar(icao: string) {
  if (!icao) return;
  const result = await api<{ icao: string; metar: string | null }>(
    `/api/v1/metar?icao=${encodeURIComponent(icao)}`,
  );
  // 失败和「没有报文」在这一页上是同一件事：都显示成没有。天气是辅助信息，
  // 不值得为它在概览上摆一个错误框。
  metars.value[icao] = result.ok ? result.data.metar : null;
}

async function loadPlan() {
  const result = await api<Plan | null>("/api/v1/pilot/flightplan");
  planLoading.value = false;
  if (!result.ok) return;
  plan.value = result.data ?? null;
  if (plan.value) {
    void loadMetar(plan.value.departure);
    void loadMetar(plan.value.arrival);
  }
}

async function loadSummary() {
  const result = await api<{ summary: Summary }>("/api/v1/pilot/flights");
  if (result.ok) summary.value = result.data.summary;
}

onMounted(() => {
  void loadPlan();
  void loadSummary();
});
</script>

<template>
  <div class="space-y-5">
    <p class="text-sm text-muted">
      {{ t("dashboard.greeting", { name: userName }) }}
    </p>

    <!-- 当前计划 -->
    <section class="card p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold text-ink">
          {{ t("dashboard.plan.title") }}
        </h2>
        <a href="/flightplan" class="link text-sm">{{
          plan ? t("dashboard.plan.edit") : t("dashboard.plan.file")
        }}</a>
      </div>

      <p v-if="planLoading" class="skeleton mt-3 h-6 w-2/3"></p>

      <p v-else-if="!plan" class="mt-3 text-sm text-muted">
        {{ t("dashboard.plan.none") }}
      </p>

      <template v-else>
        <div class="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="font-mono text-xl font-semibold text-ink">{{
            plan.callsign
          }}</span>
          <span class="font-mono text-xl text-ink">
            {{ plan.departure }}
            <Icon name="arrowRight" class="inline size-4 text-faint" />
            {{ plan.arrival }}
          </span>
          <span v-if="plan.alternate" class="font-mono text-sm text-muted">
            {{ t("dashboard.plan.alternate") }} {{ plan.alternate }}
          </span>
        </div>
        <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.aircraft") }}
            </dt>
            <dd class="truncate font-mono text-ink">{{ plan.aircraft }}</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.off") }}
            </dt>
            <dd class="font-mono text-ink">{{ plan.departureTime }}Z</dd>
          </div>
          <div>
            <dt class="text-xs uppercase tracking-wide text-faint">
              {{ t("dashboard.plan.level") }}
            </dt>
            <dd class="font-mono text-ink">{{ plan.cruisingAltitude }}</dd>
          </div>
        </dl>
        <p
          v-if="plan.route"
          class="mt-3 break-words font-mono text-xs text-muted"
        >
          {{ plan.route }}
        </p>
      </template>
    </section>

    <!-- 起降天气 -->
    <section v-if="plan" class="grid gap-3 sm:grid-cols-2">
      <div
        v-for="icao in [plan.departure, plan.arrival]"
        :key="icao"
        class="card p-4"
      >
        <h3 class="font-mono text-sm font-semibold text-ink">{{ icao }}</h3>
        <p
          v-if="metars[icao]"
          class="mt-2 break-words font-mono text-xs leading-relaxed text-muted"
        >
          {{ metars[icao] }}
        </p>
        <p v-else class="mt-2 text-xs text-faint">
          {{ t("dashboard.weather.none") }}
        </p>
      </div>
    </section>

    <!-- 统计 -->
    <section v-if="summary" class="grid gap-3 sm:grid-cols-2">
      <div class="card flex items-baseline justify-between p-4">
        <span class="text-sm text-muted">{{ t("logbook.stats.flights") }}</span>
        <span class="text-xl font-semibold text-ink">{{
          summary.totalFlights
        }}</span>
      </div>
      <div class="card flex items-baseline justify-between p-4">
        <span class="text-sm text-muted">{{ t("logbook.stats.total") }}</span>
        <span class="font-mono text-xl font-semibold text-ink">{{
          summary.formattedTotalTime
        }}</span>
      </div>
    </section>
  </div>
</template>
