<script setup lang="ts">
/**
 * 一个机场的详情：标高、位置、机位数、跑道。
 *
 * 跑道走 can-db 的机场详情（和进离场程序选择器同一个接口、同一份缓存形状）。那个
 * 接口的门和列表一样，但**能看到列表不等于一定能看到详情** —— 两次请求之间权限可
 * 能变，所以 401/403 在这里也单独说。
 *
 * **挂载时把焦点移到标题上。** 列表和详情是互斥的两个视图（Airports.vue 的
 * `v-else-if="selected"`），切换不导航、不刷新页面 —— 读屏软件不会自己发现内容
 * 换了。焦点移到这个 `h2`（`tabindex="-1"` 让它可以接焦点但不进 Tab 顺序）才会把
 * 机场代号读出来，这是选中一个结果之后**唯一**会被读屏用户感知到的信号。
 */
import { onMounted, ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import {
  fetchAirportProcedures,
  ProcedureError,
  runwayIdents,
} from "@/lib/procedures";
import {
  isForbiddenStatus,
  LOADING,
  type RequestState,
} from "@/lib/requestState";
import StateCard from "@/components/ui/StateCard.vue";
import PanelSection from "@/components/ui/PanelSection.vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { AirportRow as Airport } from "@/lib/airports";

const props = defineProps<{
  airport: Airport;
  messages: Record<string, unknown>;
}>();
const emit = defineEmits<{ back: [] }>();
const t = createTranslator(props.messages);

const runways = ref<RequestState<string[]>>(LOADING);
const heading = ref<HTMLHeadingElement | null>(null);

async function loadRunways() {
  runways.value = LOADING;
  try {
    const data = await fetchAirportProcedures(props.airport.icao);
    const idents = runwayIdents(data.runways);
    runways.value = idents.length
      ? { kind: "data", data: idents }
      : { kind: "empty" };
  } catch (e) {
    const status = e instanceof ProcedureError ? e.status : 0;
    runways.value = isForbiddenStatus(status)
      ? { kind: "forbidden", status }
      : { kind: "error", status };
  }
}

onMounted(() => {
  void loadRunways();
  heading.value?.focus();
});
watch(() => props.airport.icao, loadRunways);
</script>

<template>
  <div class="space-y-5">
    <button type="button" class="link text-sm" @click="emit('back')">
      <Icon name="arrowLeft" class="inline size-4" />
      {{ t("airports.detail.back") }}
    </button>

    <header>
      <h2
        ref="heading"
        tabindex="-1"
        class="font-mono text-2xl font-semibold text-ink outline-none"
      >
        {{ airport.icao }}
      </h2>
      <p v-if="airport.name" class="mt-1 text-sm text-muted">
        {{ airport.name }}
      </p>
    </header>

    <dl class="grid grid-cols-2 gap-3 text-sm">
      <div v-if="airport.fir">
        <dt class="text-xs uppercase tracking-wide text-faint">FIR</dt>
        <dd class="font-mono text-ink">{{ airport.fir }}</dd>
      </div>
      <div v-if="airport.elev !== null">
        <dt class="text-xs uppercase tracking-wide text-faint">
          {{ t("airports.elev") }}
        </dt>
        <dd class="font-mono text-ink">{{ airport.elev }} ft</dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-faint">
          {{ t("airports.detail.position") }}
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ airport.lat.toFixed(4) }}, {{ airport.lon.toFixed(4) }}
        </dd>
      </div>
      <div>
        <dt class="text-xs uppercase tracking-wide text-faint">
          {{ t("airports.stands") }}
        </dt>
        <dd class="font-mono text-ink">{{ airport.stands }}</dd>
      </div>
    </dl>

    <PanelSection :title="t('airports.detail.runways')" :level="3">
      <StateCard
        v-if="runways.kind === 'loading'"
        kind="loading"
        :title="t('common.loading')"
        compact
      />
      <StateCard
        v-else-if="runways.kind === 'forbidden'"
        kind="forbidden"
        :title="t('airports.denied.title')"
        :body="t('airports.denied.body')"
        compact
      />
      <StateCard
        v-else-if="runways.kind === 'error'"
        kind="error"
        :title="t('airports.detail.runwaysFailed')"
        :retry-label="t('common.retry')"
        compact
        @retry="loadRunways"
      />
      <StateCard
        v-else-if="runways.kind === 'empty'"
        kind="empty"
        :title="t('airports.detail.noRunways')"
        compact
      />
      <ul v-else class="flex flex-wrap gap-2">
        <li
          v-for="rwy in runways.data"
          :key="rwy"
          class="rounded-control border border-subtle px-2 py-1 font-mono text-sm text-ink"
        >
          {{ rwy }}
        </li>
      </ul>
    </PanelSection>
  </div>
</template>
