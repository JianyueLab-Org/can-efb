<script setup lang="ts">
/**
 * 设置。三块，来路完全不同，所以分开放：
 *
 * 1. **账户** —— 只读，来自会话。改资料在主站，这里不重复一套表单：那会变成
 *    第二个可以改成员数据的地方，而它们迟早会对不上。
 * 2. **SimBrief 绑定** —— 真的写 can-api（`/api/v1/pilot/simbrief`）。绑的时候
 *    那边会先向 SimBrief 验证再存，而且**存的是数字 ID 而不是你输入的别名**，
 *    所以绑定成功后回显的值可能和输入的不一样，这是对的。
 * 3. **本机偏好** —— 主题、语言、侧栏、「不使用受限汇编」，全部只存在这台设备上。它们不值得占用
 *    can-api 的一张表，而且换一台设备本来就该重新选。
 * 4. **手机上的账户与跨站链接** —— 手机没有侧栏，退出登录、主题语言、去主站和
 *    别的卫星站的链接没有别的家，放在这一页最底下，只在手机上出现（`.phone-only`）。
 */
import { onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { api, describeFailure, signOut } from "@/lib/canApi";
import { createTranslator } from "@/lib/i18n";
import { hideNaip, setHideNaip } from "@/lib/naip";
import { currentRail, setRail } from "@/lib/railState";
import type { NavSection } from "@/lib/nav";
import { Icon, ThemeLangControls } from "@jianyuelab-org/can-ui";
import PanelSection from "@/components/ui/PanelSection.vue";
import StateCard from "@/components/ui/StateCard.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  userName: string;
  userId: string;
  email: string;
  rating: number;
  /** 只决定「不使用受限汇编」那一行出不出，不是权限判断（can-db 那边是 cap）。 */
  aipAccess: number;
  crossLinks: NavSection;
  locale: string;
}>();
const t = createTranslator(props.messages);

/* -------------------------------------------------------------- SimBrief */
const simbriefId = ref<string | null>(null);
const identifier = ref("");
const busy = ref(false);
const loading = ref(true);
/** 读绑定状态失败。和「未绑定」分开，否则失败会被画成没绑定。 */
const loadFailed = ref(false);
/** 读绑定失败时那一句具体原因，给状态卡的正文。 */
const loadFailure = ref("");
const notice = ref<{ kind: "ok" | "error"; text: string } | null>(null);
const simbriefInputId = useId();

async function loadSimbrief() {
  loading.value = true;
  loadFailed.value = false;
  loadFailure.value = "";
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
  // 一个状态，用状态卡说清楚，模板里有它自己的分支。
  loadFailed.value = true;
  loadFailure.value = describeFailure(t, result);
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

/* ------------------------------------------------------------ 退出登录 */

/**
 * 和轨上那颗按钮是同一件事（`lib/canApi.ts` 的 `signOut()`）：清 cookie 是
 * can-api 的活，跳转是我们的，**无论成败都跳**。手机上没有轨，这是唯一的入口。
 */
const signingOut = ref(false);
function handleSignOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  void signOut();
}

/* ------------------------------------------------------------ 本机偏好 */
const railCollapsed = ref(false);
const railLabelId = useId();

// 和 AppRail 一样只写 data-rail、再由观察者读回来：轨上那颗按钮也会改它，
// 这边的开关要跟着变，而不是停在进页面时读到的值上。
let railObserver: MutationObserver | null = null;

// 没选过时（`data-rail="auto"`）答案随宽度变，所以跨过断点也要再读一次。
function syncRail() {
  railCollapsed.value = currentRail() === "collapsed";
}

function toggleRail(next: boolean) {
  setRail(next ? "collapsed" : "expanded");
}

/*
 * 「不使用受限汇编」。3 级（受限可调用）以下不显示：对他们 can-db 那边恒为空转，摆
 * 出来只会让人以为自己错过了什么。
 *
 * 本地镜像一份、挂载后才读：服务端不知道 localStorage，直接绑 `hideNaip` 会让水合
 * 前后对不上。初值取默认（开），和服务端渲染的一致。之后跟着它走，别的标签页改了这
 * 里也变。
 */
const AIP_RESTRICTED_CALL = 3;
const canHideNaip = props.aipAccess >= AIP_RESTRICTED_CALL;
const naipHidden = ref(true);
const naipLabelId = useId();
watch(hideNaip, (on) => {
  naipHidden.value = on;
});

onMounted(() => {
  naipHidden.value = hideNaip.value;
  syncRail();
  railObserver = new MutationObserver(syncRail);
  railObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-rail"],
  });
  window.addEventListener("resize", syncRail);
  void loadSimbrief();
});
onBeforeUnmount(() => {
  railObserver?.disconnect();
  window.removeEventListener("resize", syncRail);
});
</script>

<template>
  <div class="space-y-8">
    <PanelSection
      :title="t('settings.account.title')"
      :description="t('settings.account.hint')"
    >
      <dl class="grid gap-4 @xs:grid-cols-2 @2xl:grid-cols-4">
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
    </PanelSection>

    <PanelSection
      :title="t('settings.local.title')"
      :description="t('settings.local.hint')"
    >
      <div class="space-y-4">
        <!-- 手机上没有侧栏，这个开关在那里什么都不做，不摆出来。 -->
        <div class="phone-hidden flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p :id="railLabelId" class="text-sm font-medium text-ink">
              {{ t("settings.local.rail") }}
            </p>
            <p class="text-xs text-muted">{{ t("settings.local.railHint") }}</p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="railCollapsed"
            :aria-labelledby="railLabelId"
            :class="[
              'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
              railCollapsed ? 'bg-can' : 'bg-surface-sunken',
            ]"
            @click="toggleRail(!railCollapsed)"
          >
            <span
              :class="[
                'my-0.5 size-5 rounded-full bg-white shadow-card transition-transform',
                railCollapsed ? 'translate-x-5' : 'translate-x-0.5',
              ]"
            ></span>
          </button>
        </div>

        <div v-if="canHideNaip" class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p :id="naipLabelId" class="text-sm font-medium text-ink">
              {{ t("settings.local.hideNaip") }}
            </p>
            <p class="text-xs text-muted">
              {{ t("settings.local.hideNaipHint") }}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            :aria-checked="naipHidden"
            :aria-labelledby="naipLabelId"
            :class="[
              'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
              naipHidden ? 'bg-can' : 'bg-surface-sunken',
            ]"
            @click="setHideNaip(!naipHidden)"
          >
            <span
              :class="[
                'my-0.5 size-5 rounded-full bg-white shadow-card transition-transform',
                naipHidden ? 'translate-x-5' : 'translate-x-0.5',
              ]"
            ></span>
          </button>
        </div>

        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-sm font-medium text-ink">
              {{ t("settings.local.theme") }}
            </p>
            <p class="text-xs text-muted">
              {{ t("settings.local.themeHint") }}
            </p>
          </div>
          <ThemeLangControls :locale="locale" />
        </div>
      </div>
    </PanelSection>

    <PanelSection
      :title="t('settings.simbrief.title')"
      :description="t('settings.simbrief.hint')"
    >
      <div
        v-if="notice"
        :class="[
          'mb-4 flex items-start gap-2 rounded-control px-3 py-2 text-sm',
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

      <StateCard
        v-if="loading"
        kind="loading"
        :title="t('common.loading')"
        compact
      />
      <!-- **读失败不等于没绑定**：这一支必须排在「未绑定」前面，见 loadSimbrief()。 -->
      <StateCard
        v-else-if="loadFailed"
        kind="error"
        :title="t('settings.simbrief.loadFailed')"
        :body="loadFailure || undefined"
        :retry-label="t('common.retry')"
        compact
        @retry="loadSimbrief"
      />

      <div
        v-else-if="simbriefId"
        class="flex flex-wrap items-center gap-3 text-sm"
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

      <form
        v-else
        class="flex flex-col gap-2 @sm:flex-row"
        @submit.prevent="link"
      >
        <label :for="simbriefInputId" class="sr-only">{{
          t("settings.simbrief.placeholder")
        }}</label>
        <input
          :id="simbriefInputId"
          v-model="identifier"
          class="input @sm:max-w-xs"
          autocomplete="off"
          :placeholder="t('settings.simbrief.placeholder')"
        />
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="busy || !identifier.trim()"
        >
          {{ t("settings.simbrief.link") }}
        </button>
      </form>
    </PanelSection>

    <!-- 手机专用：轨上那几样的家。平板和桌面上它们在轨里，这里不重复。 -->
    <div class="phone-only space-y-8">
      <PanelSection :title="crossLinks.label ?? ''">
        <ul class="divide-y divide-subtle">
          <li v-for="link in crossLinks.items" :key="link.href">
            <a
              :href="link.href"
              class="flex items-center gap-3 py-3 text-sm text-ink"
              :target="link.external ? '_blank' : undefined"
              :rel="link.external ? 'noopener' : undefined"
            >
              <Icon :name="link.icon" class="size-5 text-muted" />
              <span class="flex-1">{{ link.name }}</span>
              <Icon
                v-if="link.external"
                name="arrowTopRight"
                class="size-4 text-faint"
              />
            </a>
          </li>
        </ul>
      </PanelSection>

      <button
        type="button"
        class="btn btn-secondary w-full"
        :disabled="signingOut"
        @click="handleSignOut"
      >
        <Icon name="arrowRightOnRectangle" class="size-4" />
        {{ t("account.signOut") }}
      </button>
    </div>
  </div>
</template>
