/**
 * 实时数据源：在线管制、在线航班、以及**自己那架飞机**。
 *
 * ## 直接打 can-fsd，不走本站的反代
 *
 * datafeed 是**公开且不需要鉴权**的，而且带 `Access-Control-Allow-Origin: *`
 * （核对过），所以岛屿直连就行 —— can-radar 的岛屿也是这么做的。
 *
 * 这一条和本站「浏览器只打同源」的规矩不冲突，因为那条规矩的理由是**会话 cookie
 * 和 CORS**：`api.ceruleanavi.net` 要带凭据，所以必须同源转发。这里一个凭据都不
 * 涉及，转发一道只会多一跳延迟和一处可能出错的地方。
 *
 * 顺带说清楚一件事：`/api/v1/track` 仍然**不在**反代白名单里，那是另一回事 ——
 * 它是 can-api 里**某个 CID 的历史航迹**，不是在线名单。
 *
 * ## 轮询，不用 SSE
 *
 * can-fsd 还有 `/v1/events`（同一份文档的增量流），管制端应该用它。这里不用：
 * 这是一张飞行前后看的图，30 秒的粒度绰绰有余，而 SSE 要自己处理重连、退避和
 * 「掉线了但页面还在」这三件事 —— 为一个不需要秒级刷新的图层背这些不划算。
 *
 * ## 类型逐字取自 can-radar 的 `radarTypes.ts`
 *
 * 是**复制**，不是共享包 —— 和 `geo.ts` 一样的判断，理由见那个文件。但这里有一
 * 条比 geo.ts 更硬的保障：这份契约由 can-fsd 的 `testdata/datafeed_golden.json`
 * 金文件盯着，**加字段是自由的，改名或改类型不是**。
 *
 * 所以下面这个不对称是**真的**，不是笔误：**飞行员的经纬度是 JSON 数字，管制员
 * 的是 JSON 字符串**。照着写，别顺手"统一"成一种。
 */

import type { Feature, FeatureCollection } from "geojson";

/** can-fsd 自己的 HTTP 监听（`:20350`）发布在这个域下。 */
const FSD_ORIGIN = "https://data.ceruleanavi.net";

export const DATAFEED_URL = `${FSD_ORIGIN}/v1/data.json`;

export interface DatafeedFlightPlan {
  aircraft: string;
  alternate: string;
  arrival: string;
  cruise_tas: string;
  cruising_altitude: string;
  departure: string;
  depatime: string;
  flight_rules: string;
  raw_data: string;
  remarks: string;
  route: string;
}

export interface DatafeedPilot {
  altitude: number;
  callsign: string;
  cid: string;
  flight_plan?: DatafeedFlightPlan;
  groundspeed: number;
  heading: number;
  /** **数字。** 管制员那边是字符串，见文件头。 */
  latitude: number;
  logon_time: string;
  longitude: number;
  name: string;
  /** 占着这架飞机雷达标牌的管制员呼号；没人接管时不存在。 */
  tracked_by?: string;
  transponder: number;
}

export interface DatafeedController {
  callsign: string;
  cid: string;
  facility: number;
  frequency: string;
  /** **字符串。** 飞行员那边是数字，见文件头。 */
  latitude: string;
  logon_time: string;
  longitude: string;
  name: string;
  rating: number;
  text_atis: string[];
}

export interface Datafeed {
  atis: DatafeedController[];
  controllers: DatafeedController[];
  general: {
    atc: number;
    pilots: number;
    update: string;
    update_timestamp: number;
  };
  pilots: DatafeedPilot[];
}

export async function fetchDatafeed(): Promise<Datafeed> {
  const response = await fetch(DATAFEED_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`datafeed: ${response.status}`);
  return (await response.json()) as Datafeed;
}

/**
 * 席位代号，键是 datafeed 的 `facility`。
 *
 * 逐字取自 can-radar 的 `lib/facilities.ts` —— **7 是 ATIS**，那边的注释特意记
 * 了它曾被错标成 FSS。
 */
const FACILITIES: Record<number, string> = {
  0: "OBS",
  1: "FSS",
  2: "DEL",
  3: "GND",
  4: "TWR",
  5: "APP",
  6: "CTR",
  7: "ATIS",
};

export function facilityLabel(facility: number): string {
  return FACILITIES[facility] ?? "—";
}

/**
 * 自己那架飞机。
 *
 * **按 CID 匹配，不按呼号。** 呼号是每次连线自己填的，两个人可以填成一样；CID 是
 * 账号。匹配错了的后果是把别人的飞机标成"你"，而屏幕上完全看不出来。
 */
export function ownPilot(
  feed: Datafeed | null,
  cid: string | null,
): DatafeedPilot | null {
  if (!feed || !cid) return null;
  return feed.pilots.find((p) => p.cid === cid) ?? null;
}

/**
 * 在线管制，排好序。
 *
 * `atis` 和 `controllers` 是分开的两个数组，**这里只要 controllers** —— ATIS 机
 * 器人不是能呼叫的席位，混进列表会让人对着一个没人的频率喊。
 *
 * 按呼号排，因为同一个机场的席位呼号前缀相同，排出来自然是挨着的。
 */
export function onlineControllers(feed: Datafeed | null): DatafeedController[] {
  if (!feed) return [];
  return [...feed.controllers].sort((a, b) =>
    a.callsign.localeCompare(b.callsign),
  );
}

/**
 * 在线的 ATIS 通播。
 *
 * **和上面那个分开，这是它存在的全部意义。** 上面那句注释说的是"ATIS 不该混进可
 * 呼叫的席位列表"，那条判断没变 —— 变的是它不再被整个丢掉：ATIS 的正文正是放行前
 * 和进场前要听的那一段，对飞行包来说是最有用的实时文本之一。所以摆在另一处，标题
 * 上就写明它是通播而不是席位。
 *
 * **怎么认出一条是 ATIS，看它来自哪个数组，不看 `facility`。** can-radar 在它的
 * `groupStations` 里记着这一条：一条 ATIS 连接的 `facility` 不一定是 7。所以这里
 * 只读 `feed.atis`，绝不去 `controllers` 里按 `facility === 7` 捞。
 */
export function onlineAtis(feed: Datafeed | null): DatafeedController[] {
  if (!feed) return [];
  return [...feed.atis].sort((a, b) => a.callsign.localeCompare(b.callsign));
}

// ---------------------------------------------------------------- 转成图层要素

/**
 * 管制员的经纬度是**字符串**，这里是唯一需要为它写解析的地方。
 *
 * 解不出来（空串、0、脏值）就丢掉这一条：datafeed 里管制员的坐标是他自己的视野
 * 中心，不是必填项 —— 一个落在几内亚湾 (0,0) 的席位比不画更糟，因为它看起来像
 * 真的。
 */
function parseCoord(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export function toControllerPoints(
  list: DatafeedController[],
): FeatureCollection {
  const features: Feature[] = [];
  for (const c of list) {
    const lat = parseCoord(c.latitude);
    const lon = parseCoord(c.longitude);
    if (lat == null || lon == null) continue;
    features.push({
      type: "Feature",
      properties: {
        callsign: c.callsign,
        // 频率是飞行员真正要的那一样，和呼号一起进标注。
        frequency: c.frequency,
        // **席位类型进要素，好让地图按它分色。** 以前这一层所有点是同一个琥珀色，
        // 于是塔台和区域在图上长得一模一样；而这两者对飞行员是完全不同的两件事。
        // 颜色表在 `lib/atc.ts`，和列表用的是同一份。
        facility: c.facility,
      },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 其余在线航班。**自己那架排除在外** —— 它单独一层，画法不一样。 */
export function toTrafficPoints(
  feed: Datafeed | null,
  cid: string | null,
): FeatureCollection {
  const features: Feature[] = [];
  for (const p of feed?.pilots ?? []) {
    if (cid && p.cid === cid) continue;
    features.push({
      type: "Feature",
      properties: { callsign: p.callsign, heading: p.heading },
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 自己那架飞机，单要素。没连线时是空集合。 */
export function toOwnPoint(pilot: DatafeedPilot | null): FeatureCollection {
  if (!pilot) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          callsign: pilot.callsign,
          heading: pilot.heading,
          // 高度取整到百英尺：datafeed 给的是逐英尺的瞬时值，标注上会跳个不停，
          // 而这张图上没有任何决定取决于那几十英尺。
          altitude: Math.round(pilot.altitude / 100) * 100,
          groundspeed: Math.round(pilot.groundspeed),
        },
        geometry: {
          type: "Point",
          coordinates: [pilot.longitude, pilot.latitude],
        },
      },
    ],
  };
}
