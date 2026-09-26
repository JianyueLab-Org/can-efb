/**
 * 把本机选定的跑道和程序套到一条已展开的航路上。
 *
 * `aip/resolve` 只认航路串里写着的 SID/STAR 名字，变体按航路接入点挑，不知道跑道，
 * 也没有进近。选了哪一项，就用选的那项替换 resolve 的那一段；没选的 SID/STAR 换成航
 * 路串里写着的那一条实际飞的几段（见 `resolvedProcedure`）。机场数据取不到时原样返回
 * （仍然画弯）。
 */
import type { MapPoint } from "@/lib/mapBus";
import { smoothProcedureTurns } from "@/lib/procedureGeometry";
import {
  attachTerminalHolds,
  estimateVariation,
  loadHoldings,
  type Holding,
} from "@/lib/holds";
import {
  composeRoutePoints,
  findRunway,
  loadAirportProcedures,
  pickProcedures,
  procedureLabel,
  type AirportProcedures,
  type Procedure,
  type ProcedureKind,
} from "@/lib/procedures";
import {
  isEmptySelection,
  type ProcedureSelection,
} from "@/lib/procedureSelection";

function pick(
  data: AirportProcedures | null,
  kind: ProcedureKind,
  runway: string,
  label: string,
): Procedure | null {
  if (!data || !label) return null;
  return (
    pickProcedures(data.procedures, kind, runway).find(
      (p) => procedureLabel(p) === label,
    ) ?? null
  );
}

/**
 * 航路串里写着、`aip/resolve` 已经展开了的那条程序，从机场数据里找回来。
 *
 * **resolve 展开的是整串腿**，所有跑道转换首尾相接：ZBAA `OMDE9Z` 画出来是 RW01、
 * RW36L、RW36R 三条转换来回穿插，再出到 OMDEK。那正是 `procedureTrack` 要避免的一团，
 * 而没在本机选过程序的成员（地图上已提交计划的默认样子）看到的就是它。找回程序本身，
 * 交给 `composeRoutePoints` 按跑道和接入点只取实际飞的那几段。
 *
 * 找不到（机场数据没取到、名字对不上）时给 null，resolve 那一段原样留着。
 */
function resolvedProcedure(
  data: AirportProcedures | null,
  kind: ProcedureKind,
  runway: string,
  points: MapPoint[],
): Procedure | null {
  const name = points.find((p) => p.kind === kind)?.via;
  if (!data || !name) return null;
  return (
    pickProcedures(data.procedures, kind, runway).find(
      (p) => p.name === name,
    ) ??
    data.procedures.find((p) => p.kind === kind && p.name === name) ??
    null
  );
}

/** 机场磁差：can-db 给的，或由跑道估计。没有机场数据时为 null。 */
export function variationOf(data: AirportProcedures | null): number | null {
  return data ? estimateVariation(data.variation, data.runways) : null;
}

/**
 * 把两端机场的终端等待挂到航线上。机场数据没取到的那一端不挂：没有磁差就画不对方向。
 */
export function withTerminalHolds(
  points: MapPoint[],
  holdings: Holding[],
  selection: ProcedureSelection,
  dep: AirportProcedures | null,
  arr: AirportProcedures | null,
): MapPoint[] {
  const airports = [
    [dep, selection.depRunway],
    [arr, selection.arrRunway],
  ]
    .filter((row): row is [AirportProcedures, string] => Boolean(row[0]))
    .map(([data, runway]) => ({
      icao: data.icao,
      runway,
      variationWest: variationOf(data) ?? 0,
    }));
  return airports.length
    ? attachTerminalHolds(points, holdings, airports)
    : points;
}

/** 纯函数部分：机场数据和等待列表已经在手。 */
export function applySelectionTo(
  resolved: MapPoint[],
  selection: ProcedureSelection,
  dep: AirportProcedures | null,
  arr: AirportProcedures | null,
  holdings: Holding[] = [],
): MapPoint[] {
  const unchanged = () =>
    smoothProcedureTurns(
      withTerminalHolds(resolved, holdings, selection, dep, arr),
    );
  if (resolved.length < 2) return unchanged();
  const first = resolved[0];
  const last = resolved[resolved.length - 1];
  const departure = first.kind === "airport" ? first : null;
  const arrival = last.kind === "airport" ? last : null;
  const middle = resolved.slice(departure ? 1 : 0, arrival ? -1 : undefined);

  // 选了的用选的；没选的用航路串里写着的那条，但只取实际飞的那几段。
  const pickedSid = pick(dep, "sid", selection.depRunway, selection.sid);
  const pickedStar = pick(arr, "star", selection.arrRunway, selection.star);
  const sid =
    pickedSid ?? resolvedProcedure(dep, "sid", selection.depRunway, middle);
  const star =
    pickedStar ?? resolvedProcedure(arr, "star", selection.arrRunway, middle);
  const approach = pick(
    arr,
    "approach",
    selection.arrRunway,
    selection.approach,
  );
  if (isEmptySelection(selection) && !sid && !star) return unchanged();

  const enroute = middle.filter(
    (p) => !(sid && p.kind === "sid") && !(star && p.kind === "star"),
  );

  const composed = composeRoutePoints({
    departure,
    departureRunway: findRunway(dep?.runways, selection.depRunway),
    sid,
    sidRunway: selection.depRunway,
    // 转换是跟着选的那条程序存的；换成航路串里那条时不带过去。
    sidTransition: pickedSid ? selection.sidTransition : "",
    enroute,
    star,
    starRunway: selection.arrRunway,
    starTransition: pickedStar ? selection.starTransition : "",
    approach,
    approachTransition: selection.approachTransition,
    departureVariation: variationOf(dep) ?? 0,
    arrivalVariation: variationOf(arr) ?? 0,
    arrivalRunway: findRunway(arr?.runways, selection.arrRunway),
    arrival,
  });
  return smoothProcedureTurns(
    withTerminalHolds(composed, holdings, selection, dep, arr),
  );
}

export async function applySelection(
  resolved: MapPoint[],
  departure: string,
  arrival: string,
  selection: ProcedureSelection,
): Promise<MapPoint[]> {
  // 机场详情两端都取：终端等待要磁差，不只是选了程序时才用得上。都有缓存。
  const [dep, arr, holdings] = await Promise.all([
    loadAirportProcedures(departure).catch(() => null),
    loadAirportProcedures(arrival).catch(() => null),
    loadHoldings(),
  ]);
  return applySelectionTo(resolved, selection, dep, arr, holdings);
}
