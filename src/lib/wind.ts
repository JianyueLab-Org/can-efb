/**
 * METAR 的风组，以及它在一条跑道上的顶风 / 侧风分量。
 *
 * 只解风组（`dddffGggKT` / `VRB` / `MPS`），不是 METAR 解码器。其余部分仍按原文显示。
 *
 * 风向是**真北**。跑道方向用两端坐标算出的真方位，不用 can-db 的磁航向 `hdg`，
 * 两者差一个磁差。
 */

export interface MetarWind {
  /** 真北方向，度。`VRB` 时为 null。 */
  direction: number | null;
  /** 节。 */
  speedKt: number;
  gustKt: number | null;
}

const MPS_TO_KT = 1.943844;

/** 一份 METAR 原文里的风组。没有风组、或写成 `/////` 时为 null。 */
export function parseMetarWind(
  raw: string | null | undefined,
): MetarWind | null {
  if (!raw) return null;
  for (const token of raw.trim().toUpperCase().split(/\s+/)) {
    const m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(token);
    if (!m) continue;
    const factor = m[4] === "MPS" ? MPS_TO_KT : 1;
    const direction = m[1] === "VRB" ? null : Number(m[1]);
    if (direction !== null && direction > 360) return null;
    return {
      direction: direction === 360 ? 0 : direction,
      speedKt: Math.round(Number(m[2]) * factor),
      gustKt: m[3] ? Math.round(Number(m[3]) * factor) : null,
    };
  }
  return null;
}

export interface WindComponents {
  /** 正为顶风，负为顺风。节，四舍五入。 */
  headKt: number;
  /** 侧风大小，节。 */
  crossKt: number;
  /** 侧风从哪一侧来。无侧风时为 null。 */
  crossFrom: "left" | "right" | null;
}

/**
 * 风在一个跑道方向上的分量。
 *
 * `VRB` 没有方向，分量无从算起，返回 null —— 不当作零风。
 * 静风（0 kt）返回全零。
 */
export function windComponents(
  wind: MetarWind | null,
  runwayTrueBearing: number,
): WindComponents | null {
  if (!wind || !Number.isFinite(runwayTrueBearing)) return null;
  if (wind.speedKt === 0) return { headKt: 0, crossKt: 0, crossFrom: null };
  if (wind.direction === null) return null;
  const angle = ((wind.direction - runwayTrueBearing) * Math.PI) / 180;
  const head = Math.round(wind.speedKt * Math.cos(angle));
  const cross = wind.speedKt * Math.sin(angle);
  const crossKt = Math.round(Math.abs(cross));
  return {
    // `-0` 显示成 "-0"，收成 0。
    headKt: head === 0 ? 0 : head,
    crossKt,
    crossFrom: crossKt === 0 ? null : cross > 0 ? "right" : "left",
  };
}
