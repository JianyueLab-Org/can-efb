<script setup lang="ts">
/**
 * 点中地图上的管制席位后弹出的详情卡。
 *
 * 内容照 can-radar 的 `RadarDetails.vue`（席位那一半）：头部是呼号和席位色的类型
 * 牌（ATIS 写 `ATIS`），然后是管制区 / 覆盖扇区 / 延伸席位 / 频率 / 成员 / 等级 /
 * 在线时长，最后是 ATC info 或 ATIS 原文。
 *
 * **在地图岛屿里画，不发给面板。** mapBus 只有面板 → 地图一个方向（AGENTS.md），
 * 所以这张卡是地图自己的浮层，和图层菜单同一层。
 */
import { computed } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";
import type { DatafeedController } from "@/lib/datafeed";
import { facilityLabel } from "@/lib/datafeed";
import { facilityColor, onlineFor, ratingShort } from "@/lib/atc";
import { allowsExtending, parseAtisSectors } from "@/lib/atisSectors";
import { firMatch } from "@/lib/firTable";

export interface AtcDetailsText {
  close: string;
  airspace: string;
  covering: string;
  extending: string;
  frequency: string;
  member: string;
  rating: string;
  online: string;
  atisText: string;
  controllerInfo: string;
}

const props = defineProps<{
  station: DatafeedController;
  isAtis: boolean;
  text: AtcDetailsText;
}>();
const emit = defineEmits<{ close: [] }>();

const facility = computed(() => (props.isAtis ? 7 : props.station.facility));
const badge = computed(() =>
  props.isAtis ? "ATIS" : facilityLabel(props.station.facility),
);

/** can-radar 的 `controllerRows`，同样的取舍：不列 facility（头部已经写了）和视野。 */
const rows = computed(() => {
  const c = props.station;
  const parsed = parseAtisSectors(c.text_atis);
  const airspace =
    !props.isAtis && !parsed.covering.length ? firMatch(c.callsign) : null;
  const list: { label: string; value: string }[] = [];
  if (airspace) list.push({ label: props.text.airspace, value: airspace.name });
  if (parsed.covering.length)
    list.push({
      label: props.text.covering,
      value: parsed.covering.join(", "),
    });
  if (parsed.extending.length && allowsExtending(c))
    list.push({
      label: props.text.extending,
      value: parsed.extending.join(", "),
    });
  list.push({ label: props.text.frequency, value: c.frequency });
  list.push({ label: props.text.member, value: `${c.name} (${c.cid})` });
  list.push({ label: props.text.rating, value: ratingShort(c.rating) });
  list.push({
    label: props.text.online,
    value: onlineFor(c.logon_time) ?? "—",
  });
  return list;
});

const lines = computed(() =>
  (props.station.text_atis ?? []).filter((line) => line.trim()),
);
</script>

<template>
  <aside class="map-atc-details glass" :aria-label="station.callsign">
    <header class="flex items-center gap-2">
      <span
        class="rounded px-1.5 font-mono text-[10px] font-semibold text-white"
        :style="{ backgroundColor: facilityColor(facility) }"
        >{{ badge }}</span
      >
      <span class="min-w-0 flex-1 truncate font-mono text-sm text-ink">{{
        station.callsign
      }}</span>
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

    <section v-if="lines.length" class="mt-3 border-t border-subtle pt-2">
      <h3 class="text-xs text-muted">
        {{ isAtis ? text.atisText : text.controllerInfo }}
      </h3>
      <p
        v-for="(line, index) in lines"
        :key="index"
        class="mt-1 break-words font-mono text-xs leading-relaxed text-ink"
      >
        {{ line }}
      </p>
    </section>
  </aside>
</template>
