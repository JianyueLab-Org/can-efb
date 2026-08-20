import type { MapPoint } from "@/lib/mapBus";

/**
 * 航路生成：从 A 到 B 该怎么飞。数据来自 **can-db 的 `/api/v1/aip/route`**。
 *
 * 和这个站原有的「航路展开」不是一回事，两者都保留：
 *
 *   展开  can-api `/api/v1/route`      「这串航路字符串对应哪些点」—— 已经有一条计划了
 *   生成  can-db  `/api/v1/aip/route`  「这两个机场之间该怎么飞」—— 还没有计划
 *
 * 规划逻辑在 can-db（`internal/aip/route.go`），这边一行都不重写 —— 它是关于那批
 * 数据的规则，不是渲染。
 */

/** 一跳。`airway` 是航路代号，不在航路上时是 `"DCT"`。 */
export interface RouteLeg {
  airway: string;
  from: string;
  to: string;
  /** **到达点**的坐标 —— 起点不在腿里，见 RoutePlan.fromLat 的说明。 */
  lat: number;
  lon: number;
  distanceKm: number;
}

/** 沿途命中的一条限制。**是散文，不是规则** —— 界面只负责把原文摆出来。 */
export interface RouteRestriction {
  code: string | null;
  body: string;
  /** "segment"（真正飞的那一段命中）或 "airway"（只是同一条航路）。 */
  scope?: string;
}

export interface RouteAirspace {
  name: string | null;
  code: string | null;
  localType: string | null;
  activeTime: string | null;
  lowerM: number | null;
  upperM: number | null;
}

export interface RoutePlan {
  from: string;
  to: string;
  /** 可以直接填的航路字符串：SID + 航路和航路点 + STAR。 */
  route: string;
  legs: RouteLeg[];
  /** 沿航路飞的距离，不是大圆。 */
  distanceKm: number;
  /** 两机场之间的大圆距离 —— 用来看航路网多绕了多少。 */
  directKm: number;

  /**
   * `"published"` = 汇编自己发布了这对城市的走法，这就是那个走法；
   * `"computed"`  = 我们在航路图上算出来的最短路径。
   *
   * **这两者不是同一种答案**，界面必须让人分得清：一个是汇编说该怎么飞，另一个是
   * 我们算出来的。can-db 的注释里专门写了这一条。
   */
  source: "published" | "computed";

  /** 汇编自己印的总里程，**只覆盖航路段**（入航路点到出航路点），不是机场到机场。 */
  publishedDistanceKm?: number;
  publishedName?: string;
  /** 汇编的原文走法描述。 */
  routing?: string;
  /** 汇编发布的最低安全高度，**米**。 */
  minSafeAltM?: number;
  /** 同一对城市还有几条已发布的走法。 */
  alternatives?: number;

  sid: string;
  star: string;

  /** 两端机场的坐标 —— 腿里只有到达点，起点必须从这里取。 */
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;

  restrictions: RouteRestriction[];
  airspaces: RouteAirspace[];

  /** 全程最高的最低超障高度，**米**；汇编没发布就是 0。 */
  mtcaM?: number;
  /** 请求的巡航高度低于上面那个值。**这是安全提示，不是样式。** */
  levelBelowMtca?: boolean;

  /** 规划器每一次降级的记录，按发生顺序。 */
  notes?: string[];
}

export class RoutePlanError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 生成航路。走本站的 can-db 反代。
 *
 * **400 和 404 是两种不同的答案**，调用方要做的事也不同 —— 前者是输入不对（改
 * 输入），后者是这对城市在这个高度上没有已发布/可达的走法（接受它）。can-db 那边
 * 特意把它们分开，这里就不该合并成一句「失败」。
 */
export async function planRoute(
  from: string,
  to: string,
  level?: number,
): Promise<RoutePlan> {
  const params = new URLSearchParams({ from, to });
  if (level && level > 0) params.set("level", String(level));

  const response = await fetch(`/api/db/aip/route?${params}`);
  const body = (await response.json().catch(() => ({}))) as {
    data?: RoutePlan;
    message?: string;
  } & RoutePlan;

  if (!response.ok) {
    throw new RoutePlanError(response.status, body.message ?? "");
  }
  return (body.data ?? body) as RoutePlan;
}

/**
 * 把一份航路计划转成地图上的点序列。
 *
 * **起点要从 `fromLat/fromLon` 取**：腿里只带到达点，只用腿画的话线会从入航路点
 * 开始 —— 目的机场在图上，出发机场不在。can-db 特意把两端坐标单独给出来就是为了
 * 这件事，别忽略它。
 */
export function planToMapPoints(plan: RoutePlan): MapPoint[] {
  const points: MapPoint[] = [
    { ident: plan.from, lat: plan.fromLat, lon: plan.fromLon, kind: "airport" },
  ];
  for (const leg of plan.legs) {
    points.push({
      ident: leg.to,
      lat: leg.lat,
      lon: leg.lon,
      kind: "fix",
      via: leg.airway,
    });
  }
  // 最后一跳到达的就是目的机场时不要重复摆一个点。
  const last = points[points.length - 1];
  if (last.ident !== plan.to) {
    points.push({
      ident: plan.to,
      lat: plan.toLat,
      lon: plan.toLon,
      kind: "airport",
    });
  }
  return points;
}
