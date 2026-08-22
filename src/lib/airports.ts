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
export interface AirportPin {
  icao: string;
  name: string | null;
  lat: number;
  lon: number;
}

let pending: Promise<AirportPin[]> | null = null;
let loaded: AirportPin[] | null = null;

/**
 * 取机场索引，整趟会话只取一次。
 *
 * **并发也只取一次**：地图 `moveend` 会连着触发，如果每次都发一个请求，第一次放
 * 大就会同时飞出去五六个一样的请求。记住那个 Promise 而不是记住结果，才挡得住这
 * 一段窗口。
 */
export async function fetchAirportPins(): Promise<AirportPin[]> {
  if (loaded) return loaded;
  if (pending) return pending;

  pending = (async () => {
    try {
      const response = await fetch("/api/db/aip/airports");
      if (!response.ok) return [];
      const body = await response.json();
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown })?.data)
          ? ((body as { data: unknown[] }).data as unknown[])
          : [];
      const out: AirportPin[] = [];
      for (const r of rows as Record<string, unknown>[]) {
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        out.push({
          icao: String(r.icao ?? "").toUpperCase(),
          name: (r.name as string) ?? null,
          lat,
          lon,
        });
      }
      loaded = out;
      return out;
    } catch {
      /* 失败不写 `loaded`，所以下一次视野变化会再试。但要清掉 `pending`，否则这
         一个失败的 Promise 会被永远返回下去 —— 图层从此再也不会恢复。 */
      return [];
    } finally {
      pending = null;
    }
  })();

  return pending;
}

/**
 * 视野里的机场，按离视野中心由近及远。
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
  return pins
    .filter(
      (p) =>
        p.lat >= v.south &&
        p.lat <= v.north &&
        p.lon >= v.west &&
        p.lon <= v.east,
    )
    .sort(
      (a, b) =>
        (a.lat - cLat) ** 2 +
        (a.lon - cLon) ** 2 -
        ((b.lat - cLat) ** 2 + (b.lon - cLon) ** 2),
    );
}
