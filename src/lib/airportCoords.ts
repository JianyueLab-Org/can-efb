/**
 * 机场坐标表，`{ "ZBAA": [lat, lon] }`。
 *
 * 取自 can-radar 的 `src/lib/airports.ts`，数据是它 `public/airports.json` 的拷贝
 * （VATSpy，can-web 的 `build-airports.mjs` 生成）。这个站的机场资料走 can-db，要
 * 登录和汇编权限；这一份只给在线管制的 Extending 标牌定位，和 can-radar 用同一张表，
 * 两个站的标牌因此落在同一个点上。
 *
 * 文件名不叫 `airports.ts`：那是本站 can-db 机场图层那一份。
 */
import AIRPORTS_URL from "@/basemap/atc/airports.json?url";
import type { LatLon } from "@/lib/geo";

export type AirportTable = Record<string, LatLon>;

let airports: AirportTable | null = null;
let request: Promise<AirportTable> | null = null;

/** 取一次，进程内只取一次。失败给空表 —— Extending 的标牌不出，别的照常。 */
export async function loadAirportCoords(): Promise<AirportTable> {
  if (airports) return airports;

  request ??= fetch(AIRPORTS_URL)
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}))
    .then((data: AirportTable) => {
      airports = data ?? {};
      return airports;
    });

  return request;
}

/** 已经取到的那份表，还没取到就是 null。 */
export function loadedAirportCoords(): AirportTable | null {
  return airports;
}

/** 某个 ICAO 的坐标，表没取到或查不到就是 null。 */
export function airportAt(icao: string | undefined | null): LatLon | null {
  if (!icao) return null;
  return airports?.[icao.trim().toUpperCase()] ?? null;
}
