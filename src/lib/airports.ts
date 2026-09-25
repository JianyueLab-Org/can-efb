/**
 * 机场索引：只为回答一个问题 —— **这个视野里有哪些机场**。
 *
 * 地面图层要按机场取数据，而地图只知道自己在看哪一块地。中间缺的就是一张
 * 「ICAO → 坐标」的表，433 行，一次取回来整趟会话都用它。
 *
 * **不缓存到 localStorage。** 这批数据跟着 `aipAccess` 走（1–2 级看到 246 个，
 * 3–4 级看到 433 个），落盘就得自己管失效 —— 而成员的级别是可以被 ADM 改的。留在
 * 内存里，一次刷新自然重来。反代那一层已经给了十分钟的 `private` 缓存，整页刷新
 * 的代价本来就不高。
 */
import type { FeatureCollection } from "geojson";
import { aipScope, dbFetch } from "@/lib/naip";

export interface AirportPin {
  icao: string;
  name: string | null;
  lat: number;
  lon: number;
}

/** 按 `aipScope()` 分开记：隐藏 NAIP 的开关一变，旧那份就不能再被命中。 */
const pending = new Map<string, Promise<AirportPin[]>>();
const loaded = new Map<string, AirportPin[]>();

/**
 * 取机场索引，整趟会话只取一次。
 *
 * **并发也只取一次**：地图 `moveend` 会连着触发，如果每次都发一个请求，第一次放
 * 大就会同时飞出去五六个一样的请求。记住那个 Promise 而不是记住结果，才挡得住这
 * 一段窗口。
 */
export async function fetchAirportPins(): Promise<AirportPin[]> {
  const scope = aipScope();
  const hit = loaded.get(scope);
  if (hit) return hit;
  const inFlight = pending.get(scope);
  if (inFlight) return inFlight;

  const job = (async () => {
    try {
      const response = await dbFetch("aip/airports");
      if (!response.ok) return [];
      const body = await response.json();
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown })?.data)
          ? ((body as { data: unknown[] }).data as unknown[])
          : [];
      const out: AirportPin[] = [];
      for (const r of rows as Record<string, unknown>[]) {
        const pin = toAirportPin(r);
        if (pin) out.push(pin);
      }
      loaded.set(scope, out);
      return out;
    } catch {
      /* 失败不写 `loaded`，所以下一次视野变化会再试。但要清掉 `pending`，否则这
         一个失败的 Promise 会被永远返回下去 —— 图层从此再也不会恢复。 */
      return [];
    } finally {
      pending.delete(scope);
    }
  })();

  pending.set(scope, job);
  return job;
}

/**
 * 一行机场 → 一个点。坐标缺了就不要这一行。
 *
 * **不能直接 `Number()`**：`Number(null)` 和 `Number("")` 都是 `0`，而 0 是有限数，
 * 于是一个没坐标的机场变成几内亚湾里（0°, 0°）的一个齿轮 —— 不报错，看起来还是一
 * 个正常的机场点。所以只认数字和非空字符串，其余一律当缺。
 */
export function toAirportPin(r: Record<string, unknown>): AirportPin | null {
  const lat = coordinate(r.lat);
  const lon = coordinate(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    icao: String(r.icao ?? "").toUpperCase(),
    name: (r.name as string) ?? null,
    lat,
    lon,
  };
}

function coordinate(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}

/**
 * 判定时把视野**向外放**这么多公里。
 *
 * **一个机场是一片地方，不是一个点**，而 `AirportPin` 只有基准点。放大到一定程度之
 * 后视野比机场还小 —— z15 在北纬 40° 大约只有两三公里，而首都东西向四公里 —— 于是
 * 你凑近跑道看的时候，基准点落到了框外。
 *
 * 不放的后果是**整片地面突然消失**：`loadGroundFor` 拿到空清单就清空图层。而它发生
 * 在越看越近的时候，正好和「地图坏了」长得一模一样。
 *
 * 15 公里照最大的机场留余量（浦东东西向约 5 公里，再加上贴着边缘看），而它同时是
 * **取数的上限**：更远的机场不会被拉进来，所以放大之后不会反而多下载。
 */
const VIEW_PAD_KM = 15;

/**
 * 机场索引 → 地图上的机场点。
 *
 * **整份都给，不按视野裁。** 433 个点对 MapLibre 是小数目，而按视野裁意味着每次
 * 平移都要重算一遍 GeoJSON 并 `setData` —— 那比让它一直画着贵得多。出不出现由图层
 * 的 `minzoom` 管，那是渲染的事。
 */
export function toAirportPoints(
  pins: AirportPin[],
  runways?: Map<string, { bearing: number; major: boolean }>,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pins.map((p) => {
      /* 跑道概况（`lib/runways.ts` 的 `airportRunwaySummary`）决定两件事：低缩放下画
       * 不画、实心还是空心（`major`），以及跑道线出现后符号让不让位（`hasRwy`）。
       * `rwyHdg` 目前没有图层读。 */
      const rwy = runways?.get(p.icao);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: {
          icao: p.icao,
          name: p.name ?? "",
          major: rwy?.major ? 1 : 0,
          hasRwy: rwy ? 1 : 0,
          rwyHdg: rwy ? Math.round(rwy.bearing) : 0,
        },
      };
    }),
  };
}

/**
 * 视野里的机场，按离视野中心由近及远。
 *
 * **视野的经度是 MapLibre 原样给的展开值**（过了日界线是 `170..190`），而机场的经
 * 度在 [-180, 180)。直接比的话，东经 190 那一侧（也就是西经 170）的机场永远不在框
 * 里。所以把每个机场的经度挪到离视野中心最近的那一圈（±360 的整数倍）再比 —— 等于
 * 把框在日界线处切成两段、各比一次，只是不用真的切。视野横跨 360° 以上时经度不再筛。
 *
 * 排序是给取数配额用的（`GROUND_MAX_AIRPORTS`）：视野里有四个场而只取三个时，该
 * 放弃的是最边上那个，不是碰巧排在数组后面那个。
 *
 * 距离按经纬度平方算，不换算成公里 —— 这里只用来排序，而在一个屏幕的尺度上，纬度
 * 缩放对**先后**的影响可以忽略。真要算距离的地方（比如判断进近）不能这么省。
 */
export function airportsInView(
  pins: AirportPin[],
  v: { south: number; west: number; north: number; east: number },
): AirportPin[] {
  const cLat = (v.south + v.north) / 2;
  const cLon = (v.west + v.east) / 2;

  /* 纬度方向一度约 111 公里；经度方向随纬度收窄，所以按视野中心的纬度换算。高纬度
   * 不换算会让经度方向的余量不够，而这个网络最北到漠河附近。 */
  const padLat = VIEW_PAD_KM / 111;
  const padLon =
    VIEW_PAD_KM / (111 * Math.max(0.2, Math.cos((cLat * Math.PI) / 180)));

  const wholeWorld = v.east - v.west >= 360;
  const near = (lon: number) => lon + 360 * Math.round((cLon - lon) / 360);
  const dist = (p: AirportPin) =>
    (p.lat - cLat) ** 2 + (near(p.lon) - cLon) ** 2;

  return pins
    .filter((p) => {
      if (p.lat < v.south - padLat || p.lat > v.north + padLat) return false;
      if (wholeWorld) return true;
      const lon = near(p.lon);
      return lon >= v.west - padLon && lon <= v.east + padLon;
    })
    .sort((a, b) => dist(a) - dist(b));
}

/**
 * 机场页列表的一行。和 `server/canDb.ts` 的 `AirportSummary` 逐字对齐 —— 两边读
 * 的是同一个接口。不直接 import 那个类型：那个文件服务端专用，岛屿一侧只留这一份。
 * 形状分叉了就会有一边悄悄读到 undefined，改一处就要改另一处。
 */
export interface AirportRow {
  icao: string;
  fir: string | null;
  name: string | null;
  lat: number;
  lon: number;
  elev: number | null;
  variation: number | null;
  airac: string;
  /** 机位数，不是机位本身 —— 详情接口才给数组。 */
  stands: number;
}
