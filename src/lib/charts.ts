/**
 * 航图：can-db 的航图索引 → 机场详情「航图」标签要的形状。纯逻辑，不碰 DOM、
 * 不发请求，所以能测。
 *
 * 数据是 NAIP 终端区航图（`dataset.min_access >= 3`）。类别在 can-db 的导入脚本
 * 里由 `ChartTypeEx_CH` 映射出来，这里只认那五个值。
 */
import { fromDbResponse, type RequestState } from "@/lib/requestState";

/** 显示顺序。 */
export const CHART_CATEGORIES = ["STAR", "APP", "TAXI", "SID", "REF"] as const;
export type ChartCategory = (typeof CHART_CATEGORIES)[number];

export interface ChartEntry {
  id: number;
  category: ChartCategory;
  name: string;
  /** NAIP 的 PAGE_NUMBER，如 `0C-01`。 */
  page: string | null;
  /** `ChartTypeEx_CH` 原文。 */
  kind: string;
  isSup: boolean;
  bytes: number;
}

export interface ChartIndex {
  icao: string;
  airac: string;
  charts: ChartEntry[];
}

function isCategory(value: unknown): value is ChartCategory {
  return (
    typeof value === "string" &&
    (CHART_CATEGORIES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEntry(raw: unknown): ChartEntry | null {
  if (!isRecord(raw)) return null;
  const { id, category, name } = raw;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  if (!isCategory(category) || typeof name !== "string") return null;
  return {
    id,
    category,
    name,
    page: typeof raw.page === "string" && raw.page !== "" ? raw.page : null,
    kind: typeof raw.kind === "string" ? raw.kind : "",
    isSup: raw.isSup === true,
    bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
  };
}

/**
 * 拆信封（`{status, licence, data}`，裸的也收）。
 *
 * `charts: null` 是 Go 的空切片，当成没有航图。**没有 `charts` 字段是读不懂**，
 * 回 null —— 调用方据此画成错误，而不是「这个机场没有航图」。
 */
export function parseChartIndex(body: unknown): ChartIndex | null {
  if (!isRecord(body)) return null;
  const inner = isRecord(body.data) ? body.data : body;
  const list = inner.charts === null ? [] : inner.charts;
  if (!Array.isArray(list)) return null;
  return {
    icao: typeof inner.icao === "string" ? inner.icao : "",
    airac: inner.airac == null ? "" : String(inner.airac),
    charts: list.map(toEntry).filter((c): c is ChartEntry => c !== null),
  };
}

/** `RequestState` 加一种：can-db 没配置航图存储（503）。 */
export type ChartsState = RequestState<ChartIndex> | { kind: "unconfigured" };

/** 错误响应体里的 `error` 码（can-db 的 `{error, message}`）。读不出来是 null。 */
export function errorCodeOf(body: unknown): string | null {
  return isRecord(body) && typeof body.error === "string" ? body.error : null;
}

/** can-db 没配航图存储时文件路由回 503 + 这个码。别的 503 不是这个意思。 */
export const CHARTS_UNAVAILABLE = "charts_unavailable";

export function chartsState(
  ok: boolean,
  status: number,
  index: ChartIndex | null,
  errorCode: string | null = null,
): ChartsState {
  // 503 要看响应体：只有 charts_unavailable 是「存储没配置」；can-db 解析不了
  // 会话时的 upstream_unavailable 也是 503，那是错误，要能重试。
  if (!ok && status === 503 && errorCode === CHARTS_UNAVAILABLE) {
    return { kind: "unconfigured" };
  }
  // 200 但读不懂：交给 fromDbResponse 会落成 empty，那是「失败画成没有」。
  if (ok && index === null) return { kind: "error", status };
  return fromDbResponse(ok, status, index, (i) => i.charts.length === 0);
}

export interface ChartChip {
  category: ChartCategory;
  count: number;
  disabled: boolean;
}

export function chartChips(charts: readonly ChartEntry[]): ChartChip[] {
  return CHART_CATEGORIES.map((category) => {
    const count = charts.filter((c) => c.category === category).length;
    return { category, count, disabled: count === 0 };
  });
}

export function defaultChip(chips: readonly ChartChip[]): ChartCategory | null {
  return chips.find((c) => !c.disabled)?.category ?? null;
}

/**
 * 有搜索词时跨全部类别搜名称和页码（不分大小写），结果按类别的显示顺序排、类别
 * 内保持服务端顺序（`sort` 是稳定的）。没有搜索词时只列选中的类别。
 */
export function filterCharts(
  charts: readonly ChartEntry[],
  category: ChartCategory | null,
  query: string,
): ChartEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return category ? charts.filter((c) => c.category === category) : [];
  }
  return charts
    .filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.page ?? "").toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        CHART_CATEGORIES.indexOf(a.category) -
        CHART_CATEGORIES.indexOf(b.category),
    );
}

/** `dbFetch` 用的路径（`/api/db/` 之后那一段）。 */
export function chartIndexPath(icao: string): string {
  return `aip/airports/${icao.trim().toUpperCase()}/charts`;
}

export function chartFilePath(id: number): string {
  return `aip/charts/${id}/file`;
}

/** 受限可调用档。和 Settings.vue 里「不使用受限汇编」的显示门槛同值。 */
export const AIP_RESTRICTED_CALL = 3;

/**
 * 列表为空时说哪一句。「不使用受限汇编」开着时 `dbFetch` 带 `unrestricted=1`，
 * can-db 把级别压到 2，而航图全是 NAIP —— 3 级起的成员看到的空是被开关藏起来的，
 * 不是真的没有。3 级以下那个开关是空转，空就是没有。
 */
export function chartsEmptyReason(
  hideNaip: boolean,
  aipAccess: number,
): "hidden" | "none" {
  return hideNaip && aipAccess >= AIP_RESTRICTED_CALL ? "hidden" : "none";
}
