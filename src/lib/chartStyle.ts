/**
 * 航图的整份样式：颜色、线宽、字号、图标尺寸、各类要素从哪一级缩放出现、空域的填
 * 充和斜线、标注的先后。**改地图外观只改这个文件**，`RouteMap.vue` 只读它。
 *
 * ## 怎么改
 *
 * - 颜色：`COLORS`，浅色和夜间**各写一份**，不做反色。语义色（航线的品红、禁区的
 *   红、RNAV 代号牌的蓝、情报区的绿）两套同一个色相，只调明度。浅色照 Jeppesen
 *   高低空航路图：白陆地、浅蓝海、低饱和。
 * - 出现时机：`ZOOM`。一个门槛只在这里写一次，取数门槛（`useChartLayers.ts`）也读它。
 * - 粗细和字号：`WIDTH` / `TEXT` / `ICON`。形如 `[[6, 0.7], [9, 1.4]]` 的是「缩放 →
 *   值」的锚点，中间线性插值，两头取端点值。
 * - 空域：`AIRSPACE`。
 * - 标注谁压谁：`buildStyle` 里图层的**顺序**。MapLibre 先放上面的图层，所以越靠后
 *   的标注优先级越高；同一层里再按 `symbol-sort-key` 排（小的先放）。
 *
 * ## 主题切换不靠清单
 *
 * `themedProperties(theme)` 把 `buildStyle(theme)` 里每个图层的每个 paint / layout
 * 属性都列出来，`RouteMap` 逐个对比、有变化才设。新加的图层自动跟着换主题 —— 以前
 * 是手写一份 `setPaintProperty` 清单，加层时漏登记过两次。
 *
 * ## 校验
 *
 * `bun run check:style` 把两套主题各建一次，交给 MapLibre 自己的校验器；
 * `chartStyle.test.ts` 钉住图层顺序、两套主题结构一致、引用的图片都有人注册。
 * 表达式写错在构建期不报错，只在浏览器里让整层不画，所以这两道必须过。
 */
import type { StyleSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";
import type { NavaidClass } from "@/lib/aip";
import { GROUND_MIN_ZOOM } from "@/lib/ground";
import { FACILITY_COLORS } from "@/lib/atc";
import { altitudeRamp } from "@/lib/traffic";

export type Theme = "light" | "dark";

// ---------------------------------------------------------------- 颜色

export interface ColorRoles {
  /* 底图。浅色是白陆地、浅蓝海；夜间是深灰，不是黑。 */
  ocean: string;
  land: string;
  landLine: string;
  /** 国界，虚线。 */
  border: string;
  grid: string;
  /** 经纬网的度数标注。 */
  gridLabel: string;
  /** 次要标注（地面代号）的文字。其余标注用各自要素的颜色。 */
  textMuted: string;
  /** 标注和符号的描边，取陆地色，让字从线上"挖"出来。 */
  halo: string;
  /* 航路按层级分：高空蓝灰、低空灰，线宽也不同。 */
  airwayHigh: string;
  airwayLow: string;
  /* 航路代号牌：RNAV 蓝底、常规深底（夜间浅底），字色各一。 */
  shieldRnav: string;
  shieldRnavText: string;
  shieldConv: string;
  shieldConvText: string;
  /** 计划航线。品红一族，和空域的红分开。 */
  route: string;
  routeCasing: string;
  /** 计划航线上的点和点名。 */
  marker: string;
  waypoint: string;
  navaid: string;
  ndb: string;
  airport: string;
  /* 空域。 */
  ctr: string;
  app: string;
  restricted: string;
  prohibited: string;
  danger: string;
  fir: string;
  mora: string;
  /* 自己那架和它的航迹。在线机组按高度色带（`lib/traffic.ts`），管制按席位色
   * （`lib/atc.ts`），都不在这里。 */
  own: string;
  ownTrack: string;
  /* 机场地面，放大后才有。 */
  groundRunway: string;
  groundTaxiway: string;
  groundApron: string;
  groundStand: string;
  groundHold: string;
}

export const COLORS: Record<Theme, ColorRoles> = {
  light: {
    ocean: "#dbeaf5",
    land: "#ffffff",
    landLine: "#a9bccb",
    border: "#b4bdc4",
    grid: "#c3d2de",
    gridLabel: "#6f8799",
    textMuted: "#5d6a73",
    halo: "#ffffff",
    airwayHigh: "#7890a8",
    airwayLow: "#a3aaaf",
    shieldRnav: "#1f63ad",
    shieldRnavText: "#ffffff",
    shieldConv: "#2b3035",
    shieldConvText: "#ffffff",
    // 计划航线：航电品红。深浅两套同色相，只调明度，和这张表别的语义色一个规矩。
    route: "#c8189f",
    routeCasing: "#ffffff",
    marker: "#5b1f6b",
    waypoint: "#3d4850",
    navaid: "#27435a",
    ndb: "#7b3f73",
    airport: "#1f6fbf",
    ctr: "#5f7f98",
    app: "#2f8a78",
    restricted: "#c2185b",
    prohibited: "#d32f2f",
    danger: "#ad1457",
    fir: "#3aa468",
    mora: "#3d7a48",
    own: "#b8860b",
    ownTrack: "#b8860b",
    groundRunway: "#4a5761",
    groundTaxiway: "#9aa6ae",
    groundApron: "#d3d9dd",
    groundStand: "#7f8b93",
    groundHold: "#c2185b",
  },
  dark: {
    ocean: "#16191c",
    land: "#1f2327",
    landLine: "#3b4249",
    border: "#4a535b",
    grid: "#30373d",
    gridLabel: "#7f8c97",
    textMuted: "#9aa5ad",
    halo: "#1f2327",
    airwayHigh: "#8ea3b6",
    airwayLow: "#6c757c",
    shieldRnav: "#3a74b5",
    shieldRnavText: "#f2f6fa",
    shieldConv: "#b9c1c8",
    shieldConvText: "#16191c",
    route: "#ff4fd8",
    routeCasing: "#16191c",
    marker: "#f0c9f7",
    waypoint: "#c3cbd1",
    navaid: "#c6d4df",
    ndb: "#d69bcb",
    airport: "#6aa9e6",
    ctr: "#86a5bd",
    app: "#5fc0aa",
    restricted: "#f06292",
    prohibited: "#ff6b6b",
    danger: "#f48fb1",
    fir: "#57b983",
    mora: "#6fbf7c",
    own: "#ffd166",
    ownTrack: "#ffd166",
    groundRunway: "#d0d7dc",
    groundTaxiway: "#7e8a93",
    groundApron: "#343b41",
    groundStand: "#9aa6ae",
    groundHold: "#f06292",
  },
};

// ---------------------------------------------------------------- 缩放门槛

/**
 * 各类要素从哪一级缩放开始画。**取数门槛也读这里**（`useChartLayers.ts` 的
 * `loadForZoom`），两边不会分叉。
 *
 * 照 Jeppesen 高低空航路图：比例尺 50 NM 左右（z5–6）就是整张航路网、每个点都有
 * 名字。放得下几个由 MapLibre 的避让决定，不靠门槛往后推。
 *
 * **写进 `filter` 的门槛必须是整数**（`airwaysLow`、`minorNavaids`、
 * `minorNavaidLabels`、`airportAll`、`airportAllLabels`、`runwayLines`）：filter 里
 * 的 `["zoom"]` 按瓦片的整数级求值，5.5 在 z5.9 上仍然不成立。`minzoom` 和 paint
 * 里的可以是小数。`chartStyle.test.ts` 钉着。
 */
export const ZOOM = {
  /** 细一档的国界从这里画，细节底图从这里开始取。 */
  borders: 4,
  /** 细一档的陆地从这里画，50m 海岸线到这里交棒。 */
  landDetail: 5,
  firLabels: 4,
  /** 经纬网：10° 一直画，5° 和 1° 从这两级加上。 */
  grid5: 4,
  grid1: 6,

  /** 主要机场（最长跑道 ≥ `MAJOR_AIRPORT_MIN_RUNWAY_M`）的符号。机场和跑道数据从这里开始取。 */
  airportMajor: 4,
  airportMajorLabels: 5,
  /** 其余机场的符号和代号。 */
  airportAll: 6,
  airportAllLabels: 6,
  /** 跑道线接替机场符号（有跑道数据的机场）。 */
  runwayLines: 9,
  runwayLabels: 11,

  /** 高空航路（高空和两层都有的）。计划航线在这一级把航路段交给航路网高亮。 */
  airwaysHigh: 4.5,
  /** 只属于低空的航路。 */
  airwaysLow: 6,
  /** 航路代号牌。计划航线的沿线代号在这一级交棒。 */
  airwayLabels: 5,

  /** VOR、VOR/DME、VORTAC、TACAN，符号和识别码。 */
  vor: 5,
  vorLabels: 5,
  /** 导航台标注从识别码换成「台名 D 频率 识别码」。 */
  navaidFullLabels: 7,
  /** NDB、单独的 DME、认不出的台。 */
  minorNavaids: 6,
  minorNavaidLabels: 6,
  /** 航路点（空心三角）和点名。 */
  waypoints: 5.5,
  waypointLabels: 5.5,

  airspaceLabels: 5,
  /** Grid MORA。一度格在 z5.5 是 64px，再小数字排不下，避让会丢掉一半格子。 */
  mora: 5.5,
  routeAirwayLabels: 4,
  atcAreaLabels: 4,
  trafficLabels: 7,
  /** 机场地面（`lib/ground.ts`）。 */
  ground: GROUND_MIN_ZOOM,
} as const;

/** 最长跑道不短于这么多米的机场算主要机场，低缩放下只画它们。 */
export const MAJOR_AIRPORT_MIN_RUNWAY_M = 2500;

// ---------------------------------------------------------------- 线宽、字号、图标

/** 缩放锚点：`[缩放, 值]`。 */
export type Stops = readonly (readonly [number, number])[];

export const WIDTH = {
  landOutline: 0.6,
  landDetailOutline: 0.7,
  border: 0.8,
  grid: 0.4,
  fir: 1.2,
  atcArea: 1.6,
  ctr: 0.9,
  /** 限制区、禁区、危险区的边线。 */
  sua: 1.5,
  /** 高空航路。和 `airwayOnRoute` 必须是同一组缩放锚点。 */
  airwayHigh: [
    [4.5, 0.5],
    [8, 0.9],
    [12, 1.6],
  ],
  /** 计划走过的航段，就地加粗。 */
  airwayOnRoute: [
    [4.5, 2.6],
    [8, 3.2],
    [12, 4],
  ],
  airwayLow: [
    [6, 0.5],
    [12, 1.2],
  ],
  route: [
    [3, 2],
    [8, 3.4],
  ],
  routeCasing: [
    [3, 4],
    [8, 6.5],
  ],
  ownTrack: [
    [4, 1.5],
    [10, 2.5],
  ],
} as const;

/** 透明度，缩小时航路网淡下去而不是消失。和对应的线宽同一组锚点。 */
export const OPACITY = {
  airwayHigh: [
    [4.5, 0.75],
    [8, 0.95],
    [12, 0.95],
  ],
  airwayOnRoute: [
    [4.5, 1],
    [8, 1],
    [12, 1],
  ],
  airwayLow: [
    [6, 0.75],
    [10, 0.95],
  ],
  ownTrack: 0.85,
} as const;

export const TEXT = {
  font: ["Noto Sans Regular"],
  airportMajor: [
    [5, 10],
    [11, 13],
  ],
  /** 和 `airportMajor` 同一组缩放锚点。 */
  airportMinor: [
    [5, 9],
    [11, 12],
  ],
  navaid: 9.5,
  waypoint: 8.5,
  /** 代号牌里的字。 */
  airway: 8.5,
  fir: 10,
  grid: 9,
  airspace: 9,
  mora: 11,
  runway: 12,
  groundWay: 10,
  groundArea: 11,
  groundSpot: 10,
  atc: 10,
  traffic: 9,
  own: 11,
  route: 10,
  haloWidth: 1.4,
} as const;

/**
 * 图标按实际大小画（`chartIcons.ts`，pixelRatio 2，画布边长的一半就是 CSS px），
 * `icon-size` 留在 1 附近：缩小重采样会把细线糊掉。画布贴着符号裁，标注层那份透明
 * 图标的碰撞框才不会比符号大一圈。
 */
export const ICON = {
  airportMajor: [
    [4, 0.85],
    [8, 1.1],
  ],
  /** 和 `airportMajor` 同一组缩放锚点。 */
  airportMinor: [
    [4, 0.85],
    [8, 1],
  ],
  navaid: 1,
  waypoint: 1,
  /** 标注离符号中心多少 em。 */
  labelOffset: 0.8,
} as const;

/**
 * 航路代号牌：圆角矩形随字拉伸（`icon-text-fit: both`），图片按主题和种类各一张，
 * 画法和可拉伸区在 `chartIcons.ts`。`padding` 是字外留白，CSS px，上右下左。
 */
export const SHIELD = {
  padding: [1, 2.5, 1, 2.5],
} as const;

// ---------------------------------------------------------------- 空域

/**
 * 空域的填充和斜线。类别来自 `lib/aip.ts` 的 `airspaceClass`（那里有 can-db 取值
 * 到类别的映射表）。
 *
 * - 区域、进近：半透明平涂，实线边。
 * - 限制区、禁区：斜线填充 + 实线边。
 * - 危险区：虚线边 + 淡平涂，不加斜线。
 */
export const AIRSPACE = {
  fillOpacity: { ctr: 0.05, app: 0.06, danger: 0.1, other: 0.05 },
  /** 有人上席的区域（实时那层），按席位色平涂。 */
  atcAreaFillOpacity: 0.08,
  hatch: {
    /** 图块边长（画布像素，必须是 2 的幂才能无缝平铺）。pixelRatio 2。 */
    tile: 16,
    /** 相邻两条斜线的间距（画布像素）。必须整除 `tile`。 */
    spacing: 8,
    lineWidth: 1.5,
    opacity: 0.55,
  },
  /** 禁区的斜线更密一倍。 */
  prohibitedSpacing: 4,
  dangerDash: [4, 3],
  lineOpacity: 0.9,
} as const;

// ---------------------------------------------------------------- 图片

/**
 * 按主题分两份注册的图标（`lib/chartIcons.ts` 画）。颜色直接画进图里而不走 SDF 着
 * 色：线条细，SDF 会把抗锯齿的边吃掉一半。
 */
export const THEMED_ICONS = [
  "vor",
  "vordme",
  "dme",
  "tacan",
  "vortac",
  "ndb",
  "navaid",
  "waypoint",
  "apt-major",
  "apt-minor",
] as const;
export type ThemedIcon = (typeof THEMED_ICONS)[number];

/** 航路代号牌，可拉伸（`addImage` 的 `stretchX/stretchY/content`），两套主题各一份。 */
export const SHIELDS = ["shield-rnav", "shield-conv"] as const;
export type Shield = (typeof SHIELDS)[number];

/** 斜线图块，同样两套主题各一份。 */
export const PATTERNS = ["hatch-restricted", "hatch-prohibited"] as const;
export type Pattern = (typeof PATTERNS)[number];

/** 飞机，SDF，靠 `icon-color` 着色（高度色带、自己那架）。不分主题。 */
export const AIRCRAFT_ICON = "aircraft";

/** 导航台类别 → 符号。 */
export const NAVAID_ICON: Record<NavaidClass, ThemedIcon> = {
  vor: "vor",
  vordme: "vordme",
  dme: "dme",
  tacan: "tacan",
  vortac: "vortac",
  ndb: "ndb",
  other: "navaid",
};

export function themedImage(
  key: ThemedIcon | Pattern | Shield,
  theme: Theme,
): string {
  return `${key}-${theme}`;
}

/** 样式里可能引用的全部图片名。`chartIcons.ts` 注册的必须正好是这些。 */
export function allImageIds(): string[] {
  const out: string[] = [AIRCRAFT_ICON];
  for (const theme of ["light", "dark"] as const) {
    for (const key of THEMED_ICONS) out.push(themedImage(key, theme));
    for (const key of PATTERNS) out.push(themedImage(key, theme));
    for (const key of SHIELDS) out.push(themedImage(key, theme));
  }
  return out;
}

// ---------------------------------------------------------------- 表达式

/**
 * 缩放插值。**`["zoom"]` 只能是顶层 interpolate / step 的输入** —— 包进 `case` 或乘
 * 法里，MapLibre 拒绝整条属性、整层不画，而且不报到构建期。
 */
export function ramp(stops: Stops, curve: unknown = ["linear"]): unknown {
  return ["interpolate", curve, ["zoom"], ...stops.flat()];
}

/**
 * 按条件在两组锚点之间选，**`case` 放进每个锚点里**，zoom 留在最外层。两组锚点的
 * 缩放必须一致。
 */
export function rampCase(
  condition: unknown,
  whenTrue: Stops,
  whenFalse: Stops,
): unknown {
  if (
    whenTrue.length !== whenFalse.length ||
    whenTrue.some(([z], i) => z !== whenFalse[i][0])
  ) {
    throw new Error("rampCase: 两组锚点的缩放不一致");
  }
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...whenTrue.flatMap(([z, v], i) => [
      z,
      ["case", condition, v, whenFalse[i][1]],
    ]),
  ];
}

const onRoute = ["==", ["get", "onRoute"], 1];
const notLow = ["!=", ["get", "level"], "low"];

/** 管制席位色。**不跟主题**：席位色是和 can-radar 共用的身份编码。 */
export function facilityColor(): unknown {
  const cases: (string | number)[] = [];
  for (const [facility, color] of Object.entries(FACILITY_COLORS)) {
    cases.push(Number(facility), color);
  }
  // 兜底：没见过的 facility 画成 OBS 的灰，而不是让整条表达式失效。
  return ["match", ["get", "facility"], ...cases, FACILITY_COLORS[0]];
}

/** 在线机组按高度档取色。**跟主题**：viridis 有深浅两条。 */
export function altitudeBandColor(theme: Theme): unknown {
  const ramp = altitudeRamp(theme);
  const cases: (string | number)[] = [];
  ramp.forEach((color, band) => cases.push(band, color));
  return ["match", ["get", "band"], ...cases, ramp[0]];
}

function groundFeatureColor(c: ColorRoles): unknown {
  return [
    "match",
    ["get", "kind"],
    "runway",
    c.groundRunway,
    "apron",
    c.groundApron,
    "terminal",
    c.groundApron,
    "parking_position",
    c.groundStand,
    "holding_position",
    c.groundHold,
    c.groundTaxiway,
  ];
}

function groundPointColor(c: ColorRoles): unknown {
  return [
    "match",
    ["get", "kind"],
    "holding_position",
    c.groundHold,
    c.groundStand,
  ];
}

/**
 * 地面线宽：真实米数换成像素（Web Mercator，纬度 35°：z12 约 31 m/px、z18 约
 * 0.49 m/px），下限防止低缩放时整片消失。`fallbackM` 是缺宽度时按多少米算。
 */
function groundWidth(fallbackM: number): unknown {
  const w = ["case", [">", ["get", "widthM"], 0], ["get", "widthM"], fallbackM];
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    GROUND_MIN_ZOOM,
    ["max", 0.6, ["/", w, 31.3]],
    18,
    ["max", 2, ["/", w, 0.49]],
  ];
}

function airspaceColor(c: ColorRoles): unknown {
  return [
    "match",
    ["get", "cls"],
    "restricted",
    c.restricted,
    "prohibited",
    c.prohibited,
    "danger",
    c.danger,
    "app",
    c.app,
    c.ctr,
  ];
}

function navaidIcon(theme: Theme): unknown {
  const cases: string[] = [];
  for (const [cls, key] of Object.entries(NAVAID_ICON)) {
    if (cls === "other") continue;
    cases.push(cls, themedImage(key, theme));
  }
  return [
    "match",
    ["get", "cls"],
    ...cases,
    themedImage(NAVAID_ICON.other, theme),
  ];
}

const isMajor = ["==", ["get", "major"], 1];
const isRnav = ["==", ["get", "rnav"], 1];

function airportIcon(theme: Theme): unknown {
  return [
    "case",
    isMajor,
    themedImage("apt-major", theme),
    themedImage("apt-minor", theme),
  ];
}

// ---------------------------------------------------------------- 经纬网

/** 经纬网标注：`N35°`、`E120°`，0° 和 180° 不带字母。 */
export function gridLabel(axis: "lat" | "lon", deg: number): string {
  if (deg === 0 || Math.abs(deg) === 180) return `${Math.abs(deg)}°`;
  const hemi = axis === "lat" ? (deg > 0 ? "N" : "S") : deg > 0 ? "E" : "W";
  return `${hemi}${Math.abs(deg)}°`;
}

/**
 * 1° 一条的经纬网，每条带 `step`（它落在的最粗一档：10、5、1）和 `label`。经线按
 * 纬度采样成折线，不依赖当前投影。
 */
export function graticule(): FeatureCollection {
  const features: Feature[] = [];
  const step = (deg: number) => (deg % 10 === 0 ? 10 : deg % 5 === 0 ? 5 : 1);
  for (let lon = -180; lon <= 180; lon += 1) {
    const coords: [number, number][] = [];
    for (let lat = -80; lat <= 80; lat += 5) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: { step: step(lon), label: gridLabel("lon", lon) },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  for (let lat = -80; lat <= 80; lat += 1) {
    const coords: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 5) coords.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: { step: step(lat), label: gridLabel("lat", lat) },
      geometry: { type: "LineString", coordinates: coords },
    });
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------- 图层

/** 图层的宽松形状。合法性交给 MapLibre 的校验器（check:style / 测试）。 */
export interface ChartLayer {
  id: string;
  type: "background" | "fill" | "line" | "symbol" | "circle";
  source?: string;
  minzoom?: number;
  maxzoom?: number;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
}

/** 全部 GeoJSON source。`grid` 带数据，其余建成空的，由 `RouteMap` 灌。 */
export const SOURCE_IDS = [
  "land",
  "grid",
  "landDetail",
  "borders",
  "ground",
  "runways",
  "airports",
  "airways",
  "airwayFixes",
  "navaids",
  "airspaces",
  "firs",
  "mora",
  "atcAreas",
  "atc",
  "route",
  "markers",
  "traffic",
  "ownTrack",
  "own",
] as const;

/**
 * 标注带一个**看不见的**同款图标：同一层的字会绕开它，更下面的标注也会绕开它（它
 * 先进碰撞索引）。看得见的符号在更低的符号层里画，不参与避让 —— 否则符号在下、标
 * 注在上，MapLibre 先放标注，标注会压在别的符号上。
 */
function labelLayout(
  icon: unknown,
  iconSize: unknown,
  text: Record<string, unknown>,
): Record<string, unknown> {
  return {
    "icon-image": icon,
    "icon-size": iconSize,
    "icon-allow-overlap": true,
    "icon-ignore-placement": false,
    // 字放不下时图标照样占位，下面的标注才不会压到符号上。
    "text-optional": true,
    "text-font": TEXT.font,
    "text-variable-anchor": ["top", "bottom", "right", "left"],
    "text-radial-offset": ICON.labelOffset,
    "text-justify": "auto",
    ...text,
  };
}

/** 看得见的符号：全画，不参与避让（避让由标注层里那份看不见的图标负责）。 */
const symbolOnly = {
  "icon-allow-overlap": true,
  "icon-ignore-placement": true,
};

/**
 * 建整份样式。图层顺序自下而上：
 *
 *   底图（海、陆、国界、经纬网）→ 机场地面 → 空域填充 → 空域和情报区边界 → 航路 →
 *   计划航线 → 航路点 / 导航台 / 机场符号 → 全部标注 → 在线机组 → 自己的航迹 → 自己
 *
 * 标注内部自下而上是：经纬网、MORA、情报区、空域、地面、航路点、航路代号牌、导航台、
 * 机场、跑道号、管制、计划航线。MapLibre 先放上面的，所以后者优先。
 */
export function buildStyle(theme: Theme): StyleSpecification {
  const c = COLORS[theme];
  const halo = { "text-halo-color": c.halo, "text-halo-width": TEXT.haloWidth };
  const img = (key: ThemedIcon | Pattern | Shield) => themedImage(key, theme);

  const sources: Record<string, unknown> = {};
  for (const id of SOURCE_IDS) {
    sources[id] = {
      type: "geojson",
      data:
        id === "grid"
          ? graticule()
          : { type: "FeatureCollection", features: [] },
    };
  }

  const airportSize = rampCase(isMajor, ICON.airportMajor, ICON.airportMinor);
  const airportVisible = ["any", isMajor, [">=", ["zoom"], ZOOM.airportAll]];
  const navaidVisible = [
    "any",
    ["==", ["get", "tier"], "vor"],
    [">=", ["zoom"], ZOOM.minorNavaids],
  ];
  /* 航路点：低空的等低空航路出来；和导航台重合的（`markNavaidFixes`）在那个台画出
   * 来的缩放上让位。 */
  const fixVisible = [
    "all",
    ["any", notLow, [">=", ["zoom"], ZOOM.airwaysLow]],
    ["!=", ["get", "navaid"], "vor"],
    [
      "!",
      [
        "all",
        ["==", ["get", "navaid"], "minor"],
        [">=", ["zoom"], ZOOM.minorNavaids],
      ],
    ],
  ];
  const gridVisible = [
    "any",
    ["==", ["get", "step"], 10],
    ["all", ["==", ["get", "step"], 5], [">=", ["zoom"], ZOOM.grid5]],
    [">=", ["zoom"], ZOOM.grid1],
  ];

  const layers: ChartLayer[] = [
    // ------------------------------------------------ 底图
    { id: "ocean", type: "background", paint: { "background-color": c.ocean } },
    {
      id: "land",
      type: "fill",
      source: "land",
      paint: { "fill-color": c.land },
    },
    {
      // 50m 海岸线到细节那一级交棒，两条分辨率不同的海岸线叠着会起毛边。
      id: "land-outline",
      type: "line",
      source: "land",
      maxzoom: ZOOM.landDetail,
      paint: { "line-color": c.landLine, "line-width": WIDTH.landOutline },
    },
    {
      id: "land-detail",
      type: "fill",
      source: "landDetail",
      minzoom: ZOOM.landDetail,
      paint: { "fill-color": c.land },
    },
    {
      id: "land-detail-outline",
      type: "line",
      source: "landDetail",
      minzoom: ZOOM.landDetail,
      paint: {
        "line-color": c.landLine,
        "line-width": WIDTH.landDetailOutline,
      },
    },
    {
      // 国界虚线：它常和海岸线、情报区边界挨着走，三条实线并排谁也读不出。
      id: "borders",
      type: "line",
      source: "borders",
      minzoom: ZOOM.borders,
      paint: {
        "line-color": c.border,
        "line-width": WIDTH.border,
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "grid",
      type: "line",
      source: "grid",
      filter: gridVisible,
      paint: { "line-color": c.grid, "line-width": WIDTH.grid },
    },

    // ------------------------------------------------ 机场地面
    {
      // 自下而上：航站楼与机坪、停机位、滑行道、跑道。被挡住损失越大的越靠上。
      id: "ground-terminals",
      type: "line",
      source: "ground",
      minzoom: ZOOM.ground + 1,
      filter: ["match", ["get", "kind"], ["terminal", "apron"], true, false],
      paint: {
        "line-color": groundFeatureColor(c),
        "line-width": groundWidth(30),
        "line-opacity": 0.9,
      },
    },
    {
      id: "ground-stands",
      type: "line",
      source: "ground",
      minzoom: ZOOM.ground + 1,
      filter: ["==", ["get", "kind"], "parking_position"],
      paint: {
        "line-color": groundFeatureColor(c),
        "line-width": groundWidth(12),
        "line-opacity": 0.9,
      },
    },
    {
      id: "ground-taxiways",
      type: "line",
      source: "ground",
      minzoom: ZOOM.ground + 1,
      filter: [
        "match",
        ["get", "kind"],
        ["taxiway", "holding_position"],
        true,
        false,
      ],
      paint: {
        "line-color": groundFeatureColor(c),
        "line-width": groundWidth(23),
        "line-opacity": 0.9,
      },
    },
    {
      /* 跑道，来自 can-db 的 `/aip/runways`（整库一份，34 kB）。从这一级起接替机场
       * 符号里那根跑道杠。z12 之前按像素给宽度，之后按真实米数。 */
      id: "runways",
      type: "line",
      source: "runways",
      minzoom: ZOOM.runwayLines,
      filter: ["==", ["get", "kind"], "runway"],
      paint: {
        "line-color": c.groundRunway,
        "line-width": ramp(
          [
            [9, 1.4],
            [12, 4],
            [18, 90],
          ],
          ["exponential", 2],
        ),
        "line-opacity": 0.95,
      },
    },
    {
      // 单点要素：等待位置和一部分机位本来就是一个点。
      id: "ground-points",
      type: "circle",
      source: "ground",
      minzoom: ZOOM.ground + 2,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": ramp([
          [13, 1.5],
          [17, 4],
        ]),
        "circle-color": groundPointColor(c),
        "circle-opacity": 0.9,
      },
    },

    // ------------------------------------------------ 空域填充
    {
      // 有人上席的空域。很淡：区域席位覆盖整个情报区，填深了全图蒙一层。
      id: "atc-area-fill",
      type: "fill",
      source: "atcAreas",
      paint: {
        "fill-color": facilityColor(),
        "fill-opacity": AIRSPACE.atcAreaFillOpacity,
      },
    },
    {
      id: "airspace-fill",
      type: "fill",
      source: "airspaces",
      filter: [
        "match",
        ["get", "cls"],
        ["restricted", "prohibited"],
        false,
        true,
      ],
      paint: {
        "fill-color": airspaceColor(c),
        "fill-opacity": [
          "match",
          ["get", "cls"],
          "ctr",
          AIRSPACE.fillOpacity.ctr,
          "app",
          AIRSPACE.fillOpacity.app,
          "danger",
          AIRSPACE.fillOpacity.danger,
          AIRSPACE.fillOpacity.other,
        ],
      },
    },
    {
      // 限制区和禁区：斜线填充。图块按主题各画一份（`chartIcons.ts`）。
      id: "airspace-hatch",
      type: "fill",
      source: "airspaces",
      filter: [
        "match",
        ["get", "cls"],
        ["restricted", "prohibited"],
        true,
        false,
      ],
      paint: {
        "fill-pattern": [
          "match",
          ["get", "cls"],
          "prohibited",
          img("hatch-prohibited"),
          img("hatch-restricted"),
        ],
        "fill-opacity": AIRSPACE.hatch.opacity,
      },
    },

    // ------------------------------------------------ 边界
    {
      // 情报区边界：绿色虚线。
      id: "fir-line",
      type: "line",
      source: "firs",
      filter: ["!", ["has", "labelEdge"]],
      paint: {
        "line-color": c.fir,
        "line-width": WIDTH.fir,
        "line-dasharray": [4, 2.5],
        "line-opacity": 0.9,
      },
    },
    {
      id: "airspace-line",
      type: "line",
      source: "airspaces",
      filter: ["!=", ["get", "cls"], "danger"],
      paint: {
        "line-color": airspaceColor(c),
        "line-width": [
          "match",
          ["get", "cls"],
          ["restricted", "prohibited"],
          WIDTH.sua,
          WIDTH.ctr,
        ],
        "line-opacity": AIRSPACE.lineOpacity,
      },
    },
    {
      // 危险区：虚线边。
      id: "airspace-line-danger",
      type: "line",
      source: "airspaces",
      filter: ["==", ["get", "cls"], "danger"],
      paint: {
        "line-color": c.danger,
        "line-width": WIDTH.sua,
        "line-dasharray": AIRSPACE.dangerDash,
        "line-opacity": AIRSPACE.lineOpacity,
      },
    },
    {
      // 有人上席的空域边界。比情报区那条虚线粗、实线。
      id: "atc-area-line",
      type: "line",
      source: "atcAreas",
      paint: {
        "line-color": facilityColor(),
        "line-width": WIDTH.atcArea,
        "line-opacity": 0.9,
      },
    },

    // ------------------------------------------------ 航路
    {
      id: "airways-low",
      type: "line",
      source: "airways",
      minzoom: ZOOM.airwaysLow,
      filter: ["all", ["==", ["get", "level"], "low"], ["!", onRoute]],
      paint: {
        "line-color": c.airwayLow,
        "line-width": ramp(WIDTH.airwayLow),
        "line-opacity": ramp(OPACITY.airwayLow),
      },
    },
    {
      /* 高空和两层都有的航段，加上**计划走过的**任何航段（低空的也在这里）：计划航
       * 线从 `airwaysHigh` 起把这些腿交给航路网点亮，低空那层要到 `airwaysLow` 才
       * 出现，不收进来中间两级就没人画。 */
      id: "airways",
      type: "line",
      source: "airways",
      minzoom: ZOOM.airwaysHigh,
      filter: ["any", notLow, onRoute],
      paint: {
        "line-color": [
          "case",
          onRoute,
          c.route,
          ["==", ["get", "level"], "low"],
          c.airwayLow,
          c.airwayHigh,
        ],
        "line-width": rampCase(onRoute, WIDTH.airwayOnRoute, WIDTH.airwayHigh),
        "line-opacity": rampCase(
          onRoute,
          OPACITY.airwayOnRoute,
          OPACITY.airwayHigh,
        ),
      },
    },

    // ------------------------------------------------ 计划航线
    {
      /* 衬线。在航路网接手那一级，已在航路网上点亮的腿让位（透明，不是 filter ——
       * filter 判不了缩放，而把要素拿掉会让缩小时出洞）。 */
      id: "route-casing",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c.routeCasing,
        "line-width": ramp(WIDTH.routeCasing),
        "line-opacity": [
          "step",
          ["zoom"],
          0.9,
          ZOOM.airwaysHigh,
          ["case", ["==", ["get", "onAirway"], 1], 0, 0.9],
        ],
      },
    },
    {
      // 航路段实线、程序段虚线，分两层（`line-dasharray` 写不出可靠的"实线"）。
      id: "route",
      type: "line",
      source: "route",
      filter: ["!=", ["get", "procedure"], 1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c.route,
        "line-width": ramp(WIDTH.route),
        "line-opacity": [
          "step",
          ["zoom"],
          1,
          ZOOM.airwaysHigh,
          ["case", ["==", ["get", "onAirway"], 1], 0, 1],
        ],
      },
    },
    {
      id: "route-procedure",
      type: "line",
      source: "route",
      filter: ["==", ["get", "procedure"], 1],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": c.route,
        "line-width": ramp(WIDTH.route),
        "line-dasharray": [2, 1.5],
      },
    },

    // ------------------------------------------------ 符号
    {
      id: "waypoint-symbols",
      type: "symbol",
      source: "airwayFixes",
      minzoom: ZOOM.waypoints,
      filter: fixVisible,
      layout: {
        "icon-image": img("waypoint"),
        "icon-size": ICON.waypoint,
        ...symbolOnly,
      },
    },
    {
      id: "navaid-symbols",
      type: "symbol",
      source: "navaids",
      minzoom: ZOOM.vor,
      filter: navaidVisible,
      layout: {
        "icon-image": navaidIcon(theme),
        "icon-size": ICON.navaid,
        ...symbolOnly,
      },
    },
    {
      /* 机场：蓝色小圆，主要机场实心、其余空心。跑道线出现之后有跑道数据的机场不再
       * 画符号，只留标注；没有跑道数据的一直画。 */
      id: "airport-symbols",
      type: "symbol",
      source: "airports",
      minzoom: ZOOM.airportMajor,
      filter: [
        "all",
        airportVisible,
        [
          "any",
          ["<", ["zoom"], ZOOM.runwayLines],
          ["==", ["get", "hasRwy"], 0],
        ],
      ],
      layout: {
        "icon-image": airportIcon(theme),
        "icon-size": airportSize,
        "symbol-sort-key": ["case", isMajor, 0, 1],
        ...symbolOnly,
      },
    },
    {
      // 在线管制席位（场面席位和没对上边界的）。
      id: "atc",
      type: "circle",
      source: "atc",
      paint: {
        "circle-radius": 4,
        "circle-color": facilityColor(),
        "circle-stroke-width": 1,
        "circle-stroke-color": c.halo,
      },
    },
    {
      // 计划航线上的点，和面板推来的其它点。
      id: "markers",
      type: "circle",
      source: "markers",
      paint: {
        "circle-color": c.marker,
        "circle-radius": ["case", ["==", ["get", "airport"], 1], 4, 2.5],
        "circle-stroke-color": c.marker,
        "circle-stroke-width": 0.8,
        "circle-opacity": ["case", ["==", ["get", "airport"], 1], 1, 0.45],
      },
    },

    // ------------------------------------------------ 标注（越往下优先级越高）
    {
      // 经纬网度数，沿线重复。优先级最低。
      id: "grid-labels",
      type: "symbol",
      source: "grid",
      filter: gridVisible,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 480,
        "text-field": ["get", "label"],
        "text-font": TEXT.font,
        "text-size": TEXT.grid,
        "text-max-angle": 30,
      },
      paint: { "text-color": c.gridLabel, ...halo },
    },
    {
      // Grid MORA：千位大、百位小（`format` 的分段 `font-scale`）。
      id: "mora-labels",
      type: "symbol",
      source: "mora",
      minzoom: ZOOM.mora,
      layout: {
        "text-field": [
          "format",
          ["get", "thousands"],
          {},
          ["get", "hundreds"],
          { "font-scale": 0.68 },
        ],
        "text-font": TEXT.font,
        "text-size": TEXT.mora,
      },
      paint: { "text-color": c.mora, ...halo },
    },
    {
      // 「代号 名字」（`RKRR INCHEON`）沿边界线写在自己那一侧，文字由 `lib/firs.ts`
      // 的 `firLabelEdges` 拼好。
      id: "fir-labels",
      type: "symbol",
      source: "firs",
      minzoom: ZOOM.firLabels,
      filter: ["has", "labelEdge"],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 400,
        "text-keep-upright": false,
        "text-max-angle": 30,
        // 两侧各一个区的段是一个两行标注（`inside: both`），骑在线上，不偏移。
        "text-offset": [
          "match",
          ["get", "inside"],
          "left",
          ["literal", [0, -0.9]],
          "right",
          ["literal", [0, 0.9]],
          ["literal", [0, 0]],
        ],
        "text-line-height": 1.9,
        "text-field": ["get", "label"],
        "text-font": TEXT.font,
        "text-size": TEXT.fir,
        "text-letter-spacing": 0.12,
      },
      paint: { "text-color": c.fir, ...halo },
    },
    {
      // 空域代号 + 垂直范围，落在多边形中心。
      id: "airspace-labels",
      type: "symbol",
      source: "airspaces",
      minzoom: ZOOM.airspaceLabels,
      layout: {
        "text-field": ["concat", ["get", "code"], "\n", ["get", "vertical"]],
        "text-font": TEXT.font,
        "text-size": TEXT.airspace,
        "text-line-height": 1.1,
      },
      paint: { "text-color": airspaceColor(c), ...halo },
    },
    {
      // 机位号和等待位置代号，z15 才出。
      id: "ground-labels-spot",
      type: "symbol",
      source: "ground",
      minzoom: ZOOM.ground + 4,
      filter: [
        "all",
        ["has", "name"],
        ["!=", ["get", "name"], ""],
        [
          "match",
          ["get", "kind"],
          ["parking_position", "holding_position"],
          true,
          false,
        ],
      ],
      layout: {
        "text-field": ["get", "name"],
        "text-font": TEXT.font,
        "text-size": TEXT.groundSpot,
      },
      paint: { "text-color": c.groundStand, ...halo },
    },
    {
      // 滑行道代号贴着线走。
      id: "ground-labels-way",
      type: "symbol",
      source: "ground",
      minzoom: ZOOM.ground + 2,
      filter: [
        "all",
        ["has", "name"],
        ["!=", ["get", "name"], ""],
        ["match", ["get", "kind"], ["taxiway"], true, false],
      ],
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "name"],
        "text-font": TEXT.font,
        "text-size": TEXT.groundWay,
        "text-letter-spacing": 0.05,
        "symbol-spacing": 220,
      },
      paint: { "text-color": c.textMuted, ...halo },
    },
    {
      // 机坪和航站楼的名字：地标，和滑行道代号同时出现。
      id: "ground-labels-area",
      type: "symbol",
      source: "ground",
      minzoom: ZOOM.ground + 2,
      filter: [
        "all",
        ["has", "name"],
        ["!=", ["get", "name"], ""],
        ["match", ["get", "kind"], ["apron", "terminal"], true, false],
      ],
      layout: {
        "text-field": ["get", "name"],
        "text-font": TEXT.font,
        "text-size": TEXT.groundArea,
        "text-letter-spacing": 0.08,
        "text-transform": "uppercase",
      },
      paint: { "text-color": c.textMuted, ...halo },
    },
    {
      id: "waypoint-labels",
      type: "symbol",
      source: "airwayFixes",
      minzoom: ZOOM.waypointLabels,
      filter: fixVisible,
      layout: labelLayout(img("waypoint"), ICON.waypoint, {
        "text-field": ["get", "ident"],
        "text-size": TEXT.waypoint,
      }),
      paint: { "icon-opacity": 0, "text-color": c.waypoint, ...halo },
    },
    {
      /* 航路代号牌：每段一个，放在段中间（`line-center`），顺着线、保持正向；段比牌
       * 短就不放。圆角牌随字拉伸，RNAV 蓝底、常规深底（`isRnavDesignator`）。高空的
       * 先放。 */
      id: "airway-labels",
      type: "symbol",
      source: "airways",
      minzoom: ZOOM.airwayLabels,
      filter: ["any", notLow, onRoute, [">=", ["zoom"], ZOOM.airwaysLow]],
      layout: {
        "symbol-placement": "line-center",
        "icon-image": ["case", isRnav, img("shield-rnav"), img("shield-conv")],
        "icon-text-fit": "both",
        "icon-text-fit-padding": SHIELD.padding,
        "icon-rotation-alignment": "map",
        "text-field": ["get", "airway"],
        "text-font": TEXT.font,
        "text-size": TEXT.airway,
        "text-letter-spacing": 0.03,
        "text-rotation-alignment": "map",
        "text-keep-upright": true,
        "text-max-angle": 30,
        "symbol-sort-key": ["case", notLow, 0, 1],
      },
      paint: {
        "text-color": ["case", isRnav, c.shieldRnavText, c.shieldConvText],
      },
    },
    {
      id: "navaid-labels",
      type: "symbol",
      source: "navaids",
      minzoom: ZOOM.vorLabels,
      filter: [
        "any",
        ["==", ["get", "tier"], "vor"],
        [">=", ["zoom"], ZOOM.minorNavaidLabels],
      ],
      layout: labelLayout(navaidIcon(theme), ICON.navaid, {
        // 缩小时只写识别码，放大换成「台名 D 频率 识别码」。
        "text-field": [
          "step",
          ["zoom"],
          ["get", "ident"],
          ZOOM.navaidFullLabels,
          ["get", "label"],
        ],
        "text-size": TEXT.navaid,
        "symbol-sort-key": ["case", ["==", ["get", "tier"], "vor"], 0, 1],
      }),
      paint: {
        "icon-opacity": 0,
        "text-color": ["case", ["==", ["get", "cls"], "ndb"], c.ndb, c.navaid],
        ...halo,
      },
    },
    {
      id: "airport-labels",
      type: "symbol",
      source: "airports",
      minzoom: ZOOM.airportMajorLabels,
      filter: ["any", isMajor, [">=", ["zoom"], ZOOM.airportAllLabels]],
      layout: labelLayout(airportIcon(theme), airportSize, {
        "text-field": ["get", "icao"],
        "text-size": rampCase(isMajor, TEXT.airportMajor, TEXT.airportMinor),
        "text-letter-spacing": 0.05,
        "symbol-sort-key": ["case", isMajor, 0, 1],
      }),
      paint: { "icon-opacity": 0, "text-color": c.airport, ...halo },
    },
    {
      // 跑道号，写在跑道两头的入口上。
      id: "ground-labels-runway",
      type: "symbol",
      source: "runways",
      minzoom: ZOOM.runwayLabels,
      filter: ["==", ["get", "kind"], "runway_end"],
      layout: {
        "text-field": ["get", "ident"],
        "text-font": TEXT.font,
        "text-size": TEXT.runway,
        "text-letter-spacing": 0.1,
      },
      paint: { "text-color": c.groundRunway, ...halo },
    },
    {
      // 有人上席的空域，沿边界标呼号和频率。
      id: "atc-area-labels",
      type: "symbol",
      source: "atcAreas",
      minzoom: ZOOM.atcAreaLabels,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 500,
        "text-field": [
          "concat",
          ["get", "callsign"],
          "  ",
          ["get", "frequency"],
        ],
        "text-font": TEXT.font,
        "text-size": TEXT.atc,
        "text-letter-spacing": 0.08,
        "text-max-angle": 30,
      },
      paint: { "text-color": facilityColor(), ...halo },
    },
    {
      id: "atc-labels",
      type: "symbol",
      source: "atc",
      layout: {
        "text-field": [
          "concat",
          ["get", "callsign"],
          "  ",
          ["get", "frequency"],
        ],
        "text-font": TEXT.font,
        "text-size": TEXT.atc,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
      },
      paint: { "text-color": facilityColor(), ...halo },
    },
    {
      /* 计划航线的沿线航路代号。在航路代号出现那一级，已在航路网上点亮的腿把标注交
       * 给 `airway-labels`。 */
      id: "route-airways",
      type: "symbol",
      source: "route",
      minzoom: ZOOM.routeAirwayLabels,
      filter: ["!=", ["get", "via"], ""],
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 220,
        "text-field": ["get", "via"],
        "text-font": TEXT.font,
        "text-size": TEXT.route,
        "text-letter-spacing": 0.08,
        "text-max-angle": 25,
        "text-offset": [0, -0.9],
      },
      paint: {
        "text-color": c.route,
        "text-halo-color": c.routeCasing,
        "text-halo-width": 1.6,
        "text-opacity": [
          "step",
          ["zoom"],
          1,
          ZOOM.airwayLabels,
          ["case", ["==", ["get", "onAirway"], 1], 0, 1],
        ],
      },
    },
    {
      // 计划航线上的点名。**不参与避让**：它们是用户刚算出来的航线。
      id: "route-labels",
      type: "symbol",
      source: "markers",
      filter: ["==", ["get", "onRoute"], 1],
      layout: {
        "text-field": ["get", "ident"],
        "text-font": TEXT.font,
        "text-size": TEXT.route,
        "text-offset": [0, 0.8],
        "text-anchor": "top",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": c.marker,
        "text-halo-color": c.routeCasing,
        "text-halo-width": 1.6,
      },
    },

    // ------------------------------------------------ 在线机组
    {
      /* 按高度分色，地面上的小一号、压淡。尺寸的 interpolate 在最外层，地面那一档写
       * 进每个锚点。 */
      id: "traffic",
      type: "symbol",
      source: "traffic",
      layout: {
        "icon-image": AIRCRAFT_ICON,
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          ["case", ["==", ["get", "onGround"], 1], 0.52, 0.8],
          7,
          ["case", ["==", ["get", "onGround"], 1], 0.68, 1.05],
          10,
          ["case", ["==", ["get", "onGround"], 1], 0.88, 1.35],
        ],
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
      },
      paint: {
        "icon-color": altitudeBandColor(theme),
        "icon-opacity": ["case", ["==", ["get", "onGround"], 1], 0.45, 1],
      },
    },
    {
      id: "traffic-labels",
      type: "symbol",
      source: "traffic",
      minzoom: ZOOM.trafficLabels,
      filter: ["!=", ["get", "onGround"], 1],
      layout: {
        "text-field": ["concat", ["get", "callsign"], "  ", ["get", "level"]],
        "text-font": TEXT.font,
        "text-size": TEXT.traffic,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
      },
      paint: { "text-color": altitudeBandColor(theme), ...halo },
    },

    // ------------------------------------------------ 自己
    {
      // 自己的航迹，本次会话攒的（`lib/ownTrack.ts`）。
      id: "own-track",
      type: "line",
      source: "ownTrack",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": c.ownTrack,
        "line-width": ramp(WIDTH.ownTrack),
        "line-opacity": OPACITY.ownTrack,
      },
    },
    {
      /* 自己那架：最大、最亮、最上。每个锚点是 traffic 在飞那档的 1.35 倍。标注不参
       * 与避让。 */
      id: "own",
      type: "symbol",
      source: "own",
      layout: {
        "icon-image": AIRCRAFT_ICON,
        "icon-size": ramp([
          [4, 1.08],
          [7, 1.42],
          [10, 1.82],
        ]),
        "icon-rotate": ["get", "heading"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "text-field": [
          "concat",
          ["get", "callsign"],
          "\n",
          ["to-string", ["get", "altitude"]],
          "ft  ",
          ["to-string", ["get", "groundspeed"]],
          "kt",
        ],
        "text-font": TEXT.font,
        "text-size": TEXT.own,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
        "text-line-height": 1.1,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "icon-color": c.own,
        "text-color": c.own,
        "text-halo-color": c.halo,
        "text-halo-width": 1.6,
      },
    },
  ];

  return {
    version: 8,
    sources,
    // 文字要字体源，否则带 text-field 的图层一个字都不画，而且不报错。
    glyphs: "/basemap/fonts/{fontstack}/{range}.pbf",
    layers,
  } as unknown as StyleSpecification;
}

/** 一个图层上随主题可能变的一个属性。 */
export interface ThemedProperty {
  layer: string;
  kind: "paint" | "layout";
  name: string;
  value: unknown;
}

/**
 * 这套主题下每个图层的每个 paint / layout 属性。`RouteMap` 切主题时逐个对比，有变
 * 化才设。**不维护清单**：从 `buildStyle` 直接列，新图层自动在内。
 */
export function themedProperties(theme: Theme): ThemedProperty[] {
  const out: ThemedProperty[] = [];
  const style = buildStyle(theme) as unknown as { layers: ChartLayer[] };
  for (const layer of style.layers) {
    for (const [name, value] of Object.entries(layer.paint ?? {})) {
      out.push({ layer: layer.id, kind: "paint", name, value });
    }
    for (const [name, value] of Object.entries(layer.layout ?? {})) {
      out.push({ layer: layer.id, kind: "layout", name, value });
    }
  }
  return out;
}
