<script setup lang="ts">
/**
 * 点中地图上的飞机后弹出的详情卡。
 *
 * 内容照 can-radar 的 `RadarDetails.vue`（飞机那一半）：头部是呼号、空中 / 地面、
 * 机型；然后是起降机场和剩余距离 / 预计到达，四个实时数字（高度、高度层、地速、航
 * 向），应答机和飞行规则，飞行计划，航路原文和备注（默认收起），最后是谁在飞、飞
 * 了多久。和 `AtcDetails.vue` 同一个浮层位置，一次只有一张。
 */
import { computed, ref, watch } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import { hasPosition, type DatafeedPilot } from "@/lib/datafeed";
import { onlineFor } from "@/lib/atc";
import { flightLevel, isOnGround } from "@/lib/traffic";
import { distanceNm } from "@/lib/geo";
import { loadAirportCoords, type AirportTable } from "@/lib/airportCoords";

export interface PilotDetailsText {
  close: string;
  locate: string;
  onGround: string;
  airborne: string;
  noFlightPlan: string;
  remaining: string;
  eta: string;
  altitude: string;
  level: string;
  groundspeed: string;
  heading: string;
  squawk: string;
  rules: string;
  flightPlan: string;
  aircraft: string;
  cruise: string;
  tas: string;
  alternate: string;
  member: string;
  online: string;
}

const props = defineProps<{
  pilot: DatafeedPilot;
  text: PilotDetailsText;
}>();
const emit = defineEmits<{ close: []; locate: [] }>();

const numbers = new Intl.NumberFormat();
const DASH = "—";

/**
 * 「还没报过位置」写破折号，不写 0 —— 高度 0、地速 0、航向 0 读起来像「停在跑道头，
 * 机头朝北」，是一句完整的假话（can-radar 同一条）。
 */
const shown = (
  value: number | null | undefined,
  format: (n: number) => string,
) => (Number.isFinite(value) ? format(value as number) : DASH);

const onGround = computed(() => isOnGround(props.pilot.groundspeed));
const plan = computed(() => props.pilot.flight_plan ?? null);

const tiles = computed(() => {
  const p = props.pilot;
  return [
    {
      label: props.text.altitude,
      value: shown(p.altitude, (a) => numbers.format(Math.round(a))),
    },
    { label: props.text.level, value: shown(p.altitude, flightLevel) },
    {
      label: props.text.groundspeed,
      value: shown(p.groundspeed, (g) => String(Math.round(g))),
    },
    {
      label: props.text.heading,
      value: shown(p.heading, (h) => `${Math.round(h)}°`),
    },
  ];
});

const rows = computed(() => [
  { label: props.text.squawk, value: String(props.pilot.transponder ?? DASH) },
  { label: props.text.rules, value: plan.value?.flight_rules || DASH },
]);

const planRows = computed(() => {
  const fp = plan.value;
  if (!fp) return [];
  return [
    { label: props.text.aircraft, value: fp.aircraft || DASH },
    { label: props.text.cruise, value: fp.cruising_altitude || DASH },
    {
      label: props.text.tas,
      value: fp.cruise_tas ? `${fp.cruise_tas} kts` : DASH,
    },
    { label: props.text.alternate, value: fp.alternate || DASH },
  ];
});

/**
 * 剩余距离和预计到达，照 can-radar：到目的地机场的大圆距离，除以此刻的地速。地速
 * 低于 30 kt 不给 ETA —— 停着的飞机算出来的是算术，不是信息。
 */
const airports = ref<AirportTable | null>(null);
watch(
  () => plan.value?.arrival,
  async (arrival) => {
    if (arrival && !airports.value) airports.value = await loadAirportCoords();
  },
  { immediate: true },
);

const MIN_ETA_GROUNDSPEED = 30;

const remaining = computed(() => {
  const p = props.pilot;
  const icao = plan.value?.arrival?.trim().toUpperCase();
  const destination = icao ? airports.value?.[icao] : null;
  if (!destination || !hasPosition(p)) return null;
  const groundspeed = p.groundspeed ?? 0;
  const nm = distanceNm([p.latitude!, p.longitude!], destination);
  const hours = groundspeed >= MIN_ETA_GROUNDSPEED ? nm / groundspeed : null;
  return {
    distance: `${Math.round(nm)} nm`,
    eta:
      hours === null
        ? null
        : {
            clock: new Date(Date.now() + hours * 3600_000).toLocaleTimeString(
              [],
              { hour: "2-digit", minute: "2-digit" },
            ),
            duration:
              hours >= 1
                ? `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`
                : `${Math.max(1, Math.round(hours * 60))}m`,
          },
  };
});
</script>

<template>
  <aside class="map-atc-details glass" :aria-label="pilot.callsign">
    <header class="flex items-center gap-2">
      <span class="min-w-0 flex-1 truncate font-mono text-sm text-ink">{{
        pilot.callsign
      }}</span>
      <button
        v-if="hasPosition(pilot)"
        type="button"
        class="shrink-0 text-muted hover:text-ink"
        :aria-label="text.locate"
        :title="text.locate"
        @click="emit('locate')"
      >
        <Icon name="map" class="size-4" />
      </button>
      <button
        type="button"
        class="shrink-0 text-muted hover:text-ink"
        :aria-label="text.close"
        :title="text.close"
        @click="emit('close')"
      >
        <Icon name="xMark" class="size-4" />
      </button>
    </header>

    <div class="mt-1 flex flex-wrap items-center gap-1.5">
      <span
        class="rounded px-1.5 text-[10px] font-semibold"
        :class="
          onGround ? 'bg-overlay text-muted' : 'bg-success-bg text-success-fg'
        "
        >{{ onGround ? text.onGround : text.airborne }}</span
      >
      <span v-if="plan?.aircraft" class="font-mono text-xs text-faint">{{
        plan.aircraft
      }}</span>
    </div>

    <div class="mt-2 rounded bg-overlay p-2">
      <div class="flex items-center justify-center gap-3 font-mono text-sm">
        <span class="text-ink">{{ plan?.departure || "----" }}</span>
        <Icon name="arrowRight" class="size-3.5 text-muted" />
        <span class="text-ink">{{ plan?.arrival || "----" }}</span>
      </div>
      <p v-if="!plan" class="mt-1 text-center text-xs text-muted">
        {{ text.noFlightPlan }}
      </p>
      <dl
        v-if="remaining"
        class="mt-1 flex justify-center gap-4 text-xs text-muted"
      >
        <div class="flex gap-1">
          <dt>{{ text.remaining }}</dt>
          <dd class="font-mono text-ink">{{ remaining.distance }}</dd>
        </div>
        <div v-if="remaining.eta" class="flex gap-1">
          <dt>{{ text.eta }}</dt>
          <dd class="font-mono text-ink">
            {{ remaining.eta.clock }}
            <span class="text-faint">({{ remaining.eta.duration }})</span>
          </dd>
        </div>
      </dl>
    </div>

    <div class="mt-2 grid grid-cols-4 gap-1">
      <div
        v-for="tile in tiles"
        :key="tile.label"
        class="rounded bg-overlay px-1.5 py-1"
      >
        <div class="truncate text-[10px] text-muted">{{ tile.label }}</div>
        <div class="font-mono text-xs text-ink">{{ tile.value }}</div>
      </div>
    </div>

    <dl class="mt-2 space-y-1 text-xs">
      <div
        v-for="row in rows"
        :key="row.label"
        class="flex items-baseline justify-between gap-3"
      >
        <dt class="shrink-0 text-muted">{{ row.label }}</dt>
        <dd class="min-w-0 truncate text-right font-mono text-ink">
          {{ row.value }}
        </dd>
      </div>
    </dl>

    <section v-if="plan" class="mt-3 border-t border-subtle pt-2">
      <h3 class="text-xs text-muted">{{ text.flightPlan }}</h3>
      <dl class="mt-1 space-y-1 text-xs">
        <div
          v-for="row in planRows"
          :key="row.label"
          class="flex items-baseline justify-between gap-3"
        >
          <dt class="shrink-0 text-muted">{{ row.label }}</dt>
          <dd class="min-w-0 truncate text-right font-mono text-ink">
            {{ row.value }}
          </dd>
        </div>
      </dl>
      <!-- 航路原文和备注很长，默认收起，和 can-radar 一样。 -->
      <details v-if="plan.route" class="mt-2 text-xs">
        <summary class="cursor-pointer text-muted">ROUTE</summary>
        <p class="mt-1 break-words font-mono leading-relaxed text-ink">
          {{ plan.route }}
        </p>
      </details>
      <details v-if="plan.remarks" class="mt-2 text-xs">
        <summary class="cursor-pointer text-muted">RMK</summary>
        <p class="mt-1 break-words font-mono leading-relaxed text-muted">
          {{ plan.remarks }}
        </p>
      </details>
    </section>

    <dl class="mt-3 space-y-1 border-t border-subtle pt-2 text-xs">
      <div class="flex items-baseline justify-between gap-3">
        <dt class="shrink-0 text-muted">{{ text.member }}</dt>
        <dd class="min-w-0 truncate text-right text-ink">{{ pilot.name }}</dd>
      </div>
      <div class="flex items-baseline justify-between gap-3">
        <dt class="shrink-0 text-muted">CAN ID</dt>
        <dd class="font-mono text-ink">{{ pilot.cid }}</dd>
      </div>
      <div class="flex items-baseline justify-between gap-3">
        <dt class="shrink-0 text-muted">{{ text.online }}</dt>
        <dd class="font-mono text-ink">
          {{ onlineFor(pilot.logon_time) ?? "—" }}
        </dd>
      </div>
    </dl>
  </aside>
</template>
