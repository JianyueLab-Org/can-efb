/**
 * 程序段的转弯：把折线的角画成圆弧。
 *
 * can-db 的腿里没有 RF 弧心、半径、θ/ρ，只有 `turn`（L/R）和 `flyover`。所以这里的弧
 * 是按固定转弯半径**合成**的示意，不是汇编公布的航迹：
 *
 * - 旁切点（默认）：在点前开始转，弧与前后两段相切，线不经过这个点（`offPath`）。
 * - 飞越点，或规定的转弯方向与最短方向相反：过点之后按规定方向转，再直飞下一个点。
 *   后者就是离场程序里绕台一圈再出去的那种画法。
 *
 * 只处理程序点（SID/STAR/进近）。航路段的角保持原样。
 */
import type { MapPoint } from "@/lib/mapBus";

/** 默认转弯半径，海里。约等于 210 kt、坡度 25°。 */
export const TURN_RADIUS_NM = 1.4;
/** 弧上每隔多少度取一个点。 */
const STEP_RAD = (8 * Math.PI) / 180;
/** 小于这个角度的转弯不画弧。 */
const MIN_TURN_RAD = (3 * Math.PI) / 180;

type Vec = [number, number];

const isProcedure = (p: MapPoint) =>
  p.kind === "sid" ||
  p.kind === "star" ||
  p.kind === "approach" ||
  p.kind === "missed";

/** 以 `origin` 为原点的局部平面，单位海里，x 向东、y 向北。 */
function project(origin: MapPoint, p: { lat: number; lon: number }): Vec {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return [(p.lon - origin.lon) * 60 * k, (p.lat - origin.lat) * 60];
}

function unproject(origin: MapPoint, v: Vec): { lat: number; lon: number } {
  const k = Math.cos((origin.lat * Math.PI) / 180) || 1e-9;
  return { lat: origin.lat + v[1] / 60, lon: origin.lon + v[0] / 60 / k };
}

const len = (v: Vec) => Math.hypot(v[0], v[1]);
const scale = (v: Vec, s: number): Vec => [v[0] * s, v[1] * s];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const unit = (v: Vec): Vec => scale(v, 1 / len(v));
/** 左法向（逆时针转 90°）。 */
const leftNormal = (v: Vec): Vec => [-v[1], v[0]];

/** 从 `a` 到 `b` 的有向角，逆时针（左转）为正，范围 (-π, π]。 */
function signedAngle(a: Vec, b: Vec): number {
  return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
}

/** 从 `from` 起按 `sweep`（带符号）转过的角度上取点，不含起点，含终点。 */
function arcPoints(
  center: Vec,
  radius: number,
  from: number,
  sweep: number,
): Vec[] {
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / STEP_RAD));
  const out: Vec[] = [];
  for (let i = 1; i <= steps; i++) {
    const a = from + (sweep * i) / steps;
    out.push([
      center[0] + radius * Math.cos(a),
      center[1] + radius * Math.sin(a),
    ]);
  }
  return out;
}

function shapePoint(origin: MapPoint, v: Vec, like: MapPoint): MapPoint {
  return {
    ...unproject(origin, v),
    ident: "",
    kind: like.kind,
    via: like.via,
    shape: true,
  };
}

/**
 * 在程序点上插入转弯弧。输入是按飞行顺序接好的一条线（`composeRoutePoints` 的输出）。
 */
export function smoothProcedureTurns(
  points: MapPoint[],
  radiusNm = TURN_RADIUS_NM,
): MapPoint[] {
  if (points.length < 3) return [...points];
  const out: MapPoint[] = [points[0]];

  for (let i = 1; i < points.length - 1; i++) {
    const b = points[i];
    // 只留标注的点（offPath）不在线上：前后都越过它们。
    const c = points.slice(i + 1).find((p) => !p.offPath);
    if (!c || b.offPath || !isProcedure(b) || b.shape) {
      out.push(b);
      continue;
    }
    // 入向取**上一个已经画出的点**：前一个点若是飞越转弯，线是从它的切点来的。
    const a = out.findLast((p) => !p.offPath);
    if (!a) {
      out.push(b);
      continue;
    }
    const va = project(b, a);
    const vc = project(b, c);
    const lenAB = len(va);
    const lenBC = len(vc);
    if (lenAB < 1e-6 || lenBC < 1e-6) {
      out.push(b);
      continue;
    }
    const u1 = unit(scale(va, -1));
    const u2 = unit(vc);
    const delta = signedAngle(u1, u2);
    const shortest = delta >= 0 ? 1 : -1;
    const dir = b.turn === "L" ? 1 : b.turn === "R" ? -1 : shortest;
    const reversed =
      b.turn !== undefined &&
      dir !== shortest &&
      Math.abs(delta) > MIN_TURN_RAD;

    if (b.flyover || reversed) {
      out.push(b, ...flyoverTurn(b, c, u1, vc, dir, radiusNm));
      continue;
    }
    if (Math.abs(delta) < MIN_TURN_RAD) {
      out.push(b);
      continue;
    }

    // 旁切：切点离角点 d = r·tan(Δ/2)，不超过前后两段各一半。
    const half = Math.abs(delta) / 2;
    let r = radiusNm;
    let d = r * Math.tan(half);
    const maxD = 0.5 * Math.min(lenAB, lenBC);
    if (d > maxD) {
      d = maxD;
      r = d / Math.tan(half);
    }
    const start = scale(u1, -d);
    const center = add(start, scale(leftNormal(u1), dir * r));
    const from = Math.atan2(start[1] - center[1], start[0] - center[0]);
    const arc = arcPoints(center, r, from, dir * Math.abs(delta));
    // 弧的前一半属于到 b 的那条腿，后一半属于去 c 的那条；角点本身只留给标注。
    const mid = Math.ceil(arc.length / 2);
    out.push(shapePoint(b, start, b));
    for (const v of arc.slice(0, mid)) out.push(shapePoint(b, v, b));
    out.push({ ...b, offPath: true });
    for (const v of arc.slice(mid)) out.push(shapePoint(b, v, c));
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * 过点之后按 `dir` 转，直到机头对准下一个点。返回弧上的点（不含起点 b）。
 *
 * 圆心在入向的 `dir` 一侧。逆时针（左转）时切点在 φ − α，顺时针在 φ + α，其中 φ 是
 * 圆心到下一个点的方位、α = acos(r / D)。下一个点在圆内时无法相切，直接连过去。
 */
function flyoverTurn(
  b: MapPoint,
  c: MapPoint,
  u1: Vec,
  vc: Vec,
  dir: number,
  radiusNm: number,
): MapPoint[] {
  const r = Math.min(radiusNm, len(vc) / 2.5);
  if (r < 1e-3) return [];
  const center = scale(leftNormal(u1), dir * r);
  const toC: Vec = [vc[0] - center[0], vc[1] - center[1]];
  const dist = len(toC);
  if (dist <= r * 1.001) return [];
  const phi = Math.atan2(toC[1], toC[0]);
  const alpha = Math.acos(r / dist);
  const target = dir > 0 ? phi - alpha : phi + alpha;
  const from = Math.atan2(-center[1], -center[0]);
  const twoPi = 2 * Math.PI;
  let sweep = dir > 0 ? target - from : from - target;
  sweep = ((sweep % twoPi) + twoPi) % twoPi;
  if (sweep < MIN_TURN_RAD) return [];
  return arcPoints(center, r, from, dir * sweep).map((v) =>
    shapePoint(b, v, c),
  );
}
