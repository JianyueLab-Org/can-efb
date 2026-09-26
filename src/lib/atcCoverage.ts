/**
 * 在线管制的范围：谁管哪一片，画成什么。
 *
 * ## 规则整个取自 can-radar
 *
 * 判据和 can-radar 的 `RadarMap.vue` 一致（`airspaceKeysFor`、`traconFeaturesFor`、
 * `syncTracons`、`syncStations` 里决定画圈的那几行）。那边用 Leaflet 一个图形一个
 * 图形地画，这里把同一套判断收成纯函数，吐出 GeoJSON 交给 MapLibre。改判据先改
 * can-radar，再同步过来 —— 两个站画出来的管制范围必须一样。
 *
 * - **区域 / FSS**（`ownsAirspace`）：VATSpy 边界。呼号按 `firTable.ts` 的最长前缀对
 *   上边界 id（`MEM_22_CTR` → `KZME`，`RJDG_01_CTR` → `RJDG-F01`，`PRC_FSS` → 九
 *   个情报区）。ATC info 写了 `Covering sector - T30` 就只画那几个扇区；写了
 *   `Extending - ZGGG` 就按同一个席位后缀再对一次，加在上面。FSS 不扩。
 * - **进近**：SimAware 的进近多边形。`ZBAA_S_APP` 先找 `ZBAA_S`，再找 `ZBAA`。任何
 *   席位的 Covering / Extending 名字落在进近多边形上，也画。
 * - **都对不上的非场面席位**（实际上就是没有进近多边形的进近）：以视野半径画一个
 *   虚线圈，上限 400 海里。圈是替身，有真几何的就不画圈。
 * - **场面席位**（放行 / 地面 / 塔台）和**对不上任何范围的**：点。对不上的不吞掉 ——
 *   位置不准的点至少还说明"有人在"。
 *
 * 标注照 can-radar：区域那块标在第一块边界的外接框中心，进近标在多边形最北的那个
 * 顶点，写「呼号 频率」。
 */
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { DatafeedController } from "@/lib/datafeed";
import { isLocalPosition, ownsAirspace } from "@/lib/atc";
import {
  allowsExtending,
  extendedCallsign,
  parseAtisSectors,
} from "@/lib/atisSectors";
import {
  boundariesForSectorName,
  firMatch,
  prefersOceanic,
} from "@/lib/firTable";

// ---------------------------------------------------------------- 边界索引

/** VATSpy 边界：id → 它底下的要素（陆上一块、洋区一块，见 `prefersOceanic`）。 */
export type BoundaryIndex = Map<string, Feature[]>;

export function indexBoundaries(collection: FeatureCollection): BoundaryIndex {
  const index: BoundaryIndex = new Map();
  for (const feature of collection.features) {
    const p = feature.properties ?? {};
    const id = String(p.ID ?? p.id ?? p.name ?? "");
    if (!id) continue;
    const list = index.get(id) ?? [];
    list.push(feature);
    index.set(id, list);
  }
  return index;
}

function isOceanic(feature: Feature): boolean {
  return String(feature.properties?.oceanic ?? "") === "1";
}

/**
 * 边界 id → 要画的那一块。一个 id 底下挂着陆上、洋区两块时按席位挑（can-radar 的
 * `keysForBoundaryId`）；挑不到用第一块。
 */
function shapesFor(
  ids: string[],
  oceanic: boolean,
  boundaries: BoundaryIndex,
): Feature[] {
  const shapes: Feature[] = [];
  for (const id of ids) {
    const candidates = boundaries.get(id);
    if (!candidates?.length) continue;
    const picked =
      candidates.find((f) => isOceanic(f) === oceanic) ?? candidates[0];
    if (!shapes.includes(picked)) shapes.push(picked);
  }
  return shapes;
}

/** can-radar 的 `airspaceKeysFor`：先 Covering，再呼号，再 Extending。 */
function airspaceShapesFor(
  controller: DatafeedController,
  boundaries: BoundaryIndex,
): Feature[] {
  const oceanic = prefersOceanic(controller.callsign);
  const parsed = parseAtisSectors(controller.text_atis);
  const covering = shapesFor(
    parsed.covering.flatMap((name) =>
      boundariesForSectorName(name, controller.callsign),
    ),
    oceanic,
    boundaries,
  );
  const match = firMatch(controller.callsign);
  const primary = covering.length
    ? covering
    : match
      ? shapesFor(match.boundaries, oceanic, boundaries)
      : [];
  const extra = allowsExtending(controller)
    ? shapesFor(
        parsed.extending.flatMap((name) => {
          const callsign = extendedCallsign(controller.callsign, name);
          return callsign ? (firMatch(callsign)?.boundaries ?? []) : [];
        }),
        oceanic,
        boundaries,
      )
    : [];
  const shapes = [...primary];
  for (const shape of extra) if (!shapes.includes(shape)) shapes.push(shape);
  return shapes;
}

// ---------------------------------------------------------------- 进近索引

/** SimAware 前缀 → 它底下的进近多边形。 */
export type TraconIndex = Map<string, Feature[]>;

export function indexTracons(collection: FeatureCollection): TraconIndex {
  const index: TraconIndex = new Map();
  for (const feature of collection.features) {
    for (const prefix of (feature.properties?.prefix as string[]) ?? []) {
      const key = prefix.toUpperCase();
      const list = index.get(key) ?? [];
      list.push(feature);
      index.set(key, list);
    }
  }
  return index;
}

const FACILITY_APPROACH = 5;

/** `ZBAA_S_APP` 先找 `ZBAA_S`，再找 `ZBAA`。 */
function traconsFor(callsign: string, tracons: TraconIndex): Feature[] {
  const parts = callsign.toUpperCase().split("_");
  for (const candidate of [parts.slice(0, -1).join("_"), parts[0]]) {
    if (!candidate) continue;
    const found = tracons.get(candidate);
    if (found?.length) return found;
  }
  return [];
}

function traconsForName(name: string, tracons: TraconIndex): Feature[] {
  const token = name.toUpperCase().trim();
  if (!token) return [];
  return tracons.get(token) ?? traconsFor(token, tracons);
}

function traconShapesFor(
  controller: DatafeedController,
  tracons: TraconIndex,
): Feature[] {
  const parsed = parseAtisSectors(controller.text_atis);
  const fromCallsign =
    controller.facility === FACILITY_APPROACH
      ? traconsFor(controller.callsign, tracons)
      : [];
  const fromCovering = parsed.covering.flatMap((name) =>
    traconsForName(name, tracons),
  );
  const fromExtending = allowsExtending(controller)
    ? parsed.extending.flatMap((name) => {
        const callsign = extendedCallsign(controller.callsign, name);
        return callsign ? traconsFor(callsign, tracons) : [];
      })
    : [];
  const shapes: Feature[] = [];
  for (const f of [...fromCallsign, ...fromCovering, ...fromExtending]) {
    if (!shapes.includes(f)) shapes.push(f);
  }
  return shapes;
}

/**
 * 要不要去取进近多边形（2.7 MB）。can-radar 的 `wantsTracon`：有进近在线，或者
 * 有 Covering 名字在情报区表里解不出来。
 */
export function wantsTracons(controllers: DatafeedController[]): boolean {
  return controllers.some((c) => {
    if (c.facility === FACILITY_APPROACH) return true;
    return parseAtisSectors(c.text_atis).covering.some(
      (name) => !boundariesForSectorName(name, c.callsign).length,
    );
  });
}

// ---------------------------------------------------------------- 几何小件

function eachPosition(geometry: Geometry, visit: (p: Position) => void) {
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      visit(node as Position);
      return;
    }
    for (const child of node) walk(child);
  };
  walk((geometry as { coordinates?: unknown }).coordinates);
}

/** 外接框中心。can-radar 标区域用的是 `getBounds().getCenter()`，同一个点。 */
function boundsCenter(feature: Feature): Position | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  eachPosition(feature.geometry, ([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

/** 最北的顶点。can-radar 的 `traconLabel`。 */
function northernmost(features: Feature[]): Position | null {
  let best: Position | null = null;
  for (const f of features) {
    eachPosition(f.geometry, (p) => {
      if (!best || p[1] > best[1]) best = [p[0], p[1]];
    });
  }
  return best;
}

/** can-radar 的 `MAX_RANGE_NM`：有人把视野开到上千海里，圈不该盖住半个大洲。 */
export const MAX_RANGE_NM = 400;

const EARTH_RADIUS_NM = 3440.065;

/** 以 (lat, lon) 为圆心、nm 为半径的圆，大圆距离，64 段。 */
export function rangeCircle(lat: number, lon: number, nm: number): Position[] {
  const rad = Math.PI / 180;
  const d = nm / EARTH_RADIUS_NM;
  const lat1 = lat * rad;
  const lon1 = lon * rad;
  const ring: Position[] = [];
  for (let i = 0; i <= 64; i++) {
    const bearing = ((i % 64) / 64) * 2 * Math.PI;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(bearing),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([lon2 / rad, lat2 / rad]);
  }
  return ring;
}

function parseCoord(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// ---------------------------------------------------------------- 合起来

export type AreaKind = "fir" | "tracon" | "ring";

export interface Coverage {
  /** 范围：`kind` 是 `fir` / `tracon` / `ring`，另带 `callsign`、`frequency`、`facility`。 */
  areas: FeatureCollection;
  /** 范围的标注点，`label` 是「呼号 频率」。 */
  labels: FeatureCollection;
  /** 仍然画成点的席位：场面席位，外加对不上任何范围的。 */
  points: DatafeedController[];
}

/**
 * 在线席位 → 范围、标注、点。
 *
 * 两份索引都可以是 null（还没取到、取失败）：那时对应的范围画不出来，席位退回画点
 * 或画圈，不会消失。
 */
export function buildCoverage(
  controllers: DatafeedController[],
  boundaries: BoundaryIndex | null,
  tracons: TraconIndex | null,
): Coverage {
  const areas: Feature[] = [];
  const labels: Feature[] = [];
  const points: DatafeedController[] = [];
  const online = new Set(controllers.map((c) => c.callsign.toUpperCase()));

  const area = (c: DatafeedController, shape: Feature, kind: AreaKind) =>
    areas.push({
      type: "Feature",
      properties: {
        kind,
        callsign: c.callsign,
        frequency: c.frequency,
        facility: c.facility,
      },
      geometry: shape.geometry,
    });
  const label = (
    c: DatafeedController,
    at: Position | null,
    callsign = c.callsign,
  ) => {
    if (!at) return;
    labels.push({
      type: "Feature",
      properties: {
        label: `${callsign} ${c.frequency}`,
        facility: c.facility,
      },
      geometry: { type: "Point", coordinates: at },
    });
  };

  for (const c of controllers) {
    let drawn = false;

    if (ownsAirspace(c.facility) && boundaries) {
      const shapes = airspaceShapesFor(c, boundaries);
      if (shapes.length) {
        drawn = true;
        for (const shape of shapes) area(c, shape, "fir");
        label(c, boundsCenter(shapes[0]));
        // Extending 出去的那几块各标一个「扩出去的呼号」，除非那个呼号本人在线，
        // 或者它就是自己那块（can-radar 的 `syncSectorTags`）。
        if (allowsExtending(c)) {
          const oceanic = prefersOceanic(c.callsign);
          for (const name of parseAtisSectors(c.text_atis).extending) {
            const callsign = extendedCallsign(c.callsign, name);
            if (!callsign || online.has(callsign)) continue;
            const [shape] = shapesFor(
              firMatch(callsign)?.boundaries ?? [],
              oceanic,
              boundaries,
            );
            if (!shape || shape === shapes[0]) continue;
            label(c, boundsCenter(shape), callsign);
          }
        }
      }
    }

    if (tracons) {
      const shapes = traconShapesFor(c, tracons);
      if (shapes.length) {
        for (const shape of shapes) area(c, shape, "tracon");
        if (!drawn) label(c, northernmost(shapes));
        drawn = true;
      }
    }

    if (drawn) continue;
    points.push(c);

    // 圈是替身：场面席位不画（它们管的就是这个场），区域 / FSS 对不上边界时也不画
    // （can-radar 里它们根本不进画圈那一段）。
    if (isLocalPosition(c.facility) || ownsAirspace(c.facility)) continue;
    const nm = Math.min(c.visual_range ?? 0, MAX_RANGE_NM);
    const lat = parseCoord(c.latitude);
    const lon = parseCoord(c.longitude);
    if (nm <= 0 || lat == null || lon == null) continue;
    area(
      c,
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [rangeCircle(lat, lon, nm)] },
      },
      "ring",
    );
  }

  return {
    areas: { type: "FeatureCollection", features: areas },
    labels: { type: "FeatureCollection", features: labels },
    points,
  };
}
