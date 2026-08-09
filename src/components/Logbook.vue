<script setup lang="ts">
/**
 * 飞行日志。`/api/v1/pilot/flights` 已经把统计算好了，这里不重算。
 *
 * 那边连 `formattedDuration` 都一起给了，前端**用它**而不是拿 `durationMs` 自
 * 己格式化：时长在网络里到处出现（成员面板、管制员端、这里），格式一旦各写各
 * 的就会开始不一致。顺带避开一个真实踩过的坑 —— `duration` 是**毫秒**，当秒读
 * 会把两小时的航班显示成八十三天。
 *
 * `live: true` 的那一行是**正在飞**的航班，logoffTime 为空，时长一直在涨。
 */
import { onMounted, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import Icon from "@/components/ui/Icon.vue";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

interface Flight {
  id: number;
  callsign: string;
  logonTime: string;
  logoffTime: string | null;
  durationMs: number;
  formattedDuration: string;
  live: boolean;
}
interface Summary {
  totalFlights: number;
  formattedTotalTime: string;
  formattedLongest: string;
  callsignCount: number;
}
interface CallsignRollup {
  callsign: string;
  count: number;
  formattedDuration: string;
}
interface Payload {
  flights: Flight[];
  summary: Summary;
  callsigns: CallsignRollup[];
}

const data = ref<Payload | null>(null);
const loading = ref(true);
const error = ref("");

/** 只显示到分钟：日志里没有一件事需要秒。 */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

async function load() {
  loading.value = true;
  error.value = "";
  const result = await api<Payload>("/api/v1/pilot/flights");
  loading.value = false;
  if (!result.ok) {
    error.value = result.message;
    return;
  }
  data.value = result.data;
}

onMounted(load);
</script>

<template>
  <div class="space-y-5">
    <p v-if="loading" class="text-sm text-muted">{{ t("common.loading") }}</p>

    <div
      v-else-if="error"
      class="rounded-card border border-subtle bg-danger-bg px-4 py-3 text-sm text-danger-fg"
    >
      {{ error }}
    </div>

    <template v-else-if="data">
      <!-- 统计 -->
      <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-faint">
            {{ t("logbook.stats.flights") }}
          </dt>
          <dd class="mt-1 text-2xl font-semibold text-ink">
            {{ data.summary.totalFlights }}
          </dd>
        </div>
        <div class="card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-faint">
            {{ t("logbook.stats.total") }}
          </dt>
          <dd class="mt-1 font-mono text-2xl font-semibold text-ink">
            {{ data.summary.formattedTotalTime }}
          </dd>
        </div>
        <div class="card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-faint">
            {{ t("logbook.stats.longest") }}
          </dt>
          <dd class="mt-1 font-mono text-2xl font-semibold text-ink">
            {{ data.summary.formattedLongest }}
          </dd>
        </div>
        <div class="card p-4">
          <dt class="text-xs font-medium uppercase tracking-wide text-faint">
            {{ t("logbook.stats.callsigns") }}
          </dt>
          <dd class="mt-1 text-2xl font-semibold text-ink">
            {{ data.summary.callsignCount }}
          </dd>
        </div>
      </dl>

      <p
        v-if="!data.flights.length"
        class="surface-grid rounded-card border border-dashed border-subtle px-6 py-12 text-center text-sm text-muted"
      >
        {{ t("logbook.empty") }}
      </p>

      <!-- 航班 -->
      <div v-else class="card table-scroll">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-subtle text-left">
              <th class="px-4 py-3 font-medium text-muted">
                {{ t("logbook.table.callsign") }}
              </th>
              <th class="px-4 py-3 font-medium text-muted">
                {{ t("logbook.table.logon") }}
              </th>
              <th class="px-4 py-3 font-medium text-muted">
                {{ t("logbook.table.logoff") }}
              </th>
              <th class="px-4 py-3 text-right font-medium text-muted">
                {{ t("logbook.table.duration") }}
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-subtle">
            <tr v-for="flight in data.flights" :key="flight.id">
              <td class="whitespace-nowrap px-4 py-3">
                <span class="font-mono font-medium text-ink">{{
                  flight.callsign
                }}</span>
                <span v-if="flight.live" class="badge badge-success ml-2">
                  <Icon name="signal" class="size-3" />
                  {{ t("logbook.live") }}
                </span>
              </td>
              <td class="whitespace-nowrap px-4 py-3 font-mono text-muted">
                {{ when(flight.logonTime) }}
              </td>
              <td class="whitespace-nowrap px-4 py-3 font-mono text-muted">
                {{ flight.logoffTime ? when(flight.logoffTime) : "—" }}
              </td>
              <td
                class="whitespace-nowrap px-4 py-3 text-right font-mono text-ink"
              >
                {{ flight.formattedDuration }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 按呼号 -->
      <div v-if="data.callsigns.length" class="card p-4">
        <h2 class="mb-3 text-sm font-semibold text-ink">
          {{ t("logbook.byCallsign") }}
        </h2>
        <ul role="list" class="divide-y divide-subtle">
          <li
            v-for="row in data.callsigns"
            :key="row.callsign"
            class="flex items-center justify-between gap-3 py-2 text-sm"
          >
            <span class="font-mono font-medium text-ink">{{
              row.callsign
            }}</span>
            <span class="text-muted"
              >{{ row.count }} ·
              <span class="font-mono">{{ row.formattedDuration }}</span></span
            >
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>
