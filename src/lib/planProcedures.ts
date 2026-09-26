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

/** 纯函数部分：机场数据已经在手。 */
export function applySelectionTo(
  resolved: MapPoint[],
  selection: ProcedureSelection,
  dep: AirportProcedures | null,
  arr: AirportProcedures | null,
): MapPoint[] {
  if (resolved.length < 2 || isEmptySelection(selection)) {
    return smoothProcedureTurns(resolved);
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

  return smoothProcedureTurns(
    composeRoutePoints({
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
      arrivalRunway: findRunway(arr?.runways, selection.arrRunway),
      arrival,
    }),
  );
}

export async function applySelection(
  resolved: MapPoint[],
  departure: string,
  arrival: string,
  selection: ProcedureSelection,
): Promise<MapPoint[]> {
  if (isEmptySelection(selection)) return smoothProcedureTurns(resolved);
  const wantDep = Boolean(selection.depRunway || selection.sid);
  const wantArr = Boolean(
    selection.arrRunway || selection.star || selection.approach,
  );
  const [dep, arr] = await Promise.all([
    wantDep ? loadAirportProcedures(departure).catch(() => null) : null,
    wantArr ? loadAirportProcedures(arrival).catch(() => null) : null,
  ]);
  return applySelectionTo(resolved, selection, dep, arr);
}
