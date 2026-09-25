/**
 * 机场地面：放大之后画在跑道周围的那些要素。
 *
 * ## 一份数据
 *
 * can-db 只有一份地面：扇区包手工做的要素（滑行道、机位、等待位置、机坪、航站
 * 楼、跑道），源自 OSM，由 Ground 仓库维护。一多半滑行道带代号，米级。
 *
 * ## 署名不是可选项
 *
 * 数据是 ODbL，画了地面就**必须**显示署名。can-db 在 `attribution` 里给出那一
 * 句；它缺席时用 `GROUND_ATTRIBUTION` 兜底。
 */
import type { Feature, FeatureCollection } from "geojson";
import { aipScope, dbFetch } from "@/lib/naip";

/** 地面要素。`points` 是 [纬, 经]，**可能只有一个点**。 */
export interface GroundFeature {
  kind: string;
  name?: string;
  widthM?: number;
  points: [number, number][];
}

export interface Ground {
  icao: string;
  features: GroundFeature[];
  /** ODbL 要求的署名。有地面就有，必须显示。 */
  attribution: string;
}

/** can-db 没给 `attribution` 时用的署名。 */
export const GROUND_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/**
 * 放大到这一级才去取地面。
 *
 * **门槛存在的理由是流量，不是观感。** 地面按机场取，每个场是一整份几何；在看得
 * 见半个中国的比例尺上取它，既画不出东西也白花流量。
 *
 * z9 上一个四公里的机场占十六个像素 —— **轮廓读得出，滑行道是一团**。放在这里是因
 * 为「早一点看到」比「每一条线都清楚」更要紧：真要看清滑行道，那个尺度本来也已经凑
 * 得很近了。
 *
 * **代价要说清楚，因为它是可见的。** 这一份是按机场取的数据，而 z9 的视野有三百
 * 公里宽、十几个机场 —— 只取最近的几个（见
 * `GROUND_MAX_AIRPORTS`），其余机场那一刻没有地面。
 *
 * 那**不会看起来像坏了**，因为跑道是另一条路来的：`lib/runways.ts` 那份整库 34 kB
 * 的权威数据覆盖全部 415 个机场，从 z7 起就画。所以远处的机场仍然有跑道，只是没有
 * 滑行道 —— 一个合理的细节梯度，而不是一片空白。
 */
export const GROUND_MIN_ZOOM = 9;

/**
 * 一次最多同时取几个机场的地面。
 *
 * 视野里可能同时有好几个场，每个都是一整份几何。按离视野中心的距离排，只取最近的
 * 几个 —— 边上那个没画出来，比整张图卡住好。取回来的会缓存，所以平移过去时它才补上。
 *
 * 门槛提早到 z9 之后从 3 提到 4：那个尺度的视野宽了一倍，三个显得太薄。**没有提得更
 * 多**，因为每多一个就是多一份几何，而远处的机场本来就有跑道可看（见 GROUND_MIN_ZOOM）。
 */
export const GROUND_MAX_AIRPORTS = 4;

/** 键带 `aipScope()`：隐藏 NAIP 的开关一变，旧那份就不能再被命中。 */
const cache = new Map<string, Ground | null>();

/**
 * 取一个机场的地面。**结果按 ICAO 缓存，包括「没有」。**
 *
 * 缓存 null 是重点：没有地面数据的机场 can-db 回 404，而地图一直在动 —— 不记住
 * "这个场没有"，每次平移回来都会再问一次，问出同一个空答案。
 */
export async function fetchGround(icao: string): Promise<Ground | null> {
  const key = icao.toUpperCase();
  const cacheKey = `${aipScope()}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  let out: Ground | null = null;
  try {
    const response = await dbFetch(`aip/airports/${key}/ground`);
    if (response.ok) {
      const body = await response.json();
      /* 拆信封。can-db 大部分接口包着 `{status, data}`，少数裸奔 —— 两种都收，和
         `unwrapList` 同一个约定，只是这一条返回的是对象不是列表，所以不能用它。 */
      const data = ((body as { data?: unknown })?.data ?? body) as
        | Ground
        | undefined;
      if (data?.features?.length) {
        out = {
          icao: key,
          features: data.features,
          attribution: data.attribution || GROUND_ATTRIBUTION,
        };
      }
    }
    // 404 是「这个场没有地面数据」，是答案不是故障，和上面 out = null 同一条路。
  } catch {
    /* 取不到就当没有。地面是叠加物，它缺席不该让整张图报错 —— 而一个反复重试的
       图层在拖动地图时会把失败放大成一串失败。下次视野再进来时自然会重试，因为
       失败不写缓存。 */
    return null;
  }

  cache.set(cacheKey, out);
  return out;
}

export interface GroundDrawing {
  collection: FeatureCollection;
  /** 参与了这张图的机场，按 ICAO。 */
  icaos: string[];
  /** 要显示的署名，去重后的。画了要素就不为空。 */
  attributions: string[];
}

/** 把若干个机场的地面并成一份可画的 GeoJSON。 */
export function toGroundDrawing(grounds: Ground[]): GroundDrawing {
  const features: Feature[] = [];
  const icaos: string[] = [];
  const attributions = new Set<string>();

  for (const g of grounds) {
    icaos.push(g.icao);
    let drawn = false;
    for (const f of g.features) {
      const geom = geometryFor(f.points);
      if (!geom) continue;
      drawn = true;
      features.push({
        type: "Feature",
        geometry: geom,
        properties: {
          icao: g.icao,
          kind: f.kind,
          name: f.name ?? "",
          widthM: widthMetres(f.kind, f.widthM),
        },
      });
    }
    if (drawn) attributions.add(g.attribution || GROUND_ATTRIBUTION);
  }

  return {
    collection: { type: "FeatureCollection", features },
    icaos,
    attributions: [...attributions],
  };
}

/* 跑道号从前在这里从几何里推：取相距最远的两个顶点当两端、按方位角分配代号，外加
 * 同名要素去重。**整套删掉了** —— can-db 的 `/aip/runways` 按端给权威入口坐标，见
 * `lib/runways.ts`。那套推算暴露过它自己的一类错：同一条跑道在源数据里可能是好几个
 * 同名要素，每个都被标了两头，跑道号于是在图上出现两次、其中一对落在离真入口几百米
 * 的地方。 */

/**
 * 这一类地面要素画多宽，**米**。
 *
 * 源数据里宽度常常缺（多数机位和等待位置没有），而缺席不能当成 0 —— 线宽
 * 是按真实米数换算成像素的，0 米出来就是一条画不出来的线。所以按类别给一个典型值：
 * 跑道 45、滑行道 23、机坪和航站楼当面状物给宽一点、其余按滑行道。
 *
 * 这些是**画图用的排版数字，不是航行数据**，所以放在这一层而不是往库里写。真实宽
 * 度只要有就一定优先用。
 */
function widthMetres(kind: string, published?: number): number {
  if (published && published > 0) return published;
  switch (kind) {
    case "runway":
      return 45;
    case "apron":
    case "terminal":
      return 30;
    case "parking_position":
      return 12;
    case "holding_position":
      return 6;
    default:
      return 23;
  }
}

/**
 * [纬, 经] 的点串 → GeoJSON 几何。**GeoJSON 是 [经, 纬]**，反了不会报错，只会把
 * 机场画到地球另一边。
 *
 * 单点要素是真实存在的（等待位置和一部分机位本来就是一个点，扇区包里有 733
 * 个），所以一个点出 Point 而不是丢掉 —— 丢掉它们等于把所有等待位置从图上抹去。
 */
function geometryFor(points: [number, number][]) {
  if (!points?.length) return null;
  if (points.length === 1) {
    return {
      type: "Point" as const,
      coordinates: [points[0][1], points[0][0]],
    };
  }
  return {
    type: "LineString" as const,
    coordinates: points.map(([lat, lon]) => [lon, lat]),
  };
}
