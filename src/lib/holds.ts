/**
 * 等待航线：取数、换算、画成跑道形。
 *
 * 两个来源：
 *
 * - 程序里的等待腿（`HM` / `HA` / `HF`），入航航向是腿的 `courseMag`。
 * - can-db `/aip/holdings` 的终端等待（编码图），带定位点、入航航向、转弯方向、出航
 *   时间、速度、高度、跑道。航路等待（CSV）没有入航航向，不画。
 *
 * 等待挂在航线上那个定位点（`MapPoint.hold`）上，由 `routeLines` 画出来，和航线同一
 * 个 source、按同一个段取色。
 *
 * 入航航向是**磁**的，换成真方位要机场的磁差（can-db 的 `variation`，**西为正**）。
 * 没有磁差时用跑道的磁航向和两端坐标算出的真方位之差估计。
 *
 * 形状是标准等待：出航时间缺省 1 分钟（14000 ft 以上 1.5 分钟），速度缺省 230 kt
 * （以上 240 kt），转弯按标准转弯率（3°/s）算半径。是示意，不是保护区。
 */
import type { MapPoint } from "@/lib/mapBus";
import { unwrapList } from "@/lib/aip";
import { aipScope, dbFetch } from "@/lib/naip";
import { isForbiddenStatus } from "@/lib/requestState";

export interface HoldShape {
  /** 入航航迹，真方位，度。画形状用。 */
  inboundTrue: number;
  /**
   * 入航航向，磁，度 —— 数据给的原值（规整到 0–360），标注用。航图上写的是磁航向，
   * 不从真方位倒算回来：那要再过一次磁差，而原值就在手上。
   */
  inboundMag: number;
  turn: "L" | "R";
  /** 直线段长度，海里。 */
  legNm: number;
  /** 转弯半径，海里。 */
  radiusNm: number;
}

/** `/aip/holdings` 的一行。终端等待之外的字段为 null。 */
export interface Holding {
  name: string | null;
  lat: number;
  lon: number;
  turn: string | null;
  icao: string | null;
  fix: string | null;
  inboundCourseMag: number | null;
  legTimeMin: number | null;
  speedKt: number | null;
  altFt: number | null;
  runway: string | null;
}

const HIGH_FT = 14000;

/** 转弯方向：`L` / `R` / `left` / `right`。认不出按右转（标准等待）。 */
export function normalizeTurn(turn: string | null | undefined): "L" | "R" {
  const t = (turn ?? "").trim().toUpperCase();
  return t === "L" || t === "LEFT" ? "L" : "R";
}

export function holdShape(input: {
  inboundMag: number;
  /** 磁差，西为正。 */
  variationWest: number;
  turn?: string | null;
  legTimeMin?: number | null;
  speedKt?: number | null;
  altFt?: number | null;
}): HoldShape {
  const high = (input.altFt ?? 0) > HIGH_FT;
  const speed =
    input.speedKt && input.speedKt > 0 ? input.speedKt : high ? 240 : 230;
  const minutes =
    input.legTimeMin && input.legTimeMin > 0
      ? input.legTimeMin
      : high
        ? 1.5
        : 1;
  const inbound =
    (((input.inboundMag - input.variationWest) % 360) + 360) % 360;
  return {
    inboundTrue: inbound,
    inboundMag: ((input.inboundMag % 360) + 360) % 360,
    turn: normalizeTurn(input.turn),
    legNm: (speed * minutes) / 60,
    // 标准转弯率 3°/s：半圈 60 秒，弧长 V/60 海里 = π·r。
    radiusNm: speed / (60 * Math.PI),
  };
}

/**
 * 一个等待画成的闭合线，`[lon, lat]`。从定位点出发：转出、出航、转回、入航回到定位点。
 * 右转时整个跑道形在入航航迹的右侧。
 */
export function racetrack(
  lat: number,
  lon: number,
  shape: HoldShape,
): [number, number][] {
  const k = Math.cos((lat * Math.PI) / 180) || 1e-9;
  const toLonLat = ([x, y]: [number, number]): [number, number] => [
    lon + x / 60 / k,
    lat + y / 60,
  ];
  const th = (shape.inboundTrue * Math.PI) / 180;
  const u: [number, number] = [Math.sin(th), Math.cos(th)];
  const right = shape.turn === "R";
  // 转弯一侧的法向。右转取右法向。
  const n: [number, number] = right ? [u[1], -u[0]] : [-u[1], u[0]];
  // 右转在平面上是顺时针，角度减小。
  const sweep = right ? -Math.PI : Math.PI;
  const r = shape.radiusNm;
  const L = shape.legNm;
  const steps = 12;

  const out: [number, number][] = [[0, 0]];
  const arc = (center: [number, number], start: [number, number]) => {
    const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (sweep * i) / steps;
      out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
    }
  };
  // 过定位点转出。
  arc([n[0] * r, n[1] * r], [0, 0]);
  // 出航，沿入航的反方向。
  const outEnd: [number, number] = [
    2 * r * n[0] - L * u[0],
    2 * r * n[1] - L * u[1],
  ];
  out.push(outEnd);
  // 转回入航。
  arc([r * n[0] - L * u[0], r * n[1] - L * u[1]], outEnd);
  // 入航回到定位点。
  out.push([0, 0]);
  return out.map(toLonLat);
}

/**
 * 航向写成航图的样子：三位数加 `°`，`0` 写 `360°`。按整度四舍五入。
 */
export function courseText(mag: number): string {
  const deg = ((Math.round(mag) % 360) + 360) % 360 || 360;
  return `${String(deg).padStart(3, "0")}°`;
}

/** 等待上的一个标记：一个方向箭头，或者一条边上的航向。坐标 `[lon, lat]`。 */
export type HoldMark =
  | {
      kind: "arrow";
      at: [number, number];
      /** 飞行方向，真方位，度。箭头朝北画，`icon-rotate` 直接用它。 */
      rotate: number;
    }
  | {
      kind: "course";
      at: [number, number];
      /** 航图上的写法，`347°`。 */
      text: string;
      /** 字的旋转（度，顺时针），让字顺着边读、且永远不倒过来。 */
      rotate: number;
      /**
       * 字往哪边挪：`-1` 往字的上方、`1` 往下方。按字的朝向算好，让它落在跑道形**外侧**
       * —— 在里侧会压到另一条边的字和箭头上。
       */
      side: -1 | 1;
    };

/**
 * 等待的方向箭头和航向标注：入航边、出航边的中点各一个箭头（顺着飞的方向），各一个
 * 航向（入航写数据给的磁航向，出航写它的反方向）。几何和 `racetrack` 同一套：入航边
 * 从 `-L·u` 到定位点，出航边在转弯一侧 `2r` 外，方向反过来。
 */
export function holdMarks(
  lat: number,
  lon: number,
  shape: HoldShape,
): HoldMark[] {
  const k = Math.cos((lat * Math.PI) / 180) || 1e-9;
  const toLonLat = ([x, y]: [number, number]): [number, number] => [
    lon + x / 60 / k,
    lat + y / 60,
  ];
  const th = (shape.inboundTrue * Math.PI) / 180;
  const u: [number, number] = [Math.sin(th), Math.cos(th)];
  const right = shape.turn === "R";
  const n: [number, number] = right ? [u[1], -u[0]] : [-u[1], u[0]];
  const r = shape.radiusNm;
  const L = shape.legNm;
  const inboundMid: [number, number] = [(-L / 2) * u[0], (-L / 2) * u[1]];
  const outboundMid: [number, number] = [
    2 * r * n[0] - (L / 2) * u[0],
    2 * r * n[1] - (L / 2) * u[1],
  ];

  const norm = (deg: number) => ((deg % 360) + 360) % 360;
  // 字顺着边读：旋转落在 (-90, 90]，两条边平行，所以是同一个角度。
  let rotate = norm(shape.inboundTrue - 90);
  if (rotate > 90 && rotate <= 270) rotate -= 180;
  else if (rotate > 270) rotate -= 360;
  // 字的「上方」指向真方位 `rotate`。外侧离它不到 90° 就往上挪，否则往下。
  const turnSide = norm(shape.inboundTrue + (right ? 90 : -90));
  const sideToward = (bearing: number): -1 | 1 => {
    const diff = Math.abs(((bearing - rotate + 540) % 360) - 180);
    return diff < 90 ? -1 : 1;
  };

  return [
    {
      kind: "arrow",
      at: toLonLat(inboundMid),
      rotate: norm(shape.inboundTrue),
    },
    {
      kind: "arrow",
      at: toLonLat(outboundMid),
      rotate: norm(shape.inboundTrue + 180),
    },
    {
      kind: "course",
      at: toLonLat(inboundMid),
      text: courseText(shape.inboundMag),
      rotate,
      side: sideToward(turnSide + 180),
    },
    {
      kind: "course",
      at: toLonLat(outboundMid),
      text: courseText(shape.inboundMag + 180),
      rotate,
      side: sideToward(turnSide),
    },
  ];
}

/** 程序腿是不是等待腿。 */
export function isHoldLeg(path: string | null | undefined): boolean {
  return /^H[AFM]$/.test((path ?? "").toUpperCase());
}

/**
 * 机场磁差，西为正。can-db 给了就用；没给就由跑道估计（磁航向 − 真方位，取中位数）；
 * 两样都没有时为 0。
 */
export function estimateVariation(
  variation: number | null | undefined,
  runways: {
    hdg: number | null;
    lat: number;
    lon: number;
    endLat: number;
    endLon: number;
  }[],
): number {
  if (variation != null && Number.isFinite(variation)) return variation;
  const rad = Math.PI / 180;
  const diffs: number[] = [];
  for (const r of runways) {
    if (r.hdg == null) continue;
    if (r.lat === r.endLat && r.lon === r.endLon) continue;
    const dLon = (r.endLon - r.lon) * rad;
    const y = Math.sin(dLon) * Math.cos(r.endLat * rad);
    const x =
      Math.cos(r.lat * rad) * Math.sin(r.endLat * rad) -
      Math.sin(r.lat * rad) * Math.cos(r.endLat * rad) * Math.cos(dLon);
    const trueBrg = Math.atan2(y, x) / rad;
    diffs.push(((((r.hdg - trueBrg) % 360) + 540) % 360) - 180);
  }
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// ------------------------------------------------------------------ 取数

const cache = new Map<string, Promise<Holding[]>>();

/** 全部等待，按 `aipScope()` 缓存。失败给空数组：没有等待不影响航线本身。 */
export function loadHoldings(): Promise<Holding[]> {
  const key = aipScope();
  const hit = cache.get(key);
  if (hit) return hit;
  const request = dbFetch("aip/holdings")
    .then(async (response) => {
      // 没有权限是常态：记住空的，不再问，也不报错。
      if (isForbiddenStatus(response.status)) return [] as Holding[];
      if (!response.ok) throw new Error(`holdings: ${response.status}`);
      return unwrapList<Holding>(await response.json());
    })
    .catch((e) => {
      cache.delete(key);
      console.error("[efb:holds] failed to load holdings:", e);
      return [] as Holding[];
    });
  cache.set(key, request);
  return request;
}

// ------------------------------------------------------------------ 挂到航线上

/** 跑道代号的数字部分，`01L` → `01`。 */
function runwayNumber(id: string): string {
  return id.trim().toUpperCase().replace(/^RW/, "").slice(0, 2);
}

/**
 * 把终端等待挂到航线上同名的定位点上。
 *
 * - 只认两端机场的等待（`icao`），且要有入航航向。
 * - 已经挂着等待的点（程序里的等待腿）不再换。
 * - 同一个定位点有几条（按跑道分）时，优先选中的那条跑道的；选了跑道而等待写着别
 *   的跑道的，不用。
 */
export function attachTerminalHolds(
  points: MapPoint[],
  holdings: Holding[],
  airports: { icao: string; runway: string; variationWest: number }[],
): MapPoint[] {
  const byFix = new Map<string, Holding[]>();
  const want = new Map(airports.map((a) => [a.icao.toUpperCase(), a]));
  for (const h of holdings) {
    if (!h.fix || h.inboundCourseMag == null || !h.icao) continue;
    if (!want.has(h.icao.toUpperCase())) continue;
    const key = h.fix.toUpperCase();
    const list = byFix.get(key);
    if (list) list.push(h);
    else byFix.set(key, [h]);
  }
  if (!byFix.size) return points;

  return points.map((p) => {
    if (p.hold || p.shape || !p.ident || p.kind === "airport") return p;
    const candidates = byFix.get(p.ident.toUpperCase());
    if (!candidates) return p;
    const pick = (() => {
      for (const h of candidates) {
        const airport = want.get((h.icao ?? "").toUpperCase());
        const selected = airport?.runway ? runwayNumber(airport.runway) : "";
        const own = h.runway ? runwayNumber(h.runway) : "";
        if (selected && own === selected) return h;
      }
      return candidates.find((h) => {
        const airport = want.get((h.icao ?? "").toUpperCase());
        return !h.runway || !airport?.runway;
      });
    })();
    if (!pick) return p;
    const airport = want.get((pick.icao ?? "").toUpperCase());
    return {
      ...p,
      hold: holdShape({
        inboundMag: pick.inboundCourseMag as number,
        variationWest: airport?.variationWest ?? 0,
        turn: pick.turn,
        legTimeMin: pick.legTimeMin,
        speedKt: pick.speedKt,
        altFt: pick.altFt,
      }),
    };
  });
}
