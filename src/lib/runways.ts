/**
 * 全库跑道，画在图上的那一层。
 *
 * ## 为什么它不来自地面数据
 *
 * 地面要素里也有跑道，但那一份的跑道号是**推出来的**：拿名字（`18L/36R`）拆成两个
 * 代号，取相距最远的两个顶点当两端，再按方位角决定哪一头写哪个号。那套推算有它自
 * 己的一类错 —— 同一条跑道在源数据里可能是好几个同名要素（ZBTJ 有两个 `16R/34L`，
 * 一个全长、一个北头 350 米的短段），每个都被标了两头。
 *
 * can-db 的 `/aip/runways` 按**端**给：`18L` 和 `36R` 是两行，各自带着自己那一头的
 * **入口坐标**。跑道号标在哪一头因此是权威数据，不是推的。整份 966 条、约 34 kB。
 *
 * ## 为什么整份取，不按视野
 *
 * 缩放阶梯要在比例尺 20 公里那一档（约 z9）就画出跑道，而那个视野有三百公里宽、里
 * 面十几个机场。按机场取要么发十几个请求，要么只取几个 —— 而后者在图上看起来是
 * 「其余那些机场不存在」。34 kB 整份给，一次取完，出不出现交给图层的 minzoom。
 */
import type { FeatureCollection } from "geojson";

export interface NetworkRunway {
  icao: string;
  ident: string;
  /** 这一头的入口。跑道号就标在这儿。 */
  lat: number;
  lon: number;
  /** 另一头。一行就够画出整条跑道。 */
  endLat: number;
  endLon: number;
  hdg: number | null;
}

let pending: Promise<NetworkRunway[]> | null = null;
let loaded: NetworkRunway[] | null = null;

/**
 * 取全库跑道，整趟会话只取一次。
 *
 * 并发也只取一次 —— 记住那个 Promise 而不是结果，才挡得住「地图连着触发几次视野
 * 变化」那段窗口。失败不写 `loaded`，所以下次还会重试。
 */
export async function fetchRunways(): Promise<NetworkRunway[]> {
  if (loaded) return loaded;
  if (pending) return pending;

  pending = (async () => {
    try {
      const response = await fetch("/api/db/aip/runways");
      if (!response.ok) return [];
      const body = await response.json();
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { data?: unknown })?.data)
          ? ((body as { data: unknown[] }).data as unknown[])
          : [];
      const out: NetworkRunway[] = [];
      for (const r of rows as Record<string, unknown>[]) {
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        const endLat = Number(r.endLat);
        const endLon = Number(r.endLon);
        if (![lat, lon, endLat, endLon].every(Number.isFinite)) continue;
        out.push({
          icao: String(r.icao ?? "").toUpperCase(),
          ident: String(r.ident ?? ""),
          lat,
          lon,
          endLat,
          endLon,
          hdg: r.hdg == null ? null : Number(r.hdg),
        });
      }
      loaded = out;
      return out;
    } catch {
      return [];
    } finally {
      pending = null;
    }
  })();

  return pending;
}

/**
 * 跑道 → 线要素加端点要素。
 *
 * **线会画两遍**（`18L` 一行、`36R` 一行，同一条跑道的两个方向），这是有意的：去重
 * 要按「哪两行是一对」判断，而 `opposite` 未必总是填的；而两条完全重合的线在图上和
 * 一条没有区别，代价只是 966 条而不是 483 条 —— 那点开销远小于一次判断错。
 *
 * 端点要素带 `ident`，标注层用它，**位置来自权威入口坐标**。
 */
export function toRunwayFeatures(runways: NetworkRunway[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      ...runways.map((r) => ({
        type: "Feature" as const,
        geometry: {
          type: "LineString" as const,
          coordinates: [
            [r.lon, r.lat],
            [r.endLon, r.endLat],
          ],
        },
        properties: { kind: "runway", icao: r.icao, ident: r.ident },
      })),
      ...runways.map((r) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [r.lon, r.lat] },
        properties: { kind: "runway_end", icao: r.icao, ident: r.ident },
      })),
    ],
  };
}
