<script setup lang="ts">
/**
 * 跑道与进离场程序的选择器。
 *
 * 规划器（can-db）已经替你挑了一条 SID 和一条 STAR —— 它挑的依据是「航路从哪个
 * 点接进网络」，而**它不知道今天用哪条跑道**：跑道由管制员按风向定，不在飞行计
 * 划里。所以这个组件补的正是那一半：先选跑道，再在这条跑道服务的程序里挑，再挑转换。
 *
 * 选择存在本机（`lib/procedureSelection.ts`），按起降机场对。地图上的已提交计划和
 * 飞行计划页的预览都按它画。
 *
 * ## 三件事必须显示，不能省成好看
 *
 * 1. **衔接判断。** 换一条 SID 之后，如果它的出口不是航路的第一个点，填出来的航
 *    路串是**断的** —— 而它在图上完全正常（两段线都在，中间连一条直线），在表格
 *    里也正常（一串合法的代号）。只有管制员那边会发现。所以换程序这件事必须带着
 *    这个判断一起做，而且要把**两头各是什么**都说出来，不然人没法查。
 *
 * 2. **「没写跑道」的标记。** 一部分程序压根没有跑道信息，它们对每条跑道都算数
 *    （见 lib/procedures.ts 的 servesRunway）。不标出来的话，人会以为那是按今天
 *    这条跑道筛出来的结果。
 *
 * 3. **高度限制的原文。** `05910B03940A` 这种 ARINC 424 编码**一个字都不解释**，
 *    理由写在 lib/procedures.ts 顶上：解错一个高度限制比没有更危险。
 *
 * ## 航路串只在人改选择时改写
 *
 * 打开时以航路串里写着的 SID/STAR 为准（串里没有才用本机存的），所以打开这个组件
 * 永远不会悄悄改掉表单里的航路。改写判断「首尾那个记号本来是不是程序名」，靠的是
 * 这个机场**真有**这个名字的程序，不猜记号长得像不像。
 *
 * ## 进近只画，不进航路串
 *
 * 进近不是填报航路的一部分（管制员给的），所以选了它只影响图上画什么和腿表里列
 * 什么，不动那串字符。
 */
import { computed, ref, watch } from "vue";
import { api } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { publishToMap, type MapPoint } from "@/lib/mapBus";
import { isForbiddenStatus } from "@/lib/requestState";
import { smoothProcedureTurns } from "@/lib/procedureGeometry";
import { loadHoldings, type Holding } from "@/lib/holds";
import { variationOf, withTerminalHolds } from "@/lib/planProcedures";
import {
  EMPTY_SELECTION,
  readSelection,
  writeSelection,
  type ProcedureSelection,
} from "@/lib/procedureSelection";
import { parseMetarWind, windComponents, type MetarWind } from "@/lib/wind";
import StateCard from "@/components/ui/StateCard.vue";
import {
  composeRoutePoints,
  findRunway,
  joinIdent,
  joinsRoute,
  loadAirportProcedures,
  pickProcedures,
  procedureLabel,
  procedureTrack,
  procedureTransitions,
  ProcedureError,
  procedureRunways,
  rewriteRoute,
  runwayIdents,
  runwayTrueBearing,
  servesAllRunways,
  type AirportProcedures,
  type Procedure,
  type ProcedureKind,
} from "@/lib/procedures";

const props = defineProps<{
  messages: Record<string, unknown>;
  departure: string;
  arrival: string;
  /** 当前的航路串。改写以它为底。 */
  route: string;
  disabled?: boolean;
  /**
   * 两端机场之间的航路点，**不含两端机场**。给了就由这个组件把合成的航线推给地图
   * （航路生成页）；不给时地图由调用方负责（飞行计划页的预览、已提交的计划）。
   */
  enroute?: MapPoint[];
  departurePoint?: MapPoint | null;
  arrivalPoint?: MapPoint | null;
}>();

const emit = defineEmits<{ (e: "update:route", value: string): void }>();
const t = createTranslator(props.messages);

const depData = ref<AirportProcedures | null>(null);
const arrData = ref<AirportProcedures | null>(null);
const busy = ref(false);
/** `denied` 和别的失败分开：没有 aipAccess 是这个网络的常态，不是故障。 */
const denied = ref(false);
const failed = ref(false);

const sel = ref<ProcedureSelection>({ ...EMPTY_SELECTION });

const depCode = computed(() => props.departure.trim().toUpperCase());
const arrCode = computed(() => props.arrival.trim().toUpperCase());

// ---------------------------------------------------------------- 航路串

const tokens = computed(() =>
  props.route.trim().toUpperCase().split(/\s+/).filter(Boolean),
);

function namesOf(data: AirportProcedures | null, kind: ProcedureKind) {
  return new Set(
    (data?.procedures ?? []).filter((p) => p.kind === kind).map((p) => p.name),
  );
}
const sidNames = computed(() => namesOf(depData.value, "sid"));
const starNames = computed(() => namesOf(arrData.value, "star"));

/** 航路串首尾写着的程序名（这个机场真有的才算）。 */
const routeSid = computed(() => {
  const first = tokens.value[0];
  return first && sidNames.value.has(first) ? first : "";
});
const routeStar = computed(() => {
  const last = tokens.value[tokens.value.length - 1];
  return last && starNames.value.has(last) ? last : "";
});

/** 航路的首尾两个定位点：去掉程序名和 DCT。 */
const enrouteIdents = computed(() => {
  if (props.enroute) return props.enroute.map((p) => p.ident).filter(Boolean);
  const list = [...tokens.value];
  if (routeSid.value) list.shift();
  if (routeStar.value) list.pop();
  return list.filter((x) => x !== "DCT");
});
const firstEnroute = computed(() => enrouteIdents.value[0] ?? "");
const lastEnroute = computed(
  () => enrouteIdents.value[enrouteIdents.value.length - 1] ?? "",
);

// ---------------------------------------------------------------- 取数

async function loadBoth() {
  busy.value = true;
  denied.value = false;
  failed.value = false;
  try {
    const [a, b] = await Promise.all([
      loadAirportProcedures(depCode.value),
      loadAirportProcedures(arrCode.value),
    ]);
    depData.value = a;
    arrData.value = b;
    initSelection();
  } catch (e) {
    depData.value = null;
    arrData.value = null;
    if (e instanceof ProcedureError && isForbiddenStatus(e.status)) {
      denied.value = true;
    } else {
      failed.value = true;
      console.error("[efb:procedures] failed to load procedures:", e);
    }
  } finally {
    busy.value = false;
  }
}

/** 本机存的那份打底；航路串里写着的程序名压过它，见文件头。 */
function initSelection() {
  const stored = readSelection(depCode.value, arrCode.value);
  const next = { ...stored };
  if (routeSid.value && procedureName(stored.sid) !== routeSid.value) {
    next.sid = routeSid.value;
    next.sidTransition = "";
  }
  if (routeStar.value && procedureName(stored.star) !== routeStar.value) {
    next.star = routeStar.value;
    next.starTransition = "";
  }
  sel.value = next;
}

watch(
  [depCode, arrCode],
  ([a, b]) => {
    if (a.length === 4 && b.length === 4) void loadBoth();
    else {
      depData.value = null;
      arrData.value = null;
    }
  },
  { immediate: true },
);

/** 有人在表单里直接改了航路串的首尾程序名：跟过去，不改写回去。 */
watch([routeSid, routeStar], ([s, r], [prevS, prevR]) => {
  if (!depData.value || !arrData.value) return;
  const next = { ...sel.value };
  if (s !== prevS && s && procedureName(next.sid) !== s) {
    next.sid = s;
    next.sidTransition = "";
  }
  if (r !== prevR && r && procedureName(next.star) !== r) {
    next.star = r;
    next.starTransition = "";
  }
  sel.value = next;
});

// ---------------------------------------------------------------- 跑道与风

const metar = ref<Record<string, MetarWind | null | "failed">>({});

async function loadWind(icao: string) {
  if (icao.length !== 4 || icao in metar.value) return;
  metar.value = { ...metar.value, [icao]: null };
  const result = await api<{ icao: string; metar: string | null }>(
    `/api/v1/metar?icao=${encodeURIComponent(icao)}`,
  );
  metar.value = {
    ...metar.value,
    [icao]: result.ok ? parseMetarWind(result.data?.metar) : "failed",
  };
}
watch(
  [depCode, arrCode],
  ([a, b]) => {
    void loadWind(a);
    void loadWind(b);
  },
  { immediate: true },
);

interface RunwayRow {
  id: string;
  lengthM: number | null;
  widthM: number | null;
  bearing: number | null;
  head: number | null;
  cross: number | null;
  crossFrom: "left" | "right" | null;
}

function runwayRows(data: AirportProcedures | null, icao: string): RunwayRow[] {
  if (!data) return [];
  const wind = metar.value[icao];
  return runwayIdents(data.runways).map((id) => {
    const rwy = findRunway(data.runways, id);
    const detail = data.runwayDetails.find(
      (d) => (d.ident ?? "").toUpperCase() === id,
    );
    const bearing = rwy ? runwayTrueBearing(rwy, detail) : null;
    const comp =
      wind && wind !== "failed" && bearing != null
        ? windComponents(wind, bearing)
        : null;
    return {
      id,
      lengthM: detail?.lengthM ?? null,
      widthM: detail?.widthM ?? null,
      bearing,
      head: comp?.headKt ?? null,
      cross: comp?.crossKt ?? null,
      crossFrom: comp?.crossFrom ?? null,
    };
  });
}

const depRunways = computed(() => runwayRows(depData.value, depCode.value));
const arrRunways = computed(() => runwayRows(arrData.value, arrCode.value));
const windFailed = computed(
  () =>
    metar.value[depCode.value] === "failed" ||
    metar.value[arrCode.value] === "failed",
);

// ---------------------------------------------------------------- 程序

const sids = computed(() =>
  pickProcedures(depData.value?.procedures ?? [], "sid", sel.value.depRunway),
);
const stars = computed(() =>
  pickProcedures(arrData.value?.procedures ?? [], "star", sel.value.arrRunway),
);
const approaches = computed(() =>
  pickProcedures(
    arrData.value?.procedures ?? [],
    "approach",
    sel.value.arrRunway,
  ),
);

/**
 * 选中的那条。先按带变体的标签找，找不到再按名字找第一条 —— 航路串里只写名字，
 * 同名的几种变体由跑道筛掉。
 */
function find(list: Procedure[], label: string): Procedure | null {
  if (!label) return null;
  return (
    list.find((p) => procedureLabel(p) === label) ??
    list.find((p) => p.name === label) ??
    null
  );
}
const sid = computed(() => find(sids.value, sel.value.sid));
const star = computed(() => find(stars.value, sel.value.star));
const approach = computed(() => find(approaches.value, sel.value.approach));

function procedureName(label: string): string {
  return label.replace(/-[A-Z0-9]+$/, "");
}

const sidTransitions = computed(() =>
  sid.value ? procedureTransitions(sid.value) : [],
);
const starTransitions = computed(() =>
  star.value ? procedureTransitions(star.value) : [],
);
const approachTransitions = computed(() =>
  approach.value ? procedureTransitions(approach.value) : [],
);

// ---------------------------------------------------------------- 改选择

/**
 * 人改了一项。换跑道之后，原来选的那条如果不再服务这条跑道，**清掉而不是留着**
 * —— 留着的话下拉框显示空，而航路串里还是旧的那条。
 */
function update(patch: Partial<ProcedureSelection>) {
  const next = { ...sel.value, ...patch };
  const depList = pickProcedures(
    depData.value?.procedures ?? [],
    "sid",
    next.depRunway,
  );
  const arrStars = pickProcedures(
    arrData.value?.procedures ?? [],
    "star",
    next.arrRunway,
  );
  const arrApps = pickProcedures(
    arrData.value?.procedures ?? [],
    "approach",
    next.arrRunway,
  );
  if (next.sid && !find(depList, next.sid)) next.sid = "";
  if (next.star && !find(arrStars, next.star)) next.star = "";
  if (next.approach && !find(arrApps, next.approach)) next.approach = "";
  if (next.sid !== sel.value.sid) next.sidTransition = "";
  if (next.star !== sel.value.star) next.starTransition = "";
  if (next.approach !== sel.value.approach) next.approachTransition = "";

  const before = sel.value;
  sel.value = next;
  writeSelection(depCode.value, arrCode.value, next);

  if (before.sid !== next.sid || before.star !== next.star) {
    const rewritten = rewriteRoute(
      props.route.trim().toUpperCase(),
      { sid: routeSid.value, star: routeStar.value },
      {
        sid: next.sid
          ? procedureName(find(depList, next.sid)?.name ?? next.sid)
          : null,
        star: next.star
          ? procedureName(find(arrStars, next.star)?.name ?? next.star)
          : null,
      },
    );
    if (rewritten !== props.route.trim().toUpperCase()) {
      emit("update:route", rewritten);
    }
  }
}

function onSelect(field: keyof ProcedureSelection, event: Event) {
  update({ [field]: (event.target as HTMLSelectElement).value });
}

function toggleRunway(field: "depRunway" | "arrRunway", id: string) {
  update({ [field]: sel.value[field] === id ? "" : id });
}

// ---------------------------------------------------------------- 衔接

const sidJoin = computed(() => joinsRoute(sid.value, firstEnroute.value));
const starJoin = computed(() => joinsRoute(star.value, lastEnroute.value));

// ---------------------------------------------------------------- 地图（航路生成页）

/** 终端等待（航路生成页推地图时挂上）。 */
const holdings = ref<Holding[]>([]);
if (props.enroute) {
  void loadHoldings().then((list) => (holdings.value = list));
}

watch(
  [
    sel,
    holdings,
    sid,
    star,
    approach,
    () => props.enroute,
    () => props.departurePoint,
    () => props.arrivalPoint,
  ],
  () => {
    if (!props.enroute) return;
    if (!depData.value && !arrData.value) return;
    const composed = composeRoutePoints({
      departure: props.departurePoint ?? null,
      departureRunway: findRunway(depData.value?.runways, sel.value.depRunway),
      sid: sid.value,
      // 跑道要传进去：一条 SID 常常把好几条跑道的转换塞在同一串腿里，不给跑道
      // 就只画公共段。
      sidRunway: sel.value.depRunway,
      sidTransition: sel.value.sidTransition,
      enroute: props.enroute,
      star: star.value,
      starRunway: sel.value.arrRunway,
      starTransition: sel.value.starTransition,
      approach: approach.value,
      approachTransition: sel.value.approachTransition,
      departureVariation: variationOf(depData.value) ?? 0,
      arrivalVariation: variationOf(arrData.value) ?? 0,
      arrivalRunway: findRunway(arrData.value?.runways, sel.value.arrRunway),
      arrival: props.arrivalPoint ?? null,
    });
    publishToMap({
      points: smoothProcedureTurns(
        withTerminalHolds(
          composed,
          holdings.value,
          sel.value,
          depData.value,
          arrData.value,
        ),
      ),
      label: `${depCode.value} → ${arrCode.value}`,
    });
  },
);

// ---------------------------------------------------------------- 腿表

/**
 * 选中的三条程序按飞行顺序接起来。和地图一样只列**实际飞的那几段**；进近连复飞一起
 * 列（地图的主线不画复飞）。
 */
const legs = computed(() =>
  (
    [
      [
        sid.value,
        sel.value.depRunway,
        firstEnroute.value,
        sel.value.sidTransition,
      ],
      [
        star.value,
        sel.value.arrRunway,
        lastEnroute.value,
        sel.value.starTransition,
      ],
      [approach.value, sel.value.arrRunway, null, sel.value.approachTransition],
    ] as const
  )
    .filter((row): row is readonly [Procedure, string, string | null, string] =>
      Boolean(row[0]),
    )
    .flatMap(([p, runway, enrouteFix, transition]) =>
      procedureTrack(p, { runway, enrouteFix, transition }).map((leg) => ({
        procedure: p,
        leg,
      })),
    ),
);

function runwayNote(p: Procedure): string {
  return servesAllRunways(p)
    ? t("route.procedures.anyRunway")
    : procedureRunways(p).join(" ");
}

function kindLabel(kind: ProcedureKind): string {
  return t(`route.procedures.kind.${kind}`);
}

function crossText(row: RunwayRow): string {
  if (!row.cross) return "";
  return t(
    row.crossFrom === "left"
      ? "route.procedures.wind.crossLeft"
      : "route.procedures.wind.crossRight",
    { kt: String(row.cross) },
  );
}
</script>

<template>
  <section
    v-if="denied || failed || busy || depData || arrData"
    class="flex flex-col gap-4"
  >
    <h3 class="text-sm font-semibold text-ink">
      {{ t("route.procedures.title") }}
    </h3>

    <StateCard
      v-if="busy"
      kind="loading"
      :title="t('route.procedures.loading')"
      compact
    />
    <!-- 没权限是常态，不是故障 —— 和别的失败分开说。 -->
    <StateCard
      v-else-if="denied"
      kind="forbidden"
      :title="t('route.procedures.denied')"
      compact
    />
    <StateCard
      v-else-if="failed"
      kind="error"
      :title="t('route.procedures.failed')"
      :retry-label="t('common.retry')"
      compact
      @retry="loadBoth"
    />

    <template v-else>
      <fieldset :disabled="disabled" class="grid min-w-0 gap-5 @md:grid-cols-2">
        <!-- 离场 -->
        <div class="flex min-w-0 flex-col gap-3">
          <p class="text-xs font-medium text-ink">
            {{ t("route.procedures.departure") }}
            <span class="font-mono text-muted">{{ depCode }}</span>
          </p>

          <div
            role="radiogroup"
            :aria-label="t('route.procedures.runway')"
            class="flex flex-col gap-1.5"
          >
            <button
              v-for="r in depRunways"
              :key="r.id"
              type="button"
              role="radio"
              :aria-checked="sel.depRunway === r.id"
              class="runway-row"
              :class="{ 'is-selected': sel.depRunway === r.id }"
              @click="toggleRunway('depRunway', r.id)"
            >
              <span class="font-mono text-base font-semibold text-ink">{{
                r.id
              }}</span>
              <span class="runway-meta">
                <template v-if="r.lengthM"
                  >{{ r.lengthM
                  }}<template v-if="r.widthM">×{{ r.widthM }}</template>
                  m</template
                >
                <template v-if="r.bearing != null">
                  ·
                  {{
                    Math.round(r.bearing).toString().padStart(3, "0")
                  }}°T</template
                >
              </span>
              <span
                v-if="r.head != null"
                class="wind-chip"
                :class="r.head < 0 ? 'is-tail' : 'is-head'"
              >
                {{
                  r.head < 0
                    ? t("route.procedures.wind.tail", { kt: String(-r.head) })
                    : t("route.procedures.wind.head", { kt: String(r.head) })
                }}
                <template v-if="r.cross"> · {{ crossText(r) }}</template>
              </span>
            </button>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted"
              >{{ kindLabel("sid") }} · {{ sids.length }}</span
            >
            <select
              :value="sid ? procedureLabel(sid) : ''"
              class="input font-mono"
              @change="onSelect('sid', $event)"
            >
              <option value="">{{ t("route.procedures.none") }}</option>
              <option
                v-for="p in sids"
                :key="procedureLabel(p)"
                :value="procedureLabel(p)"
              >
                {{ procedureLabel(p) }} — {{ runwayNote(p) }}
              </option>
            </select>
          </label>
          <label v-if="sidTransitions.length" class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{
              t("route.procedures.transition")
            }}</span>
            <select
              :value="sel.sidTransition"
              class="input font-mono"
              @change="onSelect('sidTransition', $event)"
            >
              <option value="">
                {{ t("route.procedures.autoTransition") }}
              </option>
              <option v-for="name in sidTransitions" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
          </label>
        </div>

        <!-- 进场 -->
        <div class="flex min-w-0 flex-col gap-3">
          <p class="text-xs font-medium text-ink">
            {{ t("route.procedures.arrival") }}
            <span class="font-mono text-muted">{{ arrCode }}</span>
          </p>

          <div
            role="radiogroup"
            :aria-label="t('route.procedures.runway')"
            class="flex flex-col gap-1.5"
          >
            <button
              v-for="r in arrRunways"
              :key="r.id"
              type="button"
              role="radio"
              :aria-checked="sel.arrRunway === r.id"
              class="runway-row"
              :class="{ 'is-selected': sel.arrRunway === r.id }"
              @click="toggleRunway('arrRunway', r.id)"
            >
              <span class="font-mono text-base font-semibold text-ink">{{
                r.id
              }}</span>
              <span class="runway-meta">
                <template v-if="r.lengthM"
                  >{{ r.lengthM
                  }}<template v-if="r.widthM">×{{ r.widthM }}</template>
                  m</template
                >
                <template v-if="r.bearing != null">
                  ·
                  {{
                    Math.round(r.bearing).toString().padStart(3, "0")
                  }}°T</template
                >
              </span>
              <span
                v-if="r.head != null"
                class="wind-chip"
                :class="r.head < 0 ? 'is-tail' : 'is-head'"
              >
                {{
                  r.head < 0
                    ? t("route.procedures.wind.tail", { kt: String(-r.head) })
                    : t("route.procedures.wind.head", { kt: String(r.head) })
                }}
                <template v-if="r.cross"> · {{ crossText(r) }}</template>
              </span>
            </button>
          </div>

          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted"
              >{{ kindLabel("star") }} · {{ stars.length }}</span
            >
            <select
              :value="star ? procedureLabel(star) : ''"
              class="input font-mono"
              @change="onSelect('star', $event)"
            >
              <option value="">{{ t("route.procedures.none") }}</option>
              <option
                v-for="p in stars"
                :key="procedureLabel(p)"
                :value="procedureLabel(p)"
              >
                {{ procedureLabel(p) }} — {{ runwayNote(p) }}
              </option>
            </select>
          </label>
          <label v-if="starTransitions.length" class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{
              t("route.procedures.transition")
            }}</span>
            <select
              :value="sel.starTransition"
              class="input font-mono"
              @change="onSelect('starTransition', $event)"
            >
              <option value="">
                {{ t("route.procedures.autoTransition") }}
              </option>
              <option v-for="name in starTransitions" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted"
              >{{ kindLabel("approach") }} · {{ approaches.length }}</span
            >
            <select
              :value="approach ? procedureLabel(approach) : ''"
              class="input font-mono"
              @change="onSelect('approach', $event)"
            >
              <option value="">{{ t("route.procedures.none") }}</option>
              <option
                v-for="p in approaches"
                :key="procedureLabel(p)"
                :value="procedureLabel(p)"
              >
                {{ procedureLabel(p) }}
              </option>
            </select>
          </label>
          <label v-if="approachTransitions.length" class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{
              t("route.procedures.transition")
            }}</span>
            <select
              :value="sel.approachTransition"
              class="input font-mono"
              @change="onSelect('approachTransition', $event)"
            >
              <option value="">
                {{ t("route.procedures.autoTransition") }}
              </option>
              <option
                v-for="name in approachTransitions"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
            </select>
          </label>
          <p class="text-xs text-muted">
            {{ t("route.procedures.approachNote") }}
          </p>
        </div>
      </fieldset>

      <p v-if="windFailed" class="text-xs text-muted">
        {{ t("route.procedures.wind.failed") }}
      </p>
      <p class="text-xs text-muted">{{ t("route.procedures.savedLocally") }}</p>

      <!-- 衔接判断，见组件顶上第 1 条。两头都摆出来，不然没法查。 -->
      <p
        v-if="sidJoin === false && sid"
        class="card border-danger p-3 text-sm text-ink"
      >
        {{ t("route.procedures.sidGap") }}
        <span class="font-mono">{{ joinIdent(sid) }}</span> ·
        <span class="font-mono">{{ firstEnroute }}</span>
      </p>
      <p
        v-if="starJoin === false && star"
        class="card border-danger p-3 text-sm text-ink"
      >
        {{ t("route.procedures.starGap") }}
        <span class="font-mono">{{ joinIdent(star) }}</span> ·
        <span class="font-mono">{{ lastEnroute }}</span>
      </p>

      <!-- 腿表。约束**原文**，见组件顶上第 3 条。 -->
      <div v-if="legs.length" class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="text-xs text-muted">
            <tr>
              <th class="py-1 pr-3">{{ t("route.procedures.table.proc") }}</th>
              <th class="py-1 pr-3">{{ t("route.procedures.table.ident") }}</th>
              <th class="py-1 pr-3">{{ t("route.procedures.table.path") }}</th>
              <th class="py-1 pr-3">{{ t("route.procedures.table.alt") }}</th>
              <th class="py-1 pr-3">{{ t("route.procedures.table.speed") }}</th>
            </tr>
          </thead>
          <tbody class="font-mono text-ink">
            <tr
              v-for="(row, i) in legs"
              :key="i"
              class="border-t border-subtle"
            >
              <td class="py-1 pr-3 text-muted">
                {{ row.procedure.name
                }}<template v-if="row.leg.part === 'missed'"> MA</template>
              </td>
              <td class="py-1 pr-3">
                {{ row.leg.ident || "—" }}
                <span
                  v-if="row.leg.lat == null"
                  :title="t('route.procedures.noFix')"
                  class="text-muted"
                  >*</span
                >
              </td>
              <td class="py-1 pr-3 text-muted">{{ row.leg.path ?? "—" }}</td>
              <td class="py-1 pr-3">{{ row.leg.alt ?? "—" }}</td>
              <td class="py-1 pr-3">
                <template v-if="row.leg.speedKt">
                  {{ row.leg.speedKind ?? "" }}{{ row.leg.speedKt }}
                </template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="mt-2 text-xs text-muted">
          {{ t("route.procedures.rawNote") }}
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.runway-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.75rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: 0.5rem;
  text-align: left;
}
.runway-row.is-selected {
  border-color: var(--color-brand-deep);
  box-shadow: inset 0 0 0 1px var(--color-brand-deep);
}
.runway-row:disabled {
  opacity: 0.6;
}
.runway-meta {
  font-size: 0.75rem;
  color: var(--color-muted);
}
.wind-chip {
  margin-left: auto;
  padding: 0.125rem 0.5rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.wind-chip.is-head {
  background: var(--color-success-bg);
  color: var(--color-success-fg);
}
.wind-chip.is-tail {
  background: var(--color-danger-bg);
  color: var(--color-danger-fg);
}
</style>
