/**
 * 选中的跑道与程序，按起降机场对存在本机。
 *
 * can-api 的飞行计划里没有跑道和进近这几项，本站又没有自己的存储，所以放
 * localStorage。它是本机的偏好，不是计划的一部分：换一台设备就没有了，地图退回只
 * 画航路串里写着的 SID/STAR。
 *
 * 程序名用 `procedureLabel`（带变体，`R22-Y`）。空串表示没选。
 */

export interface ProcedureSelection {
  depRunway: string;
  sid: string;
  sidTransition: string;
  arrRunway: string;
  star: string;
  starTransition: string;
  approach: string;
  approachTransition: string;
}

export const EMPTY_SELECTION: ProcedureSelection = {
  depRunway: "",
  sid: "",
  sidTransition: "",
  arrRunway: "",
  star: "",
  starTransition: "",
  approach: "",
  approachTransition: "",
};

/** 选择变了。不带内容，收到的一方自己读。 */
export const PROCEDURES_CHANGED_EVENT = "efb:procedures-changed";

const PREFIX = "efb:procedures:";

export function selectionKey(departure: string, arrival: string): string {
  return `${PREFIX}${departure.trim().toUpperCase()}-${arrival.trim().toUpperCase()}`;
}

/** 规整成完整的一份。字段缺了或类型不对都当没选。 */
export function normalizeSelection(value: unknown): ProcedureSelection {
  const out = { ...EMPTY_SELECTION };
  if (!value || typeof value !== "object") return out;
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof ProcedureSelection)[]) {
    const field = v[key];
    if (typeof field === "string") out[key] = field.trim().toUpperCase();
  }
  return out;
}

export function isEmptySelection(s: ProcedureSelection): boolean {
  return Object.values(s).every((v) => !v);
}

export function readSelection(
  departure: string,
  arrival: string,
): ProcedureSelection {
  try {
    const raw = localStorage.getItem(selectionKey(departure, arrival));
    return normalizeSelection(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...EMPTY_SELECTION };
  }
}

export function writeSelection(
  departure: string,
  arrival: string,
  selection: ProcedureSelection,
): void {
  const key = selectionKey(departure, arrival);
  try {
    const current = localStorage.getItem(key);
    const next = isEmptySelection(selection)
      ? null
      : JSON.stringify(normalizeSelection(selection));
    if (current === next) return;
    if (next === null) localStorage.removeItem(key);
    else localStorage.setItem(key, next);
  } catch {
    // 存不下（隐私模式、被禁用）时这一次仍然生效，只是不留到下次。
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PROCEDURES_CHANGED_EVENT));
  }
}
