<script setup lang="ts">
/**
 * 气象：按 ICAO 查 METAR，常用机场存在本地。
 *
 * **只显示原始报文，不解码。** 解码 METAR 是一件看起来简单、实际上处处是例外
 * 的事（阵风、跑道视程、变化组、CAVOK、垂直能见度……），而在这里译错一个组比
 * 不译更糟 —— 飞行员会照着它做决定。原文是权威，等真要做解码器时它该是带测试
 * 的独立模块，而不是这个组件里的一段正则。
 *
 * can-api 在没有报文时回的是 200 + `metar: null`，不是错误状态码 —— 那是刻意
 * 的，让调用方能区分「这个站没有报文」和「服务挂了」。这里照着分开显示。
 *
 * 常用机场存 localStorage：EFB 的使用场景是同样几个机场反复查，而这个偏好不值
 * 得占用 can-api 的一张表。
 */
import { onMounted, ref } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { Icon } from "@jianyuelab-org/can-ui";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const STORE_KEY = "efb.weather.stations";
const ICAO = /^[A-Za-z]{4}$/;

interface Station {
  icao: string;
  metar: string | null;
  loading: boolean;
  error: string | null;
}

const stations = ref<Station[]>([]);
const query = ref("");
const queryError = ref("");

function persist() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify(stations.value.map((s) => s.icao)),
    );
  } catch {
    // 隐私模式下会抛。本次会话内仍然可用，只是下次打开要重新加。
  }
}

async function refresh(station: Station) {
  station.loading = true;
  station.error = null;
  const result = await api<{ icao: string; metar: string | null }>(
    `/api/v1/metar?icao=${encodeURIComponent(station.icao)}`,
  );
  station.loading = false;

  if (!result.ok) {
    station.error = result.message;
    return;
  }
  station.metar = result.data.metar;
}

function add(icao: string) {
  const code = icao.trim().toUpperCase();
  if (!ICAO.test(code)) {
    queryError.value = t("weather.invalidIcao");
    return;
  }
  queryError.value = "";
  query.value = "";

  const existing = stations.value.find((s) => s.icao === code);
  if (existing) {
    void refresh(existing);
    return;
  }

  const station: Station = {
    icao: code,
    metar: null,
    loading: false,
    error: null,
  };
  stations.value.unshift(station);
  persist();
  void refresh(station);
}

function remove(icao: string) {
  stations.value = stations.value.filter((s) => s.icao !== icao);
  persist();
}

function refreshAll() {
  for (const station of stations.value) void refresh(station);
}

onMounted(() => {
  let saved: string[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    saved = [];
  }
  stations.value = (Array.isArray(saved) ? saved : [])
    .filter((code) => typeof code === "string" && ICAO.test(code))
    .map((code) => ({
      icao: code.toUpperCase(),
      metar: null,
      loading: false,
      error: null,
    }));
  refreshAll();
});
</script>

<template>
  <div class="space-y-5">
    <div class="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
      <div class="min-w-0 flex-1">
        <label class="block">
          <span class="sr-only">{{ t("weather.addLabel") }}</span>
          <input
            v-model="query"
            class="input font-mono uppercase"
            :class="queryError ? 'input-error' : ''"
            maxlength="4"
            :placeholder="t('weather.placeholder')"
            @keydown.enter.prevent="add(query)"
          />
        </label>
        <span v-if="queryError" class="mt-1 block text-xs text-danger">{{
          queryError
        }}</span>
      </div>
      <div class="flex shrink-0 gap-2">
        <button type="button" class="btn btn-primary" @click="add(query)">
          <Icon name="plus" class="size-4" />
          {{ t("weather.add") }}
        </button>
        <button
          v-if="stations.length"
          type="button"
          class="btn btn-secondary"
          @click="refreshAll"
        >
          <Icon name="arrowPath" class="size-4" />
          {{ t("common.refresh") }}
        </button>
      </div>
    </div>

    <p
      v-if="!stations.length"
      class="surface-grid rounded-card border border-dashed border-subtle px-6 py-12 text-center text-sm text-muted"
    >
      {{ t("weather.empty") }}
    </p>

    <ul v-else role="list" class="space-y-3">
      <li v-for="station in stations" :key="station.icao" class="card p-4">
        <div class="flex items-start justify-between gap-3">
          <h2 class="font-mono text-lg font-semibold tracking-tight text-ink">
            {{ station.icao }}
          </h2>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-control text-faint transition-colors hover:bg-surface-sunken hover:text-ink"
              :aria-label="t('common.refresh')"
              :title="t('common.refresh')"
              @click="refresh(station)"
            >
              <Icon name="arrowPath" class="size-4" />
            </button>
            <button
              type="button"
              class="flex size-8 items-center justify-center rounded-control text-faint transition-colors hover:bg-surface-sunken hover:text-danger"
              :aria-label="t('weather.remove')"
              :title="t('weather.remove')"
              @click="remove(station.icao)"
            >
              <Icon name="xMark" class="size-4" />
            </button>
          </div>
        </div>

        <p v-if="station.loading" class="skeleton mt-2 h-5 w-full"></p>
        <p v-else-if="station.error" class="mt-2 text-sm text-danger">
          {{ station.error }}
        </p>
        <p
          v-else-if="station.metar"
          class="mt-2 break-words font-mono text-sm leading-relaxed text-ink"
        >
          {{ station.metar }}
        </p>
        <p v-else class="mt-2 text-sm text-muted">
          {{ t("weather.noReport") }}
        </p>
      </li>
    </ul>
  </div>
</template>
