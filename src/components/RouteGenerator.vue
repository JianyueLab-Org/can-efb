<script setup lang="ts">
/**
 * 航路生成：给两个机场，问 can-db「该怎么飞」。
 *
 * 和同一页上的**航路展开**是两件事，都保留：展开是「我已经有一条航路字符串，把它
 * 变成点」（can-api），生成是「我还没有航路，给我一条」（can-db）。
 *
 * **规划逻辑一行都不在这里。** 它在 can-db 的 `internal/aip/route.go` —— 那是关于
 * 那批数据的规则，不是渲染。这个组件只负责问、显示、以及把结果推给地图。
 *
 * 有三样东西是**必须显示、不能省成好看**的，can-db 的注释里逐条写了为什么：
 *
 * 1. **`source`：汇编发布的走法 vs 我们算出来的最短路径。** 这两者不是同一种答
 *    案。10,367 对城市有已发布的走法，其余都是算的 —— 读的人必须一眼分得清自己
 *    拿到的是哪一种。
 * 2. **`levelBelowMtca`：请求的巡航高度低于全程最低超障高度。** 这是安全提示，
 *    不是一个样式。
 * 3. **`notes`：规划器每一次降级的记录。** 一条悄悄从附近某个航路点切进网络的航
 *    路，和一条走已发布 SID 出去的，在图上长得一模一样 —— 而对要拿去填计划的人
 *    来说差别很大。
 *
 * 限制和空域**只摆原文，不做判断**：它们的生效时间是散文（「byNOTAM」「每日
 * 0700-0830」），一个自作主张读懂了的规划器比一个把原文摆出来的危险得多。
 */
import { ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import { publishToMap } from "@/lib/mapBus";
import { saveDraft } from "@/lib/planDraft";
import {
  planRoute,
  planToMapPoints,
  RoutePlanError,
  type RoutePlan,
} from "@/lib/routePlan";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const from = ref("");
const to = ref("");
const level = ref("");

const busy = ref(false);
const plan = ref<RoutePlan | null>(null);
const error = ref<string | null>(null);

async function generate() {
  const a = from.value.trim().toUpperCase();
  const b = to.value.trim().toUpperCase();
  if (!a || !b) return;

  busy.value = true;
  error.value = null;
  plan.value = null;

  try {
    const result = await planRoute(a, b, Number(level.value) || undefined);
    plan.value = result;
    publishToMap({
      points: planToMapPoints(result),
      label: `${result.from} → ${result.to}`,
    });
  } catch (e) {
    // 400 和 404 是两种不同的答案，不合并成一句「失败」：一个是改输入，另一个是
    // 这对城市在这个高度上没有走法，改输入也没用。
    if (e instanceof RoutePlanError) {
      error.value =
        e.status === 404
          ? t("route.generate.noRoute")
          : e.status === 400
            ? e.message || t("route.generate.badInput")
            : t("route.generate.failed");
    } else {
      error.value = t("route.generate.failed");
    }
  } finally {
    busy.value = false;
  }
}

/**
 * 把这条航路交给飞行计划页。
 *
 * **只交机场和航路串，不交巡航高度。** 上面那个高度框是喂给规划器的**输入**
 * （「按这个高度选航路」），而计划里那一栏要的是 `FL350` 这种写法 —— 35000 和
 * FL350 是两种写法，而过渡高度以下根本不该写成 FL。猜错会填出一个**格式合法但
 * 意思不对**的高度，那种错误 422 拦不住，因为它没错。
 *
 * 交接是一次性的，见 lib/planDraft.ts。
 */
function toFlightPlan() {
  if (!plan.value) return;
  const ok = saveDraft({
    departure: plan.value.from,
    arrival: plan.value.to,
    route: plan.value.route,
    source: plan.value.source,
  });
  // 存不下就别跳 —— 跳过去什么都没填才是真的莫名其妙。
  if (ok) window.location.href = "/flightplan";
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="grid gap-3 @md:grid-cols-3">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">{{ t("route.generate.from") }}</span>
        <input
          v-model="from"
          class="input font-mono uppercase"
          maxlength="4"
          autocomplete="off"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">{{ t("route.generate.to") }}</span>
        <input
          v-model="to"
          class="input font-mono uppercase"
          maxlength="4"
          autocomplete="off"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted">{{ t("route.generate.level") }}</span>
        <input
          v-model="level"
          class="input font-mono"
          inputmode="numeric"
          autocomplete="off"
        />
      </label>
    </div>

    <button
      type="button"
      class="btn btn-primary self-start"
      :disabled="busy || !from.trim() || !to.trim()"
      @click="generate"
    >
      {{ busy ? t("route.generate.working") : t("route.generate.action") }}
    </button>

    <p v-if="error" class="text-sm text-danger">{{ error }}</p>

    <template v-if="plan">
      <!-- 汇编发布 vs 算出来的：见组件顶上第 1 条。 -->
      <p class="text-xs text-muted">
        {{
          plan.source === "published"
            ? t("route.generate.published")
            : t("route.generate.computed")
        }}
        <span v-if="plan.publishedName" class="font-mono">
          · {{ plan.publishedName }}</span
        >
        <span v-if="plan.alternatives">
          · {{ t("route.generate.alternatives") }} {{ plan.alternatives }}</span
        >
      </p>

      <!-- 可以直接填的那串。等宽、可选中 —— 它是拿来复制的。 -->
      <p class="card break-all p-3 font-mono text-sm text-ink">
        {{ plan.route }}
      </p>

      <button
        type="button"
        class="btn btn-secondary self-start"
        @click="toFlightPlan"
      >
        {{ t("route.generate.toFlightPlan") }}
      </button>

      <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span>
          {{ t("route.generate.distance") }}
          <span class="font-mono text-ink">{{
            plan.distanceKm.toFixed(0)
          }}</span>
          km
        </span>
        <span>
          {{ t("route.generate.direct") }}
          <span class="font-mono">{{ plan.directKm.toFixed(0) }}</span> km
        </span>
        <span v-if="plan.minSafeAltM">
          {{ t("route.generate.minSafe") }}
          <span class="font-mono">{{ plan.minSafeAltM }}</span> m
        </span>
      </div>

      <!-- 安全提示，见组件顶上第 2 条。刻意用告警样式而不是一行灰字。 -->
      <p v-if="plan.levelBelowMtca" class="card border-danger p-3 text-sm">
        {{ t("route.generate.belowMtca") }}
        <span v-if="plan.mtcaM" class="font-mono">{{ plan.mtcaM }} m</span>
      </p>

      <!-- 规划器的降级记录，见组件顶上第 3 条。 -->
      <ul
        v-if="plan.notes?.length"
        class="flex list-disc flex-col gap-1 pl-5 text-sm text-muted"
      >
        <li v-for="(note, i) in plan.notes" :key="i">{{ note }}</li>
      </ul>

      <!-- 限制与空域：只摆原文。 -->
      <div v-if="plan.restrictions.length" class="flex flex-col gap-2">
        <p class="text-xs font-medium text-ink">
          {{ t("route.generate.restrictions") }}
        </p>
        <p
          v-for="(r, i) in plan.restrictions"
          :key="i"
          class="card p-3 text-sm text-muted"
        >
          <span v-if="r.code" class="font-mono text-ink">{{ r.code }} </span>
          {{ r.body }}
        </p>
      </div>

      <div v-if="plan.airspaces.length" class="flex flex-col gap-2">
        <p class="text-xs font-medium text-ink">
          {{ t("route.generate.airspaces") }}
        </p>
        <p
          v-for="(a, i) in plan.airspaces"
          :key="i"
          class="card p-3 text-sm text-muted"
        >
          <span class="font-mono text-ink">{{ a.code ?? a.name }} </span>
          <span v-if="a.localType">· {{ a.localType }} </span>
          <span v-if="a.activeTime">· {{ a.activeTime }}</span>
        </p>
      </div>
    </template>
  </section>
</template>
