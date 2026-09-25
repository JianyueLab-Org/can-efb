/**
 * 图层层面的那几句话：这一层为什么没东西、这次会话是不是被拒过、哪一层没取到。
 *
 * 从 MapSurface.vue 搬来。每一层都往这里写，所以它单独一个文件，而不是挂在某一层
 * 身上。
 */
import { ref, type Ref } from "vue";

/** 会失败、会被重试的那几层。`live` 是机组和管制共用的那一次 datafeed 取数。 */
export type LayerId =
  | "airways"
  | "firs"
  | "navaids"
  | "mora"
  | "ctr"
  | "app"
  | "restricted"
  | "live";

export interface LayerNotice {
  notice: Ref<{ layer: string; text: string } | null>;
  failure: Ref<LayerId | null>;
  setNotice(layer: string, text: string): void;
  clearNotice(layer: string): void;
  noteDenied(): void;
  isDeniedThisSession(): boolean;
  noteFailure(layer: LayerId): void;
  clearFailure(layer: LayerId): void;
}

export function isDenied(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

export function useLayerNotice(deniedText: string): LayerNotice {
  /**
   * 一旦 can-db 拒绝过，这次会话里就不再尝试。
   *
   * 没有 `aipAccess` 的成员每一层都会 401。默认打开之后，如果不记住这件事，他们
   * 每进一个页面就会撞三次 401 并在控制台刷三行错 —— 那既吵，又会让真正的故障淹
   * 在噪音里。**记的是"被拒过"，不是"失败过"**：网络抖动应该重试，权限不足不该。
   */
  let deniedThisSession = false;

  /**
   * 图层层面的一句话：这一层为什么没东西。
   *
   * **这是本次改动要解决的那个故障。** 一个按需图层有三种没东西的情形，而以前只有
   * 一种会说话：
   *
   *   1. 请求失败      —— 会说（console.error + 退回关）
   *   2. 权限不够      —— **不说**，`deniedThisSession` 把它咽掉了
   *   3. 取回来是空的  —— **不说**，因为它根本不是错误：200 加一个空数组，
   *                       `toAirwayLines` 得到 0 个要素，一路顺畅地画出一张空图
   *
   * 第 3 种是今天线上高空航路的真实处境：航段的 `level` 一列全是默认值，can-db 的
   * 高空视图因此返回 0 条（见那个仓库的 TODO）。开关亮在「高空」上、图上一条线都没
   * 有、控制台一个字都没有 —— 于是它看起来像**地图坏了**，而不是像**这一层没有数
   * 据**。这两件事对使用者要做的判断完全不同。
   *
   * 带 `layer` 是为了让提示跟着来源走：B 层加载成功时不该把 A 层那句话抹掉，而 A
   * 层自己关掉时那句话必须跟着消失。
   */
  const notice = ref<{ layer: string; text: string } | null>(null);

  /**
   * 哪一层**没取到**。和 `notice` 分开：那一条说的是「这一层是空的 / 你没有权
   * 限」，这一条说的是「请求失败了，可以再试」。失败的那一层已经退回关，没有这一
   * 句的话它就是安静地消失了 —— 和「这一带没有数据」长得一模一样。
   *
   * 只记最近一次：两层同时失败时，重试最近那一层之后另一层还会再报。
   */
  const failure = ref<LayerId | null>(null);

  function setNotice(layer: string, text: string) {
    // 权限那条是**会话级**的，压过一切按层的提示：它一旦成立，其余每一层都会因为
    // 同一个原因空着，而把「这一层没有数据」摆在最前面会让人以为换一层就好了。
    if (notice.value?.layer === "denied") return;
    notice.value = { layer, text };
  }

  function clearNotice(layer: string) {
    if (notice.value?.layer === layer) notice.value = null;
  }

  function noteDenied() {
    deniedThisSession = true;
    notice.value = { layer: "denied", text: deniedText };
    // 被拒不是失败：那一句由权限提示来说，再挂一个「重试」只会让人去点一个永远
    // 不会成功的按钮。
    failure.value = null;
  }

  function noteFailure(layer: LayerId) {
    if (deniedThisSession) return;
    failure.value = layer;
  }

  function clearFailure(layer: LayerId) {
    if (failure.value === layer) failure.value = null;
  }

  return {
    notice,
    failure,
    setNotice,
    clearNotice,
    noteDenied,
    isDeniedThisSession: () => deniedThisSession,
    noteFailure,
    clearFailure,
  };
}
