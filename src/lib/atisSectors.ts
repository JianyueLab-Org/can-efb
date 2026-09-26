/**
 * ATC info 里的 Covering / Extending 行。
 *
 * **Covering** 是扇区短名：RJJJ 写在 ATIS3，`Covering sector - T30`。用来点亮
 * VATSpy 里的 `RJTG-T30` 这类多边形。
 *
 * **Extending** 是同席位扩出去。除 FSS 外所有席位同一条规矩：`ZSPD_TWR` 写
 * `Extending - ZSSS` 就同时点亮虹桥塔台，`ZSHA_CTR` 写 `Extending - ZGGG` 就
 * 同时点亮广州区调。后缀跟登录席位走，塔台不会变成进近。FSS 管的是一串 FIR，
 * 扩场没有「同一个席位」可复制，所以不认。
 *
 * `Covering area - …` 是地面席的说明，Covering 那条正则认不到它。
 */

export interface AtisSectors {
  covering: string[];
  extending: string[];
}

const COVERING = /^\s*covering\s+sectors?\s*[-–—:]\s*(.*)$/i;
const EXTENDING = /^\s*extending(?:\s+sectors?)?\s*[-–—:]\s*(.*)$/i;

/** 频率、孤立的 EXT，不是扇区短名也不是机场。 */
function isNoiseToken(token: string): boolean {
  if (token === "EXT") return true;
  return /^\d{2,3}(\.\d{1,3})?$/.test(token);
}

function splitNames(rest: string): string[] {
  const names: string[] = [];
  for (const part of rest.split(/[,;/]+|\s+/)) {
    const token = part.trim().toUpperCase();
    if (!token || isNoiseToken(token)) continue;
    if (!names.includes(token)) names.push(token);
  }
  return names;
}

function merge(into: string[], names: string[]) {
  for (const name of names) {
    if (!into.includes(name)) into.push(name);
  }
}

/**
 * 从 `text_atis` 抽出 Covering 扇区短名和 Extending 机场。
 *
 * 扫每一行，不假设它一定在 index 1：ATIS1 有时会进 feed，把目标行挤到后面。
 */
export function parseAtisSectors(
  lines: string[] | null | undefined,
): AtisSectors {
  const covering: string[] = [];
  const extending: string[] = [];

  for (const raw of lines ?? []) {
    const coveringMatch = COVERING.exec(raw);
    if (coveringMatch) {
      merge(covering, splitNames(coveringMatch[1] ?? ""));
      continue;
    }
    const extendingMatch = EXTENDING.exec(raw);
    if (extendingMatch) merge(extending, splitNames(extendingMatch[1] ?? ""));
  }

  return { covering, extending };
}

/**
 * 呼号最后一段，也就是席位类型：`ZSPD_TWR` → `TWR`，`ZSPD_N_TWR` 同样是 `TWR`。
 *
 * Extending 只复制这一段，所以塔台扩出去还是塔台。
 */
export function facilitySuffix(callsign: string): string {
  const parts = callsign
    .toUpperCase()
    .trim()
    .replace(/_+/g, "_")
    .split("_")
    .filter(Boolean);
  return parts.length >= 2 ? (parts[parts.length - 1] ?? "") : "";
}

/**
 * 把 Extending 名单里的一个机场收成「同席位」呼号。
 *
 * `ZSPD_TWR` + `ZSSS` → `ZSSS_TWR`。名单写成 `ZSSS_APP` 也只用第一段，后缀仍
 * 跟登录席位走。
 */
export function extendedCallsign(callsign: string, target: string): string {
  const field = target.toUpperCase().trim().split("_")[0] ?? "";
  const suffix = facilitySuffix(callsign);
  if (!field) return "";
  return suffix ? `${field}_${suffix}` : field;
}

/**
 * FSS 不参与 Extending。facility 1 是数据源里的 FSS，呼号以 `_FSS` 结尾是防止
 * 标错 facility 的席位被扩出去。
 */
export function allowsExtending(controller: {
  facility: number;
  callsign: string;
}): boolean {
  if (controller.facility === 1) return false;
  return facilitySuffix(controller.callsign) !== "FSS";
}
