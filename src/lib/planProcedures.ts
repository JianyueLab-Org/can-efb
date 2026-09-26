/**
 * 把本机选定的跑道和程序套到一条已展开的航路上。
 *
 * `aip/resolve` 只认航路串里写着的 SID/STAR 名字，变体按航路接入点挑，不知道跑道，
 * 也没有进近。选了哪一项，就用选的那项替换 resolve 的那一段；没选的保持 resolve 的
 * 结果。机场数据取不到时原样返回（仍然画弯）。
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
  if (resolved.length < 2 || isEmptySelection(selection)) {
    return smoothProcedureTurns(
      withTerminalHolds(resolved, holdings, selection, dep, arr),
    );
  }
  const first = resolved[0];
  const last = resolved[resolved.length - 1];
  const departure = first.kind === "airport" ? first : null;
  const arrival = last.kind === "airport" ? last : null;
  const middle = resolved.slice(departure ? 1 : 0, arrival ? -1 : undefined);

  const sid = pick(dep, "sid", selection.depRunway, selection.sid);
  const star = pick(arr, "star", selection.arrRunway, selection.star);
  const approach = pick(
    arr,
    "approach",
    selection.arrRunway,
    selection.approach,
  );

  const enroute = middle.filter(
    (p) => !(sid && p.kind === "sid") && !(star && p.kind === "star"),
  );

  const composed = composeRoutePoints({
    departure,
    departureRunway: findRunway(dep?.runways, selection.depRunway),
    sid,
    sidRunway: selection.depRunway,
    sidTransition: selection.sidTransition,
    enroute,
    star,
    starRunway: selection.arrRunway,
    starTransition: selection.starTransition,
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
