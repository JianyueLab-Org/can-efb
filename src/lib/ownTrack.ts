/**
 * 自己那架飞机的航迹，**在浏览器里攒**，只活在这一次会话。
 *
 * 来源是实时那层每 30 秒一次的 datafeed 轮询（`MapSurface.vue`），不是
 * `/api/v1/track`：那条在本站反代的白名单里是**特意排除**的，理由写在那份文件里。
 * 代价是航迹只从打开页面那一刻开始，采样间隔 30 秒。
 *
 * 三种情况重新开始一条：换了呼号（重新连线）、两次之间断得太久、两次之间的位置
 * 跳得不像飞过去的（换了机场重新连线、模拟器里瞬移）。三条都不接：接上就是一条从
 * 旧位置直通新位置的假航迹。
 */
import type { FeatureCollection } from "geojson";
import { distanceNm } from "@/lib/geo";

export interface TrackFix {
  callsign: string;
  lat: number;
  lon: number;
  /** 毫秒时间戳。 */
  at: number;
}

export interface OwnTrack {
  callsign: string;
  /** `[lon, lat]`，GeoJSON 的顺序。 */
  coords: [number, number][];
  lastAt: number;
}

export const TRACK_LIMITS = {
  /** 最多留这么多个点，30 秒一个约六小时。超出丢最旧的。 */
  maxPoints: 720,
  /** 两次之间超过这么久（毫秒）就重新开始。三次轮询没回来就算断了。 */
  maxGapMs: 3 * 60_000,
  /** 两次之间的平均地速超过这个（节）就当成瞬移。 */
  maxSpeedKt: 1200,
} as const;

/**
 * 加一个点，返回新的航迹（不改传进来的那个 —— 地图靠引用判断要不要重传）。
 *
 * 位置没动（停在机位上）不加点，只更新时间：否则停一小时攒一百二十个同一点。
 */
export function appendTrack(
  track: OwnTrack | null,
  fix: TrackFix,
  limits: {
    maxPoints: number;
    maxGapMs: number;
    maxSpeedKt: number;
  } = TRACK_LIMITS,
): OwnTrack {
  const start = (): OwnTrack => ({
    callsign: fix.callsign,
    coords: [[fix.lon, fix.lat]],
    lastAt: fix.at,
  });
  if (!track || track.callsign !== fix.callsign || !track.coords.length) {
    return start();
  }
  const dt = fix.at - track.lastAt;
  if (dt > limits.maxGapMs || dt < 0) return start();

  const [lastLon, lastLat] = track.coords[track.coords.length - 1];
  if (lastLon === fix.lon && lastLat === fix.lat) {
    return { ...track, lastAt: fix.at };
  }
  const nm = distanceNm([lastLat, lastLon], [fix.lat, fix.lon]);
  const hours = Math.max(dt, 1) / 3_600_000;
  if (nm / hours > limits.maxSpeedKt) return start();

  const coords = [...track.coords, [fix.lon, fix.lat] as [number, number]];
  if (coords.length > limits.maxPoints) {
    coords.splice(0, coords.length - limits.maxPoints);
  }
  return { callsign: track.callsign, coords, lastAt: fix.at };
}

/** 航迹画成一条线。不到两个点没有线可画，给空集合。 */
export function toTrackLine(track: OwnTrack | null): FeatureCollection {
  if (!track || track.coords.length < 2) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { callsign: track.callsign },
        geometry: { type: "LineString", coordinates: track.coords },
      },
    ],
  };
}
