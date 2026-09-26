/**
 * 航路在图上的几何：一条腿一条大圆弧线，一个点一个点要素。
 *
 * 从 RouteMap.vue 搬出来，因为它是纯计算，而它错了不会被屏幕出卖：一条被丢掉的
 * 腿只是图上少一截线，剩下的看起来都对（见 routeLines 上面那段）。
 */
import type { Feature, FeatureCollection } from "geojson";
import { arc, type LatLon } from "@/lib/geo";
import { legKey } from "@/lib/airways";

export interface RoutePoint {
  ident: string;
  lat: number;
  lon: number;
  kind: number | string;
  via?: string;
  /** 见 mapBus 的 MapPoint。 */
  shape?: boolean;
  offPath?: boolean;
  /**
   * 这个点属于**当前这条航路**，而不是背景里那批彼此无关的点。
   *
   * 不来自事件载荷 —— `render()` 在把 points 和 markers 并进同一个 source 时打
   * 上去的。分开是因为标注只该跟着航路走：markers 里可能是全国几百个机场，给它
   * 们都标上名字就是一团糊。
   */
  onRoute?: boolean;
}

/**
 * 航路线：相邻两点之间走大圆弧。
 *
 * **已经在航路网上点亮了的那些腿不画。** 那正是「不要另加元素」的做法：沿航路飞的
 * 部分由航段本身高亮表达，这一层只补上**没有航路可点亮**的那些 —— DCT、SID/STAR，
 * 以及航段虽然在计划里、却不在当前这份航路集合里的（图层关着、被高低空过滤掉、端
 * 点解析不出坐标）。
 *
 * `suppressed` 是**真正标到的那些键**，不是「有 via 的那些」。这个区别是要紧的：假
 * 设有 via 就一定被点亮了的话，没点上的腿会从图上消失，而**航路断在中间看不出来**
 * —— 剩下的线本身都对。
 */
/**
 * 计划的每条腿画成一条线。
 *
 * **`onAirway` 的那几条腿仍然在这份集合里**，只是在航路网接手的缩放级上被压成透明
 * （见 `route` / `route-casing` 的 `line-opacity`）。
 *
 * 从前是直接 `continue` 把它们**整条丢掉**，理由是「航路网会点亮它，别画两条」。
 * 那句话只在航路网出现之后（`ZOOM.airwaysHigh`）成立。缩到全国视野（一条
 * ZBAA→ZGGG 的计划正好要 z4）之后航路网整层不画，而这几条腿已经被丢掉了，于是**谁
 * 都不画**：计划线上出现几个洞，剩下的直飞段和程序段照旧画着，看起来完全正常。
 *
 * `markRouteOnAirways` 的文档里数过三种「点不亮」（图层关着、被高低空过滤掉、端点
 * 没坐标），并说「航路断在中间是看不出来的」。缩放是第四种，当时没数进去 —— 而它
 * 和前三种不同：前三种一旦成立就没有高亮可言，这一种是**同一条计划在不同缩放下
 * 时有时无**。
 *
 * 所以判断从「画不画」改成「谁来画」：交接由缩放决定，两边都在，永远只有一条可见。
 */
export function routeLines(
  points: RoutePoint[],
  onAirway?: Set<string> | null,
): FeatureCollection {
  const features: Feature[] = [];
  // 线只穿过真正飞经的点：旁切掉的角点（offPath）只留给标注。判「这条腿在不在航
  // 路网上」时比的是航路点代号，弯里插的几何点（shape）要越过，角点要算上。
  let prev: RoutePoint | null = null;
  let lastIdent = "";

  for (const point of points) {
    if (point.offPath) {
      lastIdent = point.ident;
      continue;
    }
    if (!prev) {
      prev = point;
      if (!point.shape) lastIdent = point.ident;
      continue;
    }
    const via = point.via;
    const handedOff = Boolean(
      via && onAirway?.has(legKey(via, lastIdent, point.ident)),
    );
    const from: LatLon = [prev.lat, prev.lon];
    const to: LatLon = [point.lat, point.lon];
    const seg = legSegment(prev, point);
    features.push({
      type: "Feature",
      // 一条腿的样式取自**它到达的那个点**：SID 的第一条腿属于 SID。这条规则和
      // can-radar 一致，改之前先看那边。到达机场的那一条例外，取出发点的。
      //
      // `via` 是走这条腿用的航路代号（不在航路上时是 `DCT`），拿来沿线标注 ——
      // 航图上就是这么读一条计划的：点、航路、点。
      properties: {
        procedure: seg === "route" ? 0 : 1,
        seg,
        via: point.via ?? "",
        // 这条腿在航路网上被点亮了 —— 高缩放交给那一层画，见上面那段。
        onAirway: handedOff ? 1 : 0,
      },
      geometry: {
        type: "LineString",
        coordinates: arc(from, to).map(([lat, lon]) => [lon, lat]),
      },
    });
    prev = point;
    if (!point.shape) lastIdent = point.ident;
  }
  return { type: "FeatureCollection", features };
}

/** 一条腿属于哪一段：`sid` / `star` / `approach` / `missed`（复飞）/ `route`（航路段）。 */
export type RouteSegment = "sid" | "star" | "approach" | "missed" | "route";

function segmentOf(p: RoutePoint): RouteSegment | null {
  return p.kind === "sid" ||
    p.kind === "star" ||
    p.kind === "approach" ||
    p.kind === "missed"
    ? p.kind
    : null;
}

export function legSegment(from: RoutePoint, to: RoutePoint): RouteSegment {
  if (to.kind === "airport") return segmentOf(from) ?? "route";
  return segmentOf(to) ?? "route";
}

export function pointFeatures(points: RoutePoint[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points
      .filter((p) => !p.shape)
      .map((p) => ({
        type: "Feature",
        properties: {
          ident: p.ident,
          airport: p.kind === "airport" ? 1 : 0,
          // 是不是**这条航路上**的点。markers 这个 source 里同时装着航路的点和
          // 一批彼此无关的点（比如全国机场），只有前者该被标名字 —— 给几百个机场
          // 都标上名字就是一团糊。
          onRoute: p.onRoute ? 1 : 0,
        },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      })),
  };
}
