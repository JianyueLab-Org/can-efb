<script setup lang="ts">
/**
 * 跑道与进离场程序的选择器。
 *
 * 规划器（can-db）已经替你挑了一条 SID 和一条 STAR —— 它挑的依据是「航路从哪个
 * 点接进网络」，而**它不知道今天用哪条跑道**：跑道由管制员按风向定，不在飞行计
 * 划里。所以这个组件补的正是那一半：先选跑道，再在这条跑道服务的程序里挑。
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
 * ## 进近只画，不进航路串
 *
 * 进近不是填报航路的一部分（管制员给的），所以选了它只影响图上画什么和腿表里列
 * 什么，不动那串字符。这不是偷懒 —— 把进近写进航路串会得到一份管制员读起来莫名
 * 其妙的计划。
 */
import { computed, ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import { publishToMap, type MapPoint } from "@/lib/mapBus";
import {
  composeRoutePoints,
  fetchAirportProcedures,
  joinIdent,
  joinsRoute,
  pickProcedures,
  procedureLabel,
  ProcedureError,
  procedureRunways,
  rewriteRoute,
  runwayIdents,
  servesAllRunways,
  type AirportProcedures,
  type Procedure,
  type ProcedureKind,
} from "@/lib/procedures";

const props = defineProps<{
  messages: Record<string, unknown>;
  departure: string;
  arrival: string;
  /** 两端机场之间的航路点，**不含两端机场**。见 routePlan.ts 的 planEnroutePoints。 */
  enroute: MapPoint[];
  /** 规划器给的那串，改写以它为底。 */
  route: string;
  /** 规划器挑的那两条，用来判断「首尾那个记号本来是不是程序名」。 */
  planSid: string;
  planStar: string;
  departurePoint: MapPoint | null;
  arrivalPoint: MapPoint | null;
}>();

const emit = defineEmits<{ (e: "update:route", value: string): void }>();
const t = createTranslator(props.messages);

/**
 * 按 ICAO 缓存，**模块级而不是组件级**：换一次目的地再换回来是常见操作，而每个
 * 机场是一次几百 KB 的下载。组件级的缓存活不过一次卸载。
 */
const cache = new Map<string, AirportProcedures>();

const depData = ref<AirportProcedures | null>(null);
const arrData = ref<AirportProcedures | null>(null);
const busy = ref(false);
/** `denied` 和别的失败分开：没有 aipAccess 是这个网络的常态，不是故障。 */
const denied = ref(false);
const failed = ref(false);

const depRunway = ref("");
const arrRunway = ref("");
const sidName = ref("");
const starName = ref("");
const approachName = ref("");

async function load(icao: string): Promise<AirportProcedures | null> {
  const code = icao.trim().toUpperCase();
  if (code.length !== 4) return null;
  const hit = cache.get(code);
  if (hit) return hit;
  const data = await fetchAirportProcedures(code);
  cache.set(code, data);
  return data;
}

async function loadBoth() {
  busy.value = true;
  denied.value = false;
  failed.value = false;
  try {
    const [a, b] = await Promise.all([
      load(props.departure),
      load(props.arrival),
    ]);
    depData.value = a;
    arrData.value = b;
    // 规划器挑的那两条当默认值 —— 打开就看到它已经选好了什么，而不是一片空白。
    sidName.value = props.planSid ?? "";
    starName.value = props.planStar ?? "";
    approachName.value = "";
    depRunway.value = "";
    arrRunway.value = "";
  } catch (e) {
    depData.value = null;
    arrData.value = null;
    if (e instanceof ProcedureError && (e.status === 401 || e.status === 403)) {
      denied.value = true;
    } else {
      failed.value = true;
      console.error("[efb:procedures] 取程序失败:", e);
    }
  } finally {
    busy.value = false;
  }
}

watch(
  () => [props.departure, props.arrival] as const,
  ([a, b]) => {
    if (a?.length === 4 && b?.length === 4) void loadBoth();
  },
  { immediate: true },
);

const depRunways = computed(() => runwayIdents(depData.value?.runways ?? []));
const arrRunways = computed(() => runwayIdents(arrData.value?.runways ?? []));

const sids = computed(() =>
  pickProcedures(depData.value?.procedures ?? [], "sid", depRunway.value),
);
const stars = computed(() =>
  pickProcedures(arrData.value?.procedures ?? [], "star", arrRunway.value),
);
const approaches = computed(() =>
  pickProcedures(arrData.value?.procedures ?? [], "approach", arrRunway.value),
);

/** 选中的那条。按名字找，找不到就是没选 —— 换跑道之后原来那条可能已经不在列表里。 */
function find(list: Procedure[], name: string): Procedure | null {
  return list.find((p) => procedureLabel(p) === name) ?? null;
}
const sid = computed(() => find(sids.value, sidName.value));
const star = computed(() => find(stars.value, starName.value));
const approach = computed(() => find(approaches.value, approachName.value));

/**
 * 换跑道之后，原来选的那条如果不再服务这条跑道，**清掉而不是留着**。
 *
 * 留着的后果最坏：下拉框显示着一条程序名，而它不在选项里 —— 浏览器会把 select
 * 显示成空，但 `sidName` 还是旧值，于是航路串里也还是旧的那条。人看到的是空，填
 * 出去的是旧值。
 */
watch([sids, stars, approaches], () => {
  if (sidName.value && !find(sids.value, sidName.value)) sidName.value = "";
  if (starName.value && !find(stars.value, starName.value)) starName.value = "";
  if (approachName.value && !find(approaches.value, approachName.value)) {
    approachName.value = "";
  }
});

// ---------------------------------------------------------------- 衔接

const firstEnroute = computed(() => props.enroute[0]?.ident ?? "");
const lastEnroute = computed(
  () => props.enroute[props.enroute.length - 1]?.ident ?? "",
);

const sidJoin = computed(() => joinsRoute(sid.value, firstEnroute.value));
const starJoin = computed(() => joinsRoute(star.value, lastEnroute.value));

// ---------------------------------------------------------------- 输出

/**
 * 选了什么就改写航路串、重画地图。
 *
 * 两件事一起做而不是分开 watch：它们读的是同一批状态，分开写迟早出现「图上是新
 * 的、串还是旧的」那半秒 —— 而人正好可能在那半秒里按下「填入飞行计划」。
 */
watch(
  [sid, star, approach, () => props.enroute, () => props.route],
  () => {
    if (!depData.value && !arrData.value) return;

    emit(
      "update:route",
      rewriteRoute(
        props.route,
        { sid: props.planSid, star: props.planStar },
        {
          sid: sid.value ? sid.value.name : null,
          star: star.value ? star.value.name : null,
        },
      ),
    );

    publishToMap({
      points: composeRoutePoints({
        departure: props.departurePoint,
        sid: sid.value,
        enroute: props.enroute,
        star: star.value,
        approach: approach.value,
        arrival: props.arrivalPoint,
      }),
      label: `${props.departure} → ${props.arrival}`,
    });
  },
  { deep: false },
);

/** 摆出来的腿表：选中的三条程序按飞行顺序接起来。 */
const legs = computed(() =>
  [sid.value, star.value, approach.value]
    .filter((p): p is Procedure => Boolean(p))
    .flatMap((p) => p.path.map((leg) => ({ procedure: p, leg }))),
);

function runwayNote(p: Procedure): string {
  return servesAllRunways(p)
    ? t("route.procedures.anyRunway")
    : procedureRunways(p).join(" ");
}

function kindLabel(kind: ProcedureKind): string {
  return t(`route.procedures.kind.${kind}`);
}
</script>

<template>
  <section
    v-if="denied || failed || depData || arrData"
    class="flex flex-col gap-4"
  >
    <h3 class="text-sm font-semibold text-ink">
      {{ t("route.procedures.title") }}
    </h3>

    <p v-if="busy" class="text-sm text-muted">
      {{ t("route.procedures.loading") }}
    </p>

    <!-- 没权限是常态，不是故障 —— 和别的失败分开说。 -->
    <p v-else-if="denied" class="text-sm text-muted">
      {{ t("route.procedures.denied") }}
    </p>
    <p v-else-if="failed" class="text-sm text-danger">
      {{ t("route.procedures.failed") }}
    </p>

    <template v-else>
      <div class="grid gap-3 @md:grid-cols-2">
        <!-- 离场 -->
        <div class="flex flex-col gap-2">
          <p class="text-xs font-medium text-ink">
            {{ t("route.procedures.departure") }}
            <span class="font-mono text-muted">{{ departure }}</span>
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{
              t("route.procedures.runway")
            }}</span>
            <select v-model="depRunway" class="input font-mono">
              <option value="">{{ t("route.procedures.anyRunway") }}</option>
              <option v-for="r in depRunways" :key="r" :value="r">
                {{ r }}
              </option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted"
              >{{ kindLabel("sid") }} · {{ sids.length }}</span
            >
            <select v-model="sidName" class="input font-mono">
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
        </div>

        <!-- 进场 -->
        <div class="flex flex-col gap-2">
          <p class="text-xs font-medium text-ink">
            {{ t("route.procedures.arrival") }}
            <span class="font-mono text-muted">{{ arrival }}</span>
          </p>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted">{{
              t("route.procedures.runway")
            }}</span>
            <select v-model="arrRunway" class="input font-mono">
              <option value="">{{ t("route.procedures.anyRunway") }}</option>
              <option v-for="r in arrRunways" :key="r" :value="r">
                {{ r }}
              </option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted"
              >{{ kindLabel("star") }} · {{ stars.length }}</span
            >
            <select v-model="starName" class="input font-mono">
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
          <label class="flex flex-col gap-1">
            <span class="text-xs text-muted"
              >{{ kindLabel("approach") }} · {{ approaches.length }}</span
            >
            <select v-model="approachName" class="input font-mono">
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
          <p class="text-xs text-muted">
            {{ t("route.procedures.approachNote") }}
          </p>
        </div>
      </div>

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
              <td class="py-1 pr-3 text-muted">{{ row.procedure.name }}</td>
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
