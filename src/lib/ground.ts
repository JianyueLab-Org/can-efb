/**
 * 机场地面：放大之后画在跑道周围的那些线。
 *
 * ## 两份数据，画一份
 *
 * can-db 一次返回两样东西，强弱互补（它的 AGENTS.md 里有整张对照表）：
 *
 *   - `features` —— **分好类**的地面要素（滑行道、机位、等待位置、机坪、航站楼、
 *     跑道），一多半滑行道带代号，米级。来自扇区包手工做的那份或 OSM。
 *   - `lines` —— 从汇编航图上抠下来的线画，**没有语义也没有名字**，只有颜色和线
 *     宽，位置 5–20 米。跟着 AIRAC 走，而且是 3 级才可见的受限材料。
 *
 * **这里只画其中一份，有 `features` 就不画 `lines`。** 两份都画看着"信息更多"，
 * 实际是把同一条滑行道画两遍、位置差十几米 —— can-db 自己在合并 `ground_feature`
 * 的两个来源时就拒绝过这件事（「混起来会让同一条滑行道出现两遍、位置还差几米，那
 * 比少一份糟」），画在图上是同一个道理，而且更刺眼：两条几乎重合又不完全重合的
 * 线，读图的人无法判断该信哪条。
 *
 * 优先 `features`：它知道自己是什么，位置也更准。只有一条 `features` 都没有时才
 * 退到 `lines`，那时精度用 `accuracyM` 说明。
 *
 * ## 署名不是可选项
 *
 * `attribution` 有值就**必须**显示出来 —— OSM 的数据是 ODbL，署名是许可条款而不
 * 是礼貌。它由数据决定（只有真的用了 OSM 的机场才有值），所以不能写死一句挂在图
 * 上：那会让纯扇区包的机场挂一个错误的出处。反过来漏掉它则是违反许可。
 *
 * 汇编那一份的规矩正好相反 —— **来源不能外露**，所以 `lines` 这边一个字都不提。
 */
import type { Feature, FeatureCollection } from "geojson";

/** 手工/OSM 做的地面要素。`points` 是 [纬, 经]，**可能只有一个点**。 */
export interface GroundFeature {
  kind: string;
  source: string;
  name?: string;
  widthM?: number;
  points: [number, number][];
}

/** 航图上抠出来的线。`rgb` 是**图上的原色**，不是语义。 */
export interface GroundLine {
  rgb: string;
  widthM: number;
  kind?: string;
  points: [number, number][];
}

export interface Ground {
  icao: string;
  features: GroundFeature[];
  lines: GroundLine[];
  /** ODbL 要求的署名，只有用了 OSM 的机场才有。有就必须显示。 */
  attribution?: string;
  /** 这批线该信到几米。**不是**残差 —— 跑道核对过的 5 米，没核对过的 20 米。 */
  accuracyM: number;
  /** 有几条跑道核对过配准。0 表示没核对上，那时 accuracyM 是个保守下限。 */
  runways: number;
}

/**
 * 放大到这一级才去取地面。
 *
 * **门槛存在的理由是流量，不是观感。** 首都一张图是五千多条线、两万多个点，一兆
 * 多的几何；在看得见半个中国的比例尺上取它，既画不出东西也白花那一兆。
 *
 * z9 上一个四公里的机场占十六个像素 —— **轮廓读得出，滑行道是一团**。放在这里是因
 * 为「早一点看到」比「每一条线都清楚」更要紧：真要看清滑行道，那个尺度本来也已经凑
 * 得很近了。
 *
 * **代价要说清楚，因为它是可见的。** 这一份是按机场取的重数据（首都一张图五千多条
 * 线、一兆多），而 z9 的视野有三百公里宽、十几个机场 —— 只取最近的几个（见
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
 * 视野里可能同时有好几个场，而每个都是兆级的几何。按离视野中心的距离排，只取最近的
 * 几个 —— 边上那个没画出来，比整张图卡住好。取回来的会缓存，所以平移过去时它才补上。
 *
 * 门槛提早到 z9 之后从 3 提到 4：那个尺度的视野宽了一倍，三个显得太薄。**没有提得更
 * 多**，因为每多一个就是多一兆，而远处的机场本来就有跑道可看（见 GROUND_MIN_ZOOM）。
 */
export const GROUND_MAX_AIRPORTS = 4;

const cache = new Map<string, Ground | null>();

/**
 * 取一个机场的地面。**结果按 ICAO 缓存，包括「没有」。**
 *
 * 缓存 null 是重点：多数机场根本没有地面数据（432 个里有地面的是全部，但级别不够
 * 的成员拿到的 `lines` 是空的），而地图一直在动 —— 不记住"这个场没有"，每次平移
 * 回来都会再问一次，问出同一个空答案。
 */
export async function fetchGround(icao: string): Promise<Ground | null> {
  const key = icao.toUpperCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let out: Ground | null = null;
  try {
    const response = await fetch(`/api/db/aip/airports/${key}/ground`);
    if (response.ok) {
      const body = await response.json();
      /* 拆信封。can-db 大部分接口包着 `{status, data}`，少数裸奔 —— 两种都收，和
         `unwrapList` 同一个约定，只是这一条返回的是对象不是列表，所以不能用它。 */
      const data = ((body as { data?: unknown })?.data ?? body) as
        | Ground
        | undefined;
      if (data && (data.features?.length || data.lines?.length)) {
        out = {
          icao: key,
          features: data.features ?? [],
          lines: data.lines ?? [],
          attribution: data.attribution || undefined,
          accuracyM: data.accuracyM ?? 0,
          runways: data.runways ?? 0,
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

  cache.set(key, out);
  return out;
}

/** 这个机场画的是哪一份。UI 要据此决定说不说精度、说不说署名。 */
export type GroundKind = "features" | "lines";

export interface GroundDrawing {
  collection: FeatureCollection;
  /** 画的是哪一份 —— `lines` 时位置只能信到 accuracyM。 */
  kind: GroundKind;
  /** 参与了这张图的机场，按 ICAO。 */
  icaos: string[];
  /** 要显示的署名，去重后的。空数组就是不用显示。 */
  attributions: string[];
  /** 画了 `lines` 的那些机场里最差的那个精度，米。画 features 时是 0。 */
  worstAccuracyM: number;
}

/**
 * 把若干个机场的地面并成一份可画的 GeoJSON。
 *
 * **逐个机场决定画哪一份**，不是整批二选一：视野里可能一个场有手工要素、另一个只
 * 有航图线画。按机场分别处理，两个场各自画自己最好的那一份。
 */
export function toGroundDrawing(grounds: Ground[]): GroundDrawing {
  const features: Feature[] = [];
  const icaos: string[] = [];
  const attributions = new Set<string>();
  let anyLines = false;
  let worst = 0;

  for (const g of grounds) {
    icaos.push(g.icao);

    if (g.features.length) {
      // 有分好类的就用它，`lines` 整份不画 —— 见文件头。
      for (const f of g.features) {
        const geom = geometryFor(f.points);
        if (!geom) continue;
        features.push({
          type: "Feature",
          geometry: geom,
          properties: {
            icao: g.icao,
            kind: f.kind,
            name: f.name ?? "",
            widthM: widthMetres(f.kind, f.widthM),
            // 画 features 时颜色由 kind 决定，交给图层的 match 表达式。
            source: f.source,
          },
        });
      }
      if (g.attribution) attributions.add(g.attribution);
      continue;
    }

    for (const l of g.lines) {
      const geom = geometryFor(l.points);
      if (!geom) continue;
      anyLines = true;
      features.push({
        type: "Feature",
        geometry: geom,
        properties: {
          icao: g.icao,
          // 航图那份没有语义，所以**用图上的原色**，不硬派一个含义上去。
          rgb: l.rgb,
          widthM: l.widthM,
          kind: l.kind ?? "",
        },
      });
    }
    if (anyLines) worst = Math.max(worst, g.accuracyM);
  }

  return {
    collection: { type: "FeatureCollection", features },
    kind: anyLines ? "lines" : "features",
    icaos,
    attributions: [...attributions],
    worstAccuracyM: worst,
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
 * 源数据里宽度常常缺（手工那份多数机位和等待位置没有），而缺席不能当成 0 —— 线宽
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
 * 单点要素是真实存在的（等待位置和一部分机位本来就是一个点，扇区包那份里有 733
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
