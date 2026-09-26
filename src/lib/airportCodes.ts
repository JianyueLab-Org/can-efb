/**
 * 席位呼号的第一段 → 机场 ICAO。
 *
 * **取自 can-radar 的 `src/lib/airportCodes.ts`**，改了三处：对照表从 `src/` 里
 * `?url` 引入，`stationAirport` 从本站 `lib/atc.ts` 取（逐字相同），多一个测试用的
 * `useAirportCodes`；没搬 `fieldCandidates`（这个站没有机场卡要它）。这里只给
 * Extending 用：把扩出去的呼号落到一个 ICAO 上，再去 `airportCoords.ts` 查坐标。
 *
 * 北美的本场席位报三字代码而不是 ICAO：孟菲斯塔台是 `MEM_TWR`，不是 `KMEM_TWR`。
 * 而这张图别处认的全是 ICAO —— 飞行计划里写 `KMEM`，`airports.json` 按 ICAO 索
 * 引坐标，METAR 也按 ICAO 查。所以少了这一层，北美的机场卡从来就是空的：席位那
 * 一栏列得出来（它和标牌用的是同一个前缀），进离场、天气、坐标全部对不上，而三
 * 者都是「查不到就安静地不显示」，于是看上去像那个机场此刻没有航班。
 *
 * 对照表出自 VATSpy.dat 的 `[Airports]`（`IATA/LID` 那一列），编译进
 * `public/airport-codes.json`，见 `scripts/build-vatspy.mjs`。判据照
 * vatsim-radar 的 `realIata` / `iata` 两层（`app/composables/render/update/atc.ts`）。
 */
import AIRPORT_CODES_URL from "@/basemap/atc/airport-codes.json?url";
import { stationAirport } from "@/lib/atc";

export interface AirportCodes {
  /** 生成这份表所用的 VATSpy 上游 commit。 */
  version: string;
  /** 真机场行上的代码：`MEM` → `KMEM`。 */
  real: Record<string, string>;
  /** `IsPseudo=1` 行上的代码：`YYZ` → `CYYZ`，但也包括 `SCT` → `KLAX`。 */
  pseudo: Record<string, string>;
}

let table: AirportCodes | null = null;
let request: Promise<AirportCodes | null> | null = null;

/** 取一次对照表，进程内只取一次。失败返回 null —— 前缀原样通过，就是修好之前的样子。 */
export async function loadAirportCodes(): Promise<AirportCodes | null> {
  if (table) return table;

  request ??= fetch(AIRPORT_CODES_URL)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((data: AirportCodes | null) => {
      if (data?.real) table = data;
      return table;
    });

  return request;
}

/** 直接装一份表，不走网络。测试用。 */
export function useAirportCodes(data: AirportCodes | null): void {
  table = data;
}

/** 已经取到的那份表，还没取到就是 null。 */
export function loadedAirportCodes(): AirportCodes | null {
  return table;
}

/**
 * 这个席位坐在哪个机场，写成 ICAO。
 *
 * `allowPseudo` 是**本场席位（放行/地面/塔台/通播）才给的**。VATSpy 把机场的备
 * 用写法放在 `IsPseudo=1` 的行上，多伦多的 `YYZ` 就在那儿 —— 塔台认得出它是好
 * 事。但同一批假行里还混着**进近的代码**：`SCT` 挂在 KLAX 上、`NCT` 挂在 KSFO
 * 上。南加进近管的是一整片终端区，把它的标牌写成「KLAX」是错的，所以进近只查真
 * 的那张表。
 *
 * 认不出来就原样返回 —— 中国的席位（`ZSSS_TWR`）第一段本来就是 ICAO，压根不进
 * 这张表。
 */
export function stationField(callsign: string, allowPseudo: boolean): string {
  const prefix = stationAirport(callsign);
  if (!table) return prefix;
  const pseudo = allowPseudo ? table.pseudo[prefix] : undefined;
  return table.real[prefix] ?? pseudo ?? prefix;
}
