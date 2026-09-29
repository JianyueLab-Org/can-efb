import type { Airspace } from "@/lib/aip";

/**
 * 航图选哪一张：IFR 高空图还是 IFR 低空图。
 *
 * 航路按 can-db 的 `?level=` 取这一层（`high` 给 high + both，`low` 给 low + both），
 * 航路点跟着航段走；禁区、限制区、危险区按垂直范围和分界高度比（`airspaceOnChart`）。
 */
export type IfrChart = "high" | "low";

export function isIfrChart(v: unknown): v is IfrChart {
  return v === "high" || v === "low";
}

/**
 * 高低空分界，米。出处：CCAR-93（《民用航空空中交通管理规则》）划分管制空域 ——
 * 高空管制区是 6000 m（不含）以上，中低空管制区是 6000 m（含）以下。约合 FL197。
 * 航路的高低空不按高度分（can-db 的 `level` 来自 Navigraph 的航路类别 J / V），所
 * 以这是全站唯一的分界数。
 */
export const IFR_SPLIT_M = 6000;

const M_PER_FT = 0.3048;

/**
 * 读一个垂直限制，给米。
 *
 * can-db 已经换成米（整数）：下限 0 是地面，上限 0 或 null 是没有公布上限（见
 * can-db `internal/aip/airspace.go`）。字符串是防御：`GND` / `SFC` / `MSL` 是 0，
 * `UNL` / `UNLTD` / `UNLIM` 是不封顶，`FL197` 按飞行高度层，`S0840` 按公制高度层
 * （十米），带 `FT` / `F` 的按英尺，带 `M` 的和不带单位的按米。`AGL` / `AMSL` 这类
 * 基准后缀不影响数值，去掉。
 *
 * 返回 `Infinity` 表示不封顶，`null` 表示读不出来。
 */
export function parseLimitM(
  v: number | string | null | undefined,
  edge: "lower" | "upper",
): number | null {
  if (v == null) return edge === "upper" ? Infinity : null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return v === Infinity ? Infinity : null;
    if (edge === "upper" && v === 0) return Infinity;
    return v;
  }
  const raw = v.trim().toUpperCase().replace(/\s+/g, "");
  if (raw === "GND" || raw === "SFC" || raw === "MSL") return 0;
  if (/^UNL(TD|IM|IMITED)?$/.test(raw)) return Infinity;
  const t = raw.replace(/(AGL|AMSL|MSL)$/, "");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^FL(\d+)$/))) return Number(m[1]) * 100 * M_PER_FT;
  if ((m = t.match(/^S(\d{4})$/))) return Number(m[1]) * 10;
  if ((m = t.match(/^(\d+(?:\.\d+)?)(FT|F)$/))) return Number(m[1]) * M_PER_FT;
  if ((m = t.match(/^(\d+(?:\.\d+)?)M?$/))) {
    const n = Number(m[1]);
    // 和数字同一条：上限 0 是没有公布上限。
    return edge === "upper" && n === 0 ? Infinity : n;
  }
  return null;
}

/**
 * 一块空域在这张航图上画不画。
 *
 * - 高空图：上限高于分界（`upper > IFR_SPLIT_M`）。
 * - 低空图：下限低于分界（`lower < IFR_SPLIT_M`）。
 *
 * 读不出来的那一端不藏它：下限读不出按从地面起，上限读不出按不封顶。
 */
export function airspaceOnChart(
  a: Pick<Airspace, "lowerM" | "upperM">,
  chart: IfrChart,
  split = IFR_SPLIT_M,
): boolean {
  if (chart === "high") {
    const upper = parseLimitM(a.upperM, "upper");
    return upper == null || upper > split;
  }
  const lower = parseLimitM(a.lowerM, "lower");
  return lower == null || lower < split;
}

/** 只留这张航图上的那些。 */
export function airspacesOnChart<T extends Pick<Airspace, "lowerM" | "upperM">>(
  list: T[],
  chart: IfrChart,
): T[] {
  return list.filter((a) => airspaceOnChart(a, chart));
}
