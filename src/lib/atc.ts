/**
 * 管制席位怎么显示 —— 分色、排序、按机场归堆、在线时长。
 *
 * ## 和 `datafeed.ts` 的分工
 *
 * `datafeed.ts` 是**线上格式**：类型、取数、以及那个刻意的不对称（飞行员的经纬度
 * 是数字、管制员的是字符串）。这个文件是**怎么把它显示出来**。分开的理由和
 * can-radar 一样，那边正是 `radarTypes.ts`（线）与 `radar.ts`（显示）两个文件。
 *
 * ## 这一份是从 can-radar 移过来的，不是新写的
 *
 * `FACILITY_COLORS`、`facilityRank`、`stationAirport`、`parseFeedTime` 逐字取自
 * `can-radar/src/lib/radar.ts`。**是复制，不是共享包** —— 和 `geo.ts` 同一个判断：
 * 两个站分属不同仓库、不同 CI，为几个纯函数拉一条发布通道不划算。改之前先看那一份。
 *
 * 移过来的时候有一条**不能想当然**，它在 can-radar 里是踩出来的：
 *
 * **`logon_time` 是没有时区标记的 UTC 墙钟**（`2026-07-27 12:34:55`）。
 * `new Date()` 会把这个形状当作**本地时间**读，于是"在线多久"整体偏掉观看者的时
 * 区 —— 在中国是多算八小时，在格林尼治以西是反方向。它错得毫无征兆：算出来的仍然
 * 是一个像模像样的时长。所以时间一律走 `parseFeedTime`，不要图省事写 `new Date`。
 *
 * ## 哪几处按 EFB 的用途改了
 *
 * can-radar 是给看客用的一张全网图，这个站是给**要飞的人**用的飞行包，所以：
 *
 * - **不移植 `facilityLetter`。** 那是给地图标牌上四个字母并排用的（`ZSSS D G T A`），
 *   而这里是一份带频率的列表，位置足够写全 `GND` / `TWR`，缩成一个字母反而要人再
 *   认一次。
 * - **ATIS 单独一份，不混进可呼叫的席位里。** 这一条继承自 `datafeed.ts` 里
 *   `onlineControllers` 的注释：ATIS 机器人不是能呼叫的席位，混进列表会让人对着一
 *   个没人的频率喊。但**它的正文对飞行员很有用**（那正是放行和进场要听的东西），
 *   所以不是丢掉，而是分开摆。
 */

import type { DatafeedController } from "@/lib/datafeed";

/**
 * 席位颜色，键是 datafeed 的 `facility`。
 *
 * 逐字取自 can-radar 的 `FACILITY_COLORS`（它又来自 vatsim-radar 的
 * `getFacilityPositionColor`）。一种席位一个颜色，于是"哪一类开着"不用读字就知道：
 * 地面移动是绿系、塔台红、进近橙、区域青、ATIS 琥珀。
 *
 * **和地图上那些点用同一批值**，这是它值得单独摆一份的理由 —— 图例、列表、地图各
 * 写一份色号，是那种改了一边、另一边悄悄开始说谎的东西。
 */
export const FACILITY_COLORS: Record<number, string> = {
  0: "#8b8b93", // OBS
  1: "#2ea78f", // FSS —— 和 CTR 同族，都是航路管制
  2: "#2c5ad9", // DEL
  3: "#4a9c25", // GND
  4: "#d32c00", // TWR
  5: "#ff861d", // APP
  6: "#2ea78f", // CTR
  7: "#f0bc01", // ATIS
};

export function facilityColor(facility: number): string {
  return FACILITY_COLORS[facility] ?? FACILITY_COLORS[0];
}

/**
 * 一个机场的席位，按管制员自己的阅读顺序**从下往上**排。
 *
 * 逐字取自 can-radar。**不是字母序** —— 字母序会把 ZSSS_APP 排在 ZSSS_DEL 前面，
 * 而放行、地面、塔台、进近是一架飞机依次要联系的顺序，照这个顺序摆，列表本身就是
 * 一条流程。
 */
const FACILITY_RANK: Record<number, number> = {
  2: 0, // DEL
  3: 1, // GND
  4: 2, // TWR
  5: 3, // APP
  7: 4, // ATIS
  6: 5, // CTR
  1: 6, // FSS
  0: 7, // OBS
};

export function facilityRank(facility: number): number {
  return FACILITY_RANK[facility] ?? 9;
}

/**
 * 席位属于哪个机场 —— 第一个下划线之前的部分。
 *
 * 逐字取自 can-radar：`ZSSS_TWR`、`ZSSS_I_TWR`、`ZSSS_ATIS` 都归到 ZSSS。
 */
export function stationAirport(callsign: string): string {
  return (callsign.split("_")[0] || callsign).toUpperCase();
}

/**
 * 哪些席位算"这个机场上的"，因而并进同一堆。
 *
 * 取自 can-radar 的 `LOCAL_FACILITIES`，连同它的理由：放行、地面、塔台（加 ATIS）
 * 都在场面上，一行标题就回答了"ZSSS 开了什么"。
 *
 * **进近不在里面。** 它管的是机场周围一片空域而不是这个机场，而且常常一个人管着好
 * 几个场 —— 归进某一个机场的堆里会说错话。区域同理。
 */
const LOCAL_FACILITIES = new Set([2, 3, 4]);

export function isLocalPosition(facility: number): boolean {
  return LOCAL_FACILITIES.has(facility);
}

/**
 * datafeed 的时间戳。
 *
 * 逐字取自 can-radar 的 `parseFeedTime`，**这一份最不能自作聪明**：
 * `logon_time` 是 `2026-07-27 12:34:55` 这个形状 —— UTC 的墙钟，而且没有任何东西
 * 说它是 UTC。`new Date()` 把它当本地时间读，于是每一个"在线多久"都偏掉观看者的时
 * 区：在中国多算八小时，格林尼治以西反过来。
 *
 * 本来就带时区的（结尾是 `Z` 或 `±HH:MM`）交给平台，它处理得没问题。
 */
export function parseFeedTime(value: string | null | undefined): Date | null {
  const text = (value ?? "").trim();
  if (!text) return null;

  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const zoned = new Date(text);
    return Number.isNaN(zoned.getTime()) ? null : zoned;
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    const fallback = new Date(text);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0),
    ),
  );
}

/**
 * 「上席 3h 12m」。
 *
 * 时间基准由调用方传进来（`now`），默认取当前时刻 —— 传得进去才测得了，而这个函数
 * 的全部风险就在时区上。
 */
export function onlineFor(
  logonTime: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const start = parseFeedTime(logonTime);
  if (!start) return null;
  const minutes = Math.max(0, Math.round((now - start.getTime()) / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** 列表里的一堆席位：一个机场，或者一个自成一体的进近/区域席位。 */
export interface StationGroup {
  /** 机场四字码，或者那个席位自己的呼号。 */
  code: string;
  /** 这堆是不是场面席位（决定标题读作机场还是读作席位）。 */
  local: boolean;
  stations: DatafeedController[];
}

/**
 * 把在线席位归堆，堆内按席位顺序排，堆之间按代号排。
 *
 * 形状取自 can-radar 的 `groupStations`，但**去掉了它一半的东西**：那边还要算标牌
 * 锚点、处理重叠堆叠、把进近挪到它管的那块空域边界上 —— 全是地图上的事。这里是一
 * 份列表，只需要"谁和谁在一起、先读哪个"。
 *
 * 堆之间按 `code` 排而不是按席位等级：一个飞行员是按机场找频率的（"我在 ZGGG，
 * ZGGG 开了什么"），不是按"全网所有塔台"找。
 */
export function groupControllers(
  controllers: DatafeedController[],
): StationGroup[] {
  const groups = new Map<string, StationGroup>();

  for (const c of controllers) {
    const local = isLocalPosition(c.facility);
    // 场面席位并到机场那一堆；进近和区域各自成堆，键上加前缀免得和四字码撞。
    const key = local ? stationAirport(c.callsign) : `pos:${c.callsign}`;
    const group = groups.get(key) ?? {
      code: local ? stationAirport(c.callsign) : c.callsign,
      local,
      stations: [],
    };
    group.stations.push(c);
    groups.set(key, group);
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.stations.sort((a, b) => {
      const byRank = facilityRank(a.facility) - facilityRank(b.facility);
      // 同一档里按呼号，好让 ZSSS_TWR 和 ZSSS_I_TWR 之间有个稳定的顺序 —— 没有这
      // 一条，两次刷新之间它们会互换位置，看起来像有人上下线。
      return byRank || a.callsign.localeCompare(b.callsign);
    });
  }
  return list.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * ATIS 正文。
 *
 * datafeed 把它给成一个字符串数组（一行一条），拼起来才是一段能读的报文。空行去掉：
 * 有的发布端会在末尾留一条空的。
 */
export function atisText(station: DatafeedController): string {
  return (station.text_atis ?? [])
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * ATIS 通播代号（信息 A、信息 B 那个字母）。
 *
 * **从正文里认，不从别的字段拿** —— datafeed 没有单独的一列放它。找的是
 * `INFORMATION X` / `INFO X` / `ATIS X` 后面那个孤立的字母；认不出来就返回 null，
 * **不猜**：通播代号错一个字母，就是让人按着上一份天气做决定。
 */
export function atisLetter(station: DatafeedController): string | null {
  const text = atisText(station).toUpperCase();
  const match = /\b(?:INFORMATION|INFO|ATIS)\s+([A-Z])\b/.exec(text);
  return match ? match[1] : null;
}
