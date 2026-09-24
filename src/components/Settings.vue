<script setup lang="ts">
/**
 * 设置。三块，来路完全不同，所以分开放：
 *
 * 1. **账户** —— 只读，来自会话。改资料在主站，这里不重复一套表单：那会变成
 *    第二个可以改成员数据的地方，而它们迟早会对不上。
 * 2. **SimBrief 绑定** —— 真的写 can-api（`/api/v1/pilot/simbrief`）。绑的时候
 *    那边会先向 SimBrief 验证再存，而且**存的是数字 ID 而不是你输入的别名**，
 *    所以绑定成功后回显的值可能和输入的不一样，这是对的。
 * 3. **本机偏好** —— 主题、语言、侧栏，全部只存在这台设备上。它们不值得占用
 *    can-api 的一张表，而且换一台设备本来就该重新选。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api, describeFailure } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { Icon } from "@jianyuelab-org/can-ui";

const props = defineProps<{
  messages: Record<string, unknown>;
  userName: string;
  userId: string;
  email: string;
  rating: number;
}>();
const t = createTranslator(props.messages);

/* -------------------------------------------------------------- SimBrief */
const simbriefId = ref<string | null>(null);
const identifier = ref("");
const busy = ref(false);
const loading = ref(true);
/** 读绑定状态失败。和「未绑定」分开，否则失败会被画成没绑定。 */
const loadFailed = ref(false);
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);

async function loadSimbrief() {
  loading.value = true;
  loadFailed.value = false;
  notice.value = null;
  const result = await api<{ simbriefId: string | null }>(
    "/api/v1/pilot/simbrief",
  );
  loading.value = false;
  if (result.ok) {
    simbriefId.value = result.data.simbriefId ?? null;
    return;
  }
  // **读失败不等于没绑定。** 只设横幅的话 simbriefId 留在 null，模板落进「未绑定」
  // 那一支并摆出输入框 —— 一句假话，可能让人以为绑定掉了、再绑一次。所以失败单独
  // 一个状态，模板里有它自己的分支。
  loadFailed.value = true;
  notice.value = { kind: "error", text: describeFailure(t, result) };
}

async function link() {
  if (busy.value || !identifier.value.trim()) return;
  busy.value = true;
  notice.value = null;

  const result = await api<{ simbriefId: string }>("/api/v1/pilot/simbrief", {
    method: "POST",
    body: JSON.stringify({ identifier: identifier.value.trim() }),
  });
  busy.value = false;

  if (!result.ok) {
    notice.value = { kind: "error", text: describeFailure(t, result) };
    return;
  }
  simbriefId.value = result.data.simbriefId;
  identifier.value = "";
  notice.value = { kind: "ok", text: t("settings.simbrief.linked") };
}

async function unlink() {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  const result = await api("/api/v1/pilot/simbrief", { method: "DELETE" });
  busy.value = false;

  if (!result.ok) {
    notice.value = { kind: "error", text: describeFailure(t, result) };
    return;
  }
  simbriefId.value = null;
  notice.value = { kind: "ok", text: t("settings.simbrief.unlinked") };
}

/* ------------------------------------------------------------ 本机偏好 */
const railCollapsed = ref(false);

// 和 AppRail 一样只写 data-rail、再由观察者读回来：轨上那颗按钮也会改它，
// 这边的开关要跟着变，而不是停在进页面时读到的值上。
let railObserver: MutationObserver | null = null;

function syncRail() {
  railCollapsed.value = document.documentElement.dataset.rail === "collapsed";
}

function toggleRail(next: boolean) {
  document.documentElement.dataset.rail = next ? "collapsed" : "expanded";
  try {
    localStorage.setItem("efb.rail", next ? "collapsed" : "expanded");
  } catch {
    // 见 AppRail 里同一处的说明。
  }
}

onMounted(() => {
  syncRail();
  railObserver = new MutationObserver(syncRail);
  railObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-rail"],
  });
  void loadSimbrief();
});
onBeforeUnmount(() => railObserver?.disconnect());
</script>

<template>
  <div class="space-y-5">
    <!-- 账户 -->
    <section class="card p-5">
      <h2 class="text-sm font-semibold text-ink">
        {{ t("settings.account.title") }}
      </h2>
      <p class="mt-1 text-sm text-muted">{{ t("settings.account.hint") }}</p>
      <dl class="mt-4 grid gap-4 @xs:grid-cols-2 @2xl:grid-cols-4">
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.name") }}
          </dt>
          <dd class="mt-0.5 truncate text-sm font-medium text-ink">
            {{ userName }}
          </dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.id") }}
          </dt>
          <dd class="mt-0.5 font-mono text-sm text-ink">{{ userId }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.email") }}
          </dt>
          <dd class="mt-0.5 truncate text-sm text-ink">{{ email }}</dd>
        </div>
        <div>
          <dt class="text-xs uppercase tracking-wide text-faint">
            {{ t("settings.account.rating") }}
          </dt>
          <dd class="mt-0.5 text-sm text-ink">{{ rating }}</dd>
        </div>
      </dl>
    </section>

    <!-- SimBrief -->
    <section class="card p-5">
      <h2 class="text-sm font-semibold text-ink">
        {{ t("settings.simbrief.title") }}
      </h2>
      <p class="mt-1 text-sm text-muted">{{ t("settings.simbrief.hint") }}</p>

      <div
        v-if="notice"
        :class="[
          'mt-3 flex items-start gap-2 rounded-control px-3 py-2 text-sm',
          notice.kind === 'ok'
            ? 'bg-success-bg text-success-fg'
            : 'bg-danger-bg text-danger-fg',
        ]"
        role="status"
      >
        <Icon
          :name="notice.kind === 'ok' ? 'checkCircle' : 'exclamationTriangle'"
          class="mt-px size-4 shrink-0"
        />
        <span>{{ notice.text }}</span>
      </div>

      <p v-if="loading" class="mt-4 text-sm text-muted">
        {{ t("common.loading") }}
      </p>

      <div
        v-else-if="loadFailed"
        class="mt-4 flex flex-wrap items-center gap-3 text-sm"
      >
        <span class="text-muted">{{ t("settings.simbrief.loadFailed") }}</span>
        <button
          type="button"
          class="btn btn-secondary ml-auto"
          @click="loadSimbrief"
        >
          {{ t("common.retry") }}
        </button>
      </div>

      <div
        v-else-if="simbriefId"
        class="mt-4 flex flex-wrap items-center gap-3 text-sm"
      >
        <span class="badge badge-success">
          <Icon name="checkCircle" class="size-3" />
          {{ t("settings.simbrief.bound") }}
        </span>
        <span class="font-mono text-ink">{{ simbriefId }}</span>
        <button
          type="button"
          class="btn btn-danger ml-auto"
          :disabled="busy"
          @click="unlink"
        >
          {{ t("settings.simbrief.unlink") }}
        </button>
      </div>

      <div v-else class="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          v-model="identifier"
          class="input sm:max-w-xs"
          :placeholder="t('settings.simbrief.placeholder')"
          @keydown.enter.prevent="link"
        />
        <button
          type="button"
          class="btn btn-primary"
          :disabled="busy || !identifier.trim()"
          @click="link"
        >
          {{ t("settings.simbrief.link") }}
        </button>
      </div>
    </section>

    <!-- 本机偏好 -->
    <section class="card p-5">
      <h2 class="text-sm font-semibold text-ink">
        {{ t("settings.local.title") }}
      </h2>
      <p class="mt-1 text-sm text-muted">{{ t("settings.local.hint") }}</p>

      <div class="mt-4 flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-sm font-medium text-ink">
            {{ t("settings.local.rail") }}
          </p>
          <p class="text-xs text-muted">{{ t("settings.local.railHint") }}</p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-checked="railCollapsed"
          :class="[
            'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
            railCollapsed ? 'bg-can' : 'bg-surface-sunken',
          ]"
          @click="toggleRail(!railCollapsed)"
        >
          <span class="sr-only">{{ t("settings.local.rail") }}</span>
          <span
            :class="[
              'my-0.5 size-5 rounded-full bg-white shadow-card transition-transform',
              railCollapsed ? 'translate-x-5' : 'translate-x-0.5',
            ]"
          ></span>
        </button>
      </div>

      <p class="mt-4 text-xs text-faint">{{ t("settings.local.themeHint") }}</p>
    </section>
  </div>
</template>
