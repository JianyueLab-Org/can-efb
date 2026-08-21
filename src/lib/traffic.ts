/**
 * 在线机组怎么显示 —— 高度分色、在地面还是在天上、高度层怎么写。
 *
 * 和 `lib/atc.ts` 是一对：那个管管制席位的显示，这个管飞机的。线上格式仍然都在
 * `lib/datafeed.ts`。
 *
 * ## 这一份也是从 can-radar 移过来的
 *
 * `ALTITUDE_STEPS`、两套色带、`altitudeBand`、`isOnGround`、`flightLevel` 逐字取自
 * `can-radar/src/lib/radar.ts`（它又是从 vatsim-radar 移的）。**是复制，不是共享
 * 包** —— 和 `geo.ts` / `atc.ts` 同一个判断，理由见那两处。
 *
 * **为什么值得移过来：颜色承载高度。** 一屏几十架飞机全是同一个颜色的三角，只能看
 * 出"有人在"；按高度分色之后，一眼就分得出谁在爬升、谁在巡航、谁在进近 —— 而这正
 * 是飞行员看这一层的目的。两个站用同一套色带，也就是同一份读图习惯。
 */

/**
 * 高度分档，单位英尺。一架飞机的颜色就是它落进的那一档，所以下面两套色带各有且只
 * 有 16 个颜色，和这里一一对应。
 */
export const ALTITUDE_STEPS = [
  2500, 5000, 7500, 10000, 12500, 15000, 17500, 20000, 25000, 30000, 35000,
  40000, 45000, 50000, 55000, 60000,
] as const;

/** viridis，vatsim-radar 默认的那条高度色带。深浅两套。 */
const ALTITUDE_COLORS: Record<"light" | "dark", readonly string[]> = {
  light: [
    "#8ed645",
    "#7ad151",
    "#69cd5b",
    "#5ac864",
    "#4ac16d",
    "#3dbc74",
    "#32b67a",
    "#28ae80",
    "#1fa187",
    "#20938c",
    "#24868e",
    "#2a788e",
    "#306a8e",
    "#365c8d",
    "#3e4c8a",
    "#443a83",
  ],
  dark: [
    "#86d549",
    "#7ad151",
    "#6ece58",
    "#63cb5f",
    "#58c765",
    "#4ec36b",
    "#44bf70",
    "#3bbb75",
    "#2cb17e",
    "#22a884",
    "#1f9f88",
    "#1f958b",
    "#228b8d",
    "#26828e",
    "#2a788e",
    "#2e6f8e",
  ],
};

/**
 * 这个高度落进第几档。
 *
 * `- 100` 那一下是照搬的，别当成笔误：它让 FL350 这种**正好压在档位线上**的巡航高
 * 度稳定地落进低的那一档，而不是因为几十英尺的抖动在两个颜色之间跳。真实的巡航高
 * 度大量落在 25000 / 30000 / 35000 这些整数上，所以这一下影响的不是边角情形。
 */
export function altitudeBand(altitude: number | null | undefined): number {
  if (!altitude || altitude < 0) return 0;
  const index = ALTITUDE_STEPS.findIndex((step) => altitude - 100 <= step);
  return index === -1 ? ALTITUDE_STEPS.length - 1 : index;
}

/** 某个高度在某套主题下的颜色。 */
export function altitudeColor(
  altitude: number | null | undefined,
  theme: "light" | "dark",
): string {
  return ALTITUDE_COLORS[theme][altitudeBand(altitude)];
}

/** 整条色带，按主题。给地图的分档表达式用。 */
export function altitudeRamp(theme: "light" | "dark"): readonly string[] {
  return ALTITUDE_COLORS[theme];
}

/**
 * 这架飞机是在地面滑行/停着，还是在飞。
 *
 * 逐字取自 can-radar，连同它那句话：vatsim-radar 是拿机场库判的（距离加高度），而
 * 我们在浏览器里没有机场坐标，所以**只看地速** —— 够用来把一个繁忙机场的停机坪从
 * 图上摘干净，只在起飞离地和接地那几秒里会判错。
 *
 * 为什么这一层要区分：一个大机场停着几十架飞机，它们叠在同一个点上，把周围的航路
 * 和航路点全糊掉 —— 而"谁停在机坪上"恰恰是这张图上最不需要的信息。
 */
export function isOnGround(groundspeed: number | null | undefined): boolean {
  return (groundspeed ?? 0) <= 40;
}

/**
 * `FL350` 那种写法。**一千英尺以下写成整数英尺**，因为 `FL003` 不是任何人读高度的
 * 方式，而进离场阶段的低高度恰恰是这一层最值得标出来的。
 */
export function flightLevel(altitude: number | null | undefined): string {
  const alt = altitude ?? 0;
  if (alt < 1000) return `${Math.round(alt / 100) * 100}`;
  return `FL${Math.round(alt / 100)
    .toString()
    .padStart(3, "0")}`;
}
