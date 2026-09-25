/**
 * 「不使用受限汇编」—— 全站一个开关，一处拼参数。
 *
 * 3 级（受限可调用）起比 1–2 级多出来的恰好是 CAAC 的 NAIP 汇编。持有它的人有两个
 * 理由想把它排掉：那是低级别成员实际拿到的答案；受限汇编推出来的东西不能转手给看
 * 不到那一份的人。
 *
 * can-db 的每一条读接口都认 `?unrestricted=1`：3 级起把级别压到 2（`min(自己的,
 * 2)`，cap 不是赋值），3 级以下是空转。所以这个值只可能让人少看到，不会多看到 ——
 * 判错了、或者有人自己拼一个带参数的请求，都不越权。
 *
 * **浏览器打 `/api/db/*` 的每一处都走 `dbFetch`**，参数只在这里加。散在各个调用点
 * 上，迟早有一层忘了带，而那一层会安静地画出另一个级别的数据。反代原样转发查询串
 * （`pages/api/db/[...path].ts`），带不带参数是两个不同的 URL，浏览器的十分钟缓存
 * 因此不会把两种答案混在一起。
 *
 * **默认开**（和 can-portal 一致）：没存过值就隐藏，只有明确存了 `"0"` 才显示
 * NAIP。存在 localStorage，和侧栏折叠同一类：这台设备上的偏好，不值得占 can-api 一张
 * 表。读写都包在 try 里 —— 锁死的浏览器里 localStorage 会抛，那时退回默认（隐藏），
 * 本次会话内开关照样生效。
 *
 * 值变了之后，**拿着按旧值取来的数据的一方自己负责重取**：库里按模块缓存的那几份
 * （机场索引、跑道、地面）用 `aipScope()` 当键，地图 `watch(hideNaip)` 把它自己的
 * 缓存全部作废。
 */
import { readonly, ref } from "vue";

const STORAGE_KEY = "efb.hideNaip";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

const state = ref(typeof window === "undefined" ? true : readStored());

if (typeof window !== "undefined") {
  // 另一个标签页改了它：这里跟着变，地图照样重取。
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) state.value = readStored();
  });
}

/** 当前是否隐藏 NAIP。只读；改用 `setHideNaip`。 */
export const hideNaip = readonly(state);

export function setHideNaip(on: boolean): void {
  state.value = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // 见文件头：存不下也不中断，本次会话内照样生效。
  }
}

/** 缓存键的一段。按旧值取来的数据不能被新值命中。 */
export function aipScope(): "public" | "full" {
  return state.value ? "public" : "full";
}

/**
 * `path` 是 `/api/db/` 之后那一段，可以带查询串（`aip/airways?level=high`）。
 *
 * 不隐藏就不带参数，而不是带 `unrestricted=0` —— 两者等价，少一个参数少一份歧义。
 */
export function dbUrl(path: string): string {
  if (!state.value) return `/api/db/${path}`;
  return `/api/db/${path}${path.includes("?") ? "&" : "?"}unrestricted=1`;
}

export function dbFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(dbUrl(path), init);
}
