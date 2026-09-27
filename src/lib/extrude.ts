/**
 * 倾斜视角下的立体要素：计划航线的高度剖面、在线机组的高度柱。空域的立体块不在这里
 * —— 它直接用空域要素上的 `lowerM` / `upperM`，见 `chartStyle.ts` 的 `airspace-volume`。
 *
 * 全是纯计算。MapLibre 的 `fill-extrusion` 只接面，所以线和点都要在这里先铺成小方块；
 * 方块多宽按缩放给（`halfWidthM`），缩放一变 RouteMap 按整级重算一次。
 *
 * 高度一律带**米**（`baseM` / `topM`），和空域的 `lowerM` / `upperM` 同一个单位 ——
 * 三层用同一个放大倍数（`chartStyle.ts` 的 `extrudeHeight`），高低才比得了。
 */
import type { Feature, FeatureCollection, Position } from "geojson";
import { distanceNm, greatCircle, type LatLon } from "@/lib/geo";
import type { RoutePoint } from "@/lib/routeGeometry";
import { isOnGround } from "@/lib/traffic";

export const M_PER_FT = 0.3048;
const M_PER_NM = 1852;

/**
 * 爬升、下降每千英尺走多少海里。**剖面是估算**，不是性能计算：下降取 3:1 的经验
 * 法则，爬升取常见喷气机的量级。程序上的高度限制不参与 —— 那一列原样显示、不解码
 * （AGENTS.md〈高度限制原样显示，不解码〉），拿它来凑剖面等于换个地方解码。
 */
export const PROFILE = {
  climbNmPer1000Ft: 3.5,
  descentNmPer1000Ft: 3,
  /** 剖面一小段多长。爬升段每段约 570 ft，看得出台阶但不碍事。 */
  stepNm: 2,
  /** 剖面那条带的厚度。 */
  thicknessM: 120,
} as const;

/**
 * 飞行计划的巡航高度栏换成英尺。认不出就给 null，**不猜**。
 *
 * - `FL350` / `F350`：高度层，×100 ft
 * - `A045`：高度，百英尺
 * - `S1190`：米制高度层，十米为单位（中国的写法）
 * - `M0840`：米制高度，十米为单位
 * - 纯数字且 ≥ 1000：英尺（`35000`）
 *
 * 三位以内的纯数字（`350`）不认：它可能是 FL350，也可能是写错了，两种读法差一百
 * 倍。
 */
export function parseCruiseLevel(
  raw: string | null | undefined,
): number | null {
  const s = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  let m = /^(?:FL|F)(\d{2,3})$/.exec(s);
  if (m) return Number(m[1]) * 100;
  m = /^A(\d{2,3})$/.exec(s);
  if (m) return Number(m[1]) * 100;
  m = /^[SM](\d{4})$/.exec(s);
  if (m) return Math.round((Number(m[1]) * 10) / M_PER_FT);
  m = /^(\d{4,5})(?:FT)?$/.exec(s);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 沿航线走过 `s` 海里（全长 `total`）时的估算高度，英尺。起降两端是 0：剖面是离
 * 地高，不带机场标高。
 */
export function profileAltitudeFt(
  s: number,
  total: number,
  cruiseFt: number,
): number {
  const climb = (s / PROFILE.climbNmPer1000Ft) * 1000;
  const descent = ((total - s) / PROFILE.descentNmPer1000Ft) * 1000;
  return Math.max(0, Math.min(cruiseFt, climb, descent));
}

/** 这个缩放下一个屏幕像素是多少米（Web Mercator，按纬度收窄）。 */
export function metersPerPixel(zoom: number, lat: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/** 以 `a → b` 为中线、半宽 `halfM` 米的小矩形，闭合环，`[lon, lat]`。 */
function quad(a: LatLon, b: LatLon, halfM: number): Position[] {
  const lat0 = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(lat0);
  const dx = (b[1] - a[1]) * mPerDegLon;
  const dy = (b[0] - a[0]) * mPerDegLat;
  const len = Math.hypot(dx, dy) || 1;
  // 左手法线，换回经纬度。
  const ox = (-dy / len) * halfM;
  const oy = (dx / len) * halfM;
  const dLon = ox / mPerDegLon;
  const dLat = oy / mPerDegLat;
  return [
    [a[1] + dLon, a[0] + dLat],
    [b[1] + dLon, b[0] + dLat],
    [b[1] - dLon, b[0] - dLat],
    [a[1] - dLon, a[0] - dLat],
    [a[1] + dLon, a[0] + dLat],
  ];
}

/** 以一点为中心、半边长 `halfM` 米的正方形。 */
function square(lat: number, lon: number, halfM: number): Position[] {
  const dLat = halfM / 111320;
  const dLon = halfM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
}

/**
 * 计划航线的估算高度剖面。
 *
 * 线只走真正飞经的点：旁切的角点（`offPath`）不走，弯里插的几何点（`shape`）走，和
 * `routeLines` 一致。复飞段不进剖面 —— 它接在落地之后，算进全长会把下降点往后推。
 *
 * 每一小段出两个要素：`part: "wall"` 从地面立到剖面（半透明的幕，读得出哪里在爬、
 * 哪里在降），`part: "ribbon"` 是剖面本身那条带。都带 `baseM` / `topM`。
 */
export function routeProfile(
  points: RoutePoint[],
  cruiseFt: number | null,
  halfWidthM: number,
): FeatureCollection {
  const features: Feature[] = [];
  if (!cruiseFt || cruiseFt <= 0)
    return { type: "FeatureCollection", features };

  const path: LatLon[] = [];
  for (const p of points) {
    if (p.offPath || p.kind === "missed") continue;
    const here: LatLon = [p.lat, p.lon];
    const prev = path[path.length - 1];
    if (!prev) {
      path.push(here);
      continue;
    }
    const d = distanceNm(prev, here);
    if (d < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(d / PROFILE.stepNm));
    // greatCircle 的第一个点就是 prev，跳过。
    path.push(...greatCircle(prev, here, steps).slice(1));
  }
  if (path.length < 2) return { type: "FeatureCollection", features };

  const along = [0];
  for (let i = 1; i < path.length; i++) {
    along.push(along[i - 1] + distanceNm(path[i - 1], path[i]));
  }
  const total = along[along.length - 1];

  for (let i = 1; i < path.length; i++) {
    // 一小段取中点的高度，台阶落在段与段之间。
    const mid = (along[i - 1] + along[i]) / 2;
    const topM = profileAltitudeFt(mid, total, cruiseFt) * M_PER_FT;
    if (topM <= 0) continue;
    const ring = quad(path[i - 1], path[i], halfWidthM);
    const ribbonBaseM = Math.max(0, topM - PROFILE.thicknessM);
    // 幕停在带的底面：两个顶面同高会互相打架，带上出现闪烁的白点。
    features.push({
      type: "Feature",
      properties: { part: "wall", baseM: 0, topM: ribbonBaseM },
      geometry: {
        type: "Polygon",
        coordinates: [quad(path[i - 1], path[i], halfWidthM * 0.25)],
      },
    });
    features.push({
      type: "Feature",
      properties: {
        part: "ribbon",
        baseM: ribbonBaseM,
        topM,
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 高度柱顶上那一块的厚度。 */
const CAP_THICKNESS_M = 150;

/**
 * 在线机组的高度柱：细柱从地面立到它的高度，顶上一块按高度档着色。
 *
 * 吃的是 `toTrafficPoints` 出的点要素（带 `altitude`、`band`、`onGround`）。地面上
 * 的、没有高度的不立柱：一根零高的柱子什么也不说明。自己那架由 `own` 传进来，带
 * `own: 1`，样式给它自己的颜色。
 */
export function trafficColumns(
  traffic: FeatureCollection | null | undefined,
  own: FeatureCollection | null | undefined,
  halfWidthM: number,
): FeatureCollection {
  const features: Feature[] = [];
  const add = (f: Feature, isOwn: boolean) => {
    const p = f.properties ?? {};
    if (f.geometry.type !== "Point") return;
    if (p.onGround === 1) return;
    // 自己那架没有 onGround，按地速判：停在机坪上的高度是场高，不是飞行高度。
    if (isOwn && isOnGround(p.groundspeed)) return;
    const altitude = Number(p.altitude);
    if (!Number.isFinite(altitude) || altitude <= 0) return;
    const [lon, lat] = f.geometry.coordinates;
    const topM = altitude * M_PER_FT;
    const capBaseM = Math.max(0, topM - CAP_THICKNESS_M);
    const shared = { cid: p.cid ?? "", band: p.band ?? 0, own: isOwn ? 1 : 0 };
    features.push({
      type: "Feature",
      // 柱停在顶块的底面，理由同 routeProfile 的幕。
      properties: { ...shared, part: "stalk", baseM: 0, topM: capBaseM },
      geometry: {
        type: "Polygon",
        coordinates: [square(lat, lon, halfWidthM * 0.2)],
      },
    });
    features.push({
      type: "Feature",
      properties: {
        ...shared,
        part: "cap",
        baseM: capBaseM,
        topM,
      },
      geometry: {
        type: "Polygon",
        coordinates: [square(lat, lon, halfWidthM)],
      },
    });
  };
  for (const f of traffic?.features ?? []) add(f, false);
  for (const f of own?.features ?? []) add(f, true);
  return { type: "FeatureCollection", features };
}
