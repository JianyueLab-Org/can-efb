<script setup lang="ts">
/**
 * 飞行计划页的容器：读、交、撤、导入、锁定，和那一条横幅。
 *
 * 字段、状态行、SimBrief 按钮各是一个子组件（PlanForm、PlanStatusBar、
 * SimbriefImport）；**请求只在这里发**，子组件只报事件。这样「提交之后回读失败不
 * 能盖掉已提交」「409 锁定只能靠重新检查解开」这些跨越几块界面的规则只有一处。
 *
 * 另外把正在填的航路画到地图上（`preview*`）。那是**预览**，不是校验：画不出来的
 * 原因写在航路那一格的说明里，交得上交不上仍然只由 can-api 的 422 决定。
 *
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
 * - **409 callsignInUse** 是别人正用这个呼号连着。它不锁表单（改个呼号就能交），
 *   文案走 `common.apiError.callsignInUse`，见 `describeFailure`。
 *
 * SimBrief 是**导入到表单**，不是直接提交。can-api 那边的注释写得很清楚：直接
 * 提交等于把一份成员自己没看过的计划推到全网管制员面前。
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import {
  announcePlanChanged,
  publishToMap,
  showPlanOnMap,
  type MapPoint,
} from "@/lib/mapBus";
import { takeDraft } from "@/lib/planDraft";
import {
  blankPlan,
  fillPlan,
  type Plan,
  type StoredPlan,
} from "@/lib/flightPlan";
import { previewKey, resolveRoute, shouldPreview } from "@/lib/routePreview";
import type { RequestState } from "@/lib/requestState";
import { Icon } from "@jianyuelab-org/can-ui";
import PanelSection from "@/components/ui/PanelSection.vue";
import SimbriefImport from "./SimbriefImport.vue";
import PlanStatusBar from "./PlanStatusBar.vue";
import PlanForm from "./PlanForm.vue";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const form = reactive<Plan>(blankPlan());
const fieldErrors = ref<Record<string, string>>({});

const loading = ref(true);
const saving = ref(false);
const deleting = ref(false);

/** 已存在的计划；null 表示这名成员现在没有计划 —— **前提是读到了**，见 loadFailed。 */
const stored = ref<StoredPlan | null>(null);

/**
 * 计划**没读到**，和**没有计划**，是两件事 —— 和 Dashboard 的 `planFailed` 同
 * 一个判断。
 *
 * 以前读取失败只在横幅里放一句错误，`stored` 留在 null，于是状态行写着「当前没
 * 有已提交的飞行计划」、按钮写着「提交计划」、撤销按钮消失 —— 整个界面在告诉他
 * 没有计划。而他可能有：此时再交一份，就是拿一张空白表单**覆盖掉**他没看到的那
 * 份。所以没读到之前表单整个锁着，状态行说清楚是没读到，并给一个重读的按钮。
 *
 * 状态走状态行而不是顶部横幅：提交成功之后会重读一次，那次重读失败**不能**盖掉
 * 「已提交」—— 提交确实成功了，只是回读没成。两件事各占一个位置。
 */
const loadFailed = ref(false);

/** 顶部那条横幅：成功、失败、或者被管制员锁住。 */
const notice = ref<{ kind: "ok" | "error" | "locked"; text: string } | null>(
  null,
);
/** 被锁时占着标牌的管制员，锁定态下表单整个禁用。 */
const lockedBy = ref<string | null>(null);

const disabled = computed(
  () =>
    loading.value ||
    saving.value ||
    deleting.value ||
    loadFailed.value ||
    !!lockedBy.value,
);

/**
 * 读当前计划。`fillForm` 为假时只刷新状态行、不动表单 —— 重新检查锁定时用，见
 * `recheck()`。
 */
async function load(fillForm = true) {
  loading.value = true;
  const result = await api<StoredPlan | null>("/api/v1/pilot/flightplan");
  loading.value = false;

  if (!result.ok) {
    // 不写横幅，见 loadFailed 的注释。草稿也不在这时取出来：它会留到重读成功。
    loadFailed.value = true;
    return;
  }
  loadFailed.value = false;
  stored.value = result.data ?? null;
  if (!fillForm) return;
  if (result.data) fillPlan(form, result.data);

  applyDraft();
}

/**
 * 锁定之后的「重新检查」。
 *
 * **锁是读不出来的。** can-api 的 GET 不带标牌信息；datafeed 里有 `tracked_by`，
 * 但那要按 CID 找自己那架飞机（按呼号找会认错人，见 `lib/datafeed.ts` 的
 * `ownPilot`），而这个岛屿拿不到 CID。所以以前 409 一旦把 `lockedBy` 写上，就再
 * 没有东西能把它清掉，表单一直锁到刷新整页。
 *
 * 这里做的是：重读一次计划（管制员可能已经改过，状态行要跟上），然后**解锁**。
 * 解锁不等于判定没人占着 —— 真正的判定仍然是提交时那个 409，它在推送**之前**就
 * 判掉，数据库里什么都不留，所以再撞一次也没有代价，撞上了就重新锁上。
 *
 * **不重填表单**：里面是他被 409 挡回来的那份修改，正是他解锁之后要再交的东西。
 * 也不替他重交 —— 标牌还在不在，由他自己按下提交去问。
 */
async function recheck() {
  await load(false);
  if (loadFailed.value) return;
  lockedBy.value = null;
  notice.value = { kind: "ok", text: t("flightplan.notice.rechecked") };
}

/**
 * 航路生成页交过来的那条航路。
 *
 * **只填空着的字段**，这是整件事的关键。跑在 `load()` **之后**，所以此时表单里
 * 已经是这名成员现有的计划 —— 一条从别的页面带过来的航路串静默覆盖掉已经交上去
 * 的计划，是这里唯一真正危险的失败方式：它没有报错，而人要到起飞前才发现航路不
 * 是自己填的那条。
 *
 * 锁定态（管制员占着标牌）也不填。**注意这道判断在这里其实还不成立** —— 锁只有
 * 在写入撞上 409 时才知道，读取时看不出来。留着是因为它是对的，而不是因为它此刻
 * 拦得住什么：真正的防线是提交时那个 409。
 *
 * 填了什么、以及那条航路是**汇编发布的还是算出来的**，都在横幅里说出来 —— 进了
 * 输入框之后这个区别就再也看不出来了。
 */
function applyDraft() {
  const draft = takeDraft();
  if (!draft || lockedBy.value) return;

  const filled: string[] = [];
  if (!form.route.trim()) {
    form.route = draft.route;
    filled.push(t("flightplan.draft.fields.route"));
  }
  if (!form.departure.trim() && draft.departure) {
    form.departure = draft.departure;
    filled.push(t("flightplan.draft.fields.departure"));
  }
  if (!form.arrival.trim() && draft.arrival) {
    form.arrival = draft.arrival;
    filled.push(t("flightplan.draft.fields.arrival"));
  }

  // 什么都没填时不要再跟一句「这条航路是……」—— 那时并没有一条航路被填进来，
  // 说它的来历只会让人以为表单里的内容变了。
  if (!filled.length) {
    notice.value = { kind: "ok", text: t("flightplan.draft.kept") };
    return;
  }

  const origin =
    draft.source === "published"
      ? t("flightplan.draft.published")
      : t("flightplan.draft.computed");

  notice.value = {
    kind: "ok",
    text: `${t("flightplan.draft.filled")}${filled.join("、")}。${origin}`,
  };
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
    announcePlanChanged();
    returnMapToPlan();
    // 回读失败只落在状态行，不碰这条横幅 —— 见 loadFailed。
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
  notice.value = { kind: "error", text: describeFailure(t, result) };
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
    notice.value = { kind: "error", text: describeFailure(t, result) };
    return;
  }
  stored.value = null;
  fillPlan(form, blankPlan());
  notice.value = { kind: "ok", text: t("flightplan.notice.deleted") };
  announcePlanChanged();
  returnMapToPlan();
}

function onImported(plan: Plan) {
  fillPlan(form, plan);
  fieldErrors.value = {};
  // 导入完**不自动提交** —— 见 SimbriefImport。
  notice.value = { kind: "ok", text: t("flightplan.notice.imported") };
}

function onImportFailed(text: string) {
  notice.value = { kind: "error", text };
}

const submitLabel = computed(() =>
  saving.value
    ? t("flightplan.actions.filing")
    : // 没读到时说「更新」而不是「提交」：不替他假设没有计划。按钮此时本来也锁着。
      stored.value || loadFailed.value
      ? t("flightplan.actions.refile")
      : t("flightplan.actions.file"),
);

/* ---- 航路预览 ---- */

const preview = ref<RequestState<MapPoint[]> | null>(null);
/** 已经推给地图的那一份。null＝还没推过，地图上仍是已提交的计划。 */
let previewedKey: string | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewAbort: AbortController | undefined;

function storedKey(): string | null {
  const s = stored.value;
  return s ? previewKey(s.departure, s.arrival, s.route) : null;
}

/**
 * 交了或撤了之后，把地图交还给已提交的计划。
 *
 * 光发 `announcePlanChanged()` 不够：预览推过一次之后地图记着「面板接管了」
 * （useRouteLayer 的 `panelPublished`），计划变了它也不重画 —— 图上会一直是那条标着
 * 「正在填写」的线，而它其实已经交上去了（或者已经撤了）。`showPlanOnMap()` 清掉那
 * 个状态再重读；`previewedKey` 回到 null，和刚打开页面一样，框里就是已提交的那份
 * 时不再重画一遍。
 */
function returnMapToPlan() {
  clearTimeout(previewTimer);
  previewAbort?.abort();
  previewedKey = null;
  preview.value = null;
  showPlanOnMap();
}

async function runPreview() {
  const { departure, arrival, route } = form;
  if (!shouldPreview(departure, arrival, route)) {
    // 填得还不够画。以前推过的那条已经不是框里的这条了，撤掉。撤掉之后记成空串
    // 而不是 null：地图上已经没有已提交的那份了，下次框里回到那份也要重新画。
    if (previewedKey !== null) {
      publishToMap({});
      previewedKey = "";
    }
    preview.value = null;
    return;
  }
  const key = previewKey(departure, arrival, route);
  if (key === previewedKey) return;
  // 刚打开页面、框里就是已提交的那份：地图本来就画着它（挂载时发过 showPlanOnMap），
  // 不必再问一遍。
  if (previewedKey === null && key === storedKey()) return;

  previewAbort?.abort();
  previewAbort = new AbortController();
  const signal = previewAbort.signal;
  const state = await resolveRoute(departure, arrival, route, signal);
  if (signal.aborted) return;

  previewedKey = key;
  preview.value = state;
  if (state.kind === "data") {
    publishToMap({
      points: state.data,
      label: t("flightplan.preview.label", {
        from: departure.trim().toUpperCase(),
        to: arrival.trim().toUpperCase(),
      }),
    });
  } else {
    // 画不出来就一条都不画：留着上一条，图上那条就不是框里这条了。
    publishToMap({});
  }
}

watch(
  () => [form.departure, form.arrival, form.route],
  () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void runPreview(), 600);
  },
);

const previewNote = computed(() => {
  switch (preview.value?.kind) {
    case "forbidden":
      return t("flightplan.preview.forbidden");
    case "error":
      return t("flightplan.preview.failed");
    case "empty":
      return t("flightplan.preview.empty");
    default:
      return "";
  }
});

onMounted(() => {
  // 别的页面（航路、机场）可能刚往地图上推过东西。不先把地图拉回已提交的计划，
  // 下面「框里就是已提交那份就不重画」的跳过就不成立：图上会是一条不相干的线。
  showPlanOnMap();
  void load();
});
onBeforeUnmount(() => {
  clearTimeout(previewTimer);
  previewAbort?.abort();
});
</script>

<template>
  <div class="space-y-6">
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
      <span class="min-w-0 flex-1">{{ notice.text }}</span>
      <!-- 锁定只能靠这里解开，见 recheck()。 -->
      <button
        v-if="notice.kind === 'locked' && lockedBy"
        type="button"
        class="btn btn-secondary shrink-0"
        :disabled="loading"
        @click="recheck"
      >
        {{ t("flightplan.actions.recheck") }}
      </button>
    </div>

    <PlanStatusBar
      :messages="messages"
      :loading="loading"
      :load-failed="loadFailed"
      :stored="stored"
      :disabled="disabled"
      @reload="load()"
      @delete="remove"
    />

    <PanelSection :title="t('flightplan.actions.import')" :level="3">
      <SimbriefImport
        :messages="messages"
        :disabled="disabled"
        @imported="onImported"
        @failed="onImportFailed"
      />
    </PanelSection>

    <PlanForm
      v-model:form="form"
      :messages="messages"
      :errors="fieldErrors"
      :disabled="disabled"
      :submit-label="submitLabel"
      :preview-note="previewNote"
      @submit="file"
    />
  </div>
</template>
