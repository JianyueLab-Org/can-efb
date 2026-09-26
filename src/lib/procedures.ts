import type { MapPoint } from "@/lib/mapBus";
import { holdShape, isHoldLeg } from "@/lib/holds";
import { aipScope, dbFetch } from "@/lib/naip";

/**
 * 进离场程序与跑道：取回来、筛出来、画出去。
 *
 * ## 数据从哪儿来：**不新开接口**
 *
 * 走的是 can-db 已有的机场详情 `/api/v1/aip/airports/{ICAO}` —— 它本来就带
 * `runways` 和 `procedures`，而 `procedures[].path` 里每条腿自带坐标和约束。
 * 顺带把机位、通信、ILS 也带来了，那是多付的；但 monorepo 的规矩写着「加接口之
 * 前先看已有的，答案通常是已经有一条」，而这里确实有。为省那点机位另开一条
 * `/procedures`，代价是 can-db 一次改动、一次部署、一次 pin 移动，换来的是同一
 * 批数据的第二种形状 —— 不划算。
 *
 * 真到了嫌大的那天，正确的做法是给现有这条加 `?include=`，而不是新开一条。
 *
 * ## 高度限制**原样显示，不解码**
 *
 * `alt` 是 ARINC 424 的编码字符串（`02960` / `00500A` / `05910B03940A` / `MAP`）。
 * can-db 存的是原文，它那条迁移里写明了理由：**解码要判 A/B/+/- 那套语义，而一个
 * 解错的高度限制比没有更危险**。
 *
 * 同一条在这里同样成立，而且更硬 —— can-db 是库，这里是给飞行员看的屏幕。所以这
 * 个模块**一个字都不解释**，只把原文摆出来。想显示「5900 以上」的那天，那该是一
 * 个带测试的独立解码器（和 METAR 解码同一条规矩，见 CLAUDE.md），不是这里的一段
 * 三元表达式。
 */

// ------------------------------------------------------------------ 类型

/** 一条腿。字段和 can-db 的 `ProcedurePoint` 逐字对齐。 */
export interface ProcedureLeg {
  /**
   * 定位点代号。**可以是空的** —— `CA`（爬到某高度）、`VI`（飞到某航向截获）这
   * 类腿终止在高度或航向上，没有定位点，全库 1999 条。
   */
  ident: string;
  /**
   * **可以是 null，而且不是边角情况**：全库 311 个代号没有任何来源认识。代号仍
   * 然属于这条程序，所以 can-db 留着它而不是丢掉 —— 画线的时候跳过，列表里照旧
   * 列出来。
   */
  lat: number | null;
  lon: number | null;

  /** ARINC 424 路径终止码：`IF` `TF` `CA` `DF` `VI` … */
  path: string | null;
  transition: string | null;
  routeType: string | null;
  /** **编码字符串原样**，见文件头。不要在任何地方解码它。 */
  alt: string | null;
  speedKt: number | null;
  /**
   * 速度限制的种类。can-db 迁移里写的是 `-` 上限 | `+` 下限，但 NAIP 那一份实际写的
   * 是 `below`（全库 8673 条，没有一条 `-`/`+`）。两种都认，见 `speedLimitText`。
   * null 就是那个数。
   */
  speedKind: string | null;
  /**
   * 转弯方向。**属于这条腿的起点**：ARINC 424 的转弯方向说的是「转上这条腿」的那个
   * 弯，发生在上一个定位点。见 `procedureToMapPoints`。
   */
  turn: string | null;
  courseMag: number | null;
  vpaDeg: number | null;
  flyover: boolean | null;
  isMap: boolean | null;
  /** 进近分三段：`final` | `missed` | `transition`。SID/STAR 是 null。 */
  part: string | null;
}

export type ProcedureKind = "sid" | "star" | "approach";

export interface Procedure {
  kind: ProcedureKind;
  name: string;
  /** 老数据源只有这一条；编码图那一份用 `runways`。 */
  runway: string | null;
  /** 这条程序服务的**全部**跑道。分隔符不定，用 `procedureRunways` 解析。 */
  runways: string | null;
  chart: string | null;
  variant: string | null;
  points: string[];
  path: ProcedureLeg[];
}

/** 机场详情里的一条跑道。**按端给**，`18L` 和 `36R` 是两行。 */
export interface AirportRunway {
  id: string;
  opposite: string | null;
  hdg: number | null;
  lat: number;
  lon: number;
  endLat: number;
  endLon: number;
}

/** 跑道的物理参数，按 `ident`（跑道端）和 `runways` 对上。没有坐标。 */
export interface RunwayDetail {
  ident: string;
  lengthM: number | null;
  widthM: number | null;
  /** 真方位，度。 */
  trueBrg: number | null;
  surface: string | null;
}

/** 详情接口里我们要的那几块。其余字段还在，只是这个模块不关心。 */
export interface AirportProcedures {
  icao: string;
  /** 磁差，度，**西为正**（can-db 的约定）。可能为 null。 */
  variation: number | null;
  runways: AirportRunway[];
  runwayDetails: RunwayDetail[];
  procedures: Procedure[];
}

// ------------------------------------------------------------------ 取数

/**
 * 拆信封。can-db 大部分接口包着 `{status, data}`，少数裸奔 —— 两种都收。
 *
 * 和 `lib/aip.ts` 的 `unwrapList` 是同一件事的对象版；没有合并成一个泛型函数，
 * 因为收窄的判据不同（一个问 `Array.isArray`，一个问「是不是对象」），合起来写
 * 只会得到一个两边都要再判一次的返回类型。
 */
function unwrapObject<T>(body: unknown): T | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === "object") return data as T;
  return body as T;
}

export class ProcedureError extends Error {
  constructor(readonly status: number) {
    super(`procedures: ${status}`);
  }
}

/**
 * 取一个机场的跑道和程序。
 *
 * **失败抛出而不是给空**：一张缺了程序的图和一个没有程序的机场长得一模一样，而
 * 这个站有一条明写的规矩 —— 别把「失败」画成「没有」（CLAUDE.md）。状态码带出
 * 去，调用方才分得清 401（没权限，这是常态）和别的。
 */
export async function fetchAirportProcedures(
  icao: string,
): Promise<AirportProcedures> {
  const code = icao.trim().toUpperCase();
  const response = await dbFetch(`aip/airports/${code}`);
  if (!response.ok) throw new ProcedureError(response.status);
  const data = unwrapObject<AirportProcedures>(await response.json());
  if (!data) throw new ProcedureError(response.status);
  return {
    icao: data.icao ?? code,
    variation: data.variation ?? null,
    runways: data.runways ?? [],
    runwayDetails: data.runwayDetails ?? [],
    procedures: data.procedures ?? [],
  };
}

/**
 * 按 ICAO 缓存的 `fetchAirportProcedures`。键带 `aipScope()`，隐藏 NAIP 的开关一变就
 * 不再命中旧的那份。并发的同一个请求共用一次。失败不进缓存。
 */
const cache = new Map<string, Promise<AirportProcedures>>();

export function loadAirportProcedures(
  icao: string,
): Promise<AirportProcedures> {
  const code = icao.trim().toUpperCase();
  const key = `${aipScope()}:${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const request = fetchAirportProcedures(code);
  cache.set(key, request);
  request.catch(() => cache.delete(key));
  return request;
}

// ------------------------------------------------------------------ 跑道

/**
 * 跑道端的真方位：详情里有 `trueBrg` 就用它，否则由两端坐标算。不用 `hdg`，那是磁
 * 航向，和 METAR 的真北风向差一个磁差。
 */
export function runwayTrueBearing(
  runway: AirportRunway,
  detail?: RunwayDetail | null,
): number | null {
  if (detail?.trueBrg != null && Number.isFinite(detail.trueBrg)) {
    return detail.trueBrg;
  }
  const { lat, lon, endLat, endLon } = runway;
  if (![lat, lon, endLat, endLon].every(Number.isFinite)) return null;
  if (lat === endLat && lon === endLon) return null;
  const rad = Math.PI / 180;
  const dLon = (endLon - lon) * rad;
  const y = Math.sin(dLon) * Math.cos(endLat * rad);
  const x =
    Math.cos(lat * rad) * Math.sin(endLat * rad) -
    Math.sin(lat * rad) * Math.cos(endLat * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** 按代号找一个跑道端。 */
export function findRunway(
  runways: AirportRunway[] | null | undefined,
  ident: string | null | undefined,
): AirportRunway | null {
  const want = (ident ?? "").trim().toUpperCase();
  if (!want || !runways) return null;
  return (
    runways.find((r) => (r.id ?? "").trim().toUpperCase() === want) ?? null
  );
}

/**
 * 一条程序服务哪些跑道。
 *
 * **分隔符不做假设。** 这一列是导入器从解析出来的 JSON 里原样搬过来的字符串，
 * 而源头那边是个数组 —— 中间那一步用逗号、斜杠还是空格拼的，在这个仓库里查不
 * 到。跑道代号本身恒是字母数字（`01L`、`36`、`18R`），所以按**非字母数字**切分
 * 对三种拼法都对，而赌错一种的后果是这条程序在每一条跑道下都不出现。
 *
 * 空数组表示**这条程序没说服务哪条跑道**，而那和「不服务任何跑道」是两回事 ——
 * 见 `servesRunway`。
 */
export function procedureRunways(p: Procedure): string[] {
  const raw = p.runways ?? p.runway ?? "";
  const parts = raw
    .toUpperCase()
    .split(/[^0-9A-Z]+/)
    .filter(Boolean)
    // `ALL` / `ALLRWY` 这种写法说的是「都服务」，等同于没说 —— 落回空数组，交给
    // servesRunway 的那条规则，而不是变成一条名叫 ALL 的跑道。
    .filter((t) => t !== "ALL" && t !== "ALLRWY");
  return [...new Set(parts)];
}

/**
 * 这条程序能不能用在这条跑道上。
 *
 * **没说跑道的算「都能」，不是「都不能」。** 一部分程序（尤其老数据源那一份）
 * 压根没有跑道信息；按「不匹配」处理的话，选了跑道之后列表会**整个空掉**，而那
 * 看起来像这个机场没有程序 —— 又是一次把「不知道」画成「没有」。
 *
 * 调用方应当把这一类标出来（见 `servesAllRunways`），让人知道这条不是按跑道筛出
 * 来的。
 */
export function servesRunway(p: Procedure, runway: string): boolean {
  if (!runway) return true;
  const list = procedureRunways(p);
  if (list.length === 0) return true;
  const want = runway.toUpperCase();
  return list.some((code) => runwayMatches(code, want));
}

/**
 * 一个跑道代号能不能指这条跑道。
 *
 * **ARINC 424 的 `B` 是「这个号码的所有平行跑道」**：`RW19B` 是 19L、19R（有的话
 * 还有 19C）共用的那条转换。navigraph 那一份里这种写法很常见 —— 深圳的 `RW16B`、
 * 首都的 `RW18B`/`RW36B`。按字面比的话，选了 19L 或 19R 都对不上它，那一段就不画，
 * 而少画的那一截看起来只像程序本来就短。
 */
export function runwayMatches(code: string, runway: string): boolean {
  if (code === runway) return true;
  return (
    /^[0-9]{2}B$/.test(code) &&
    /^[0-9]{2}[LRC]$/.test(runway) &&
    code.slice(0, 2) === runway.slice(0, 2)
  );
}

/** 这条程序没有写明跑道 —— 上面那条规则的另一半，界面要据此加个标记。 */
export function servesAllRunways(p: Procedure): boolean {
  return procedureRunways(p).length === 0;
}

/**
 * 机场的跑道端列表，排好序。
 *
 * 排序按**数字再字母**（`01L` `01R` `02` `19L`），不是字典序 —— 字典序会把 `02`
 * 排在 `19` 后面吗？不会，但会把 `1` 和 `01` 混着排，而两种写法在真实数据里都
 * 有。取数字部分当主键就没有这个问题。
 */
export function runwayIdents(runways: AirportRunway[]): string[] {
  const seen = new Set<string>();
  for (const r of runways) {
    const id = (r.id ?? "").trim().toUpperCase();
    if (id) seen.add(id);
  }
  return [...seen].sort((a, b) => {
    const na = Number.parseInt(a, 10);
    const nb = Number.parseInt(b, 10);
    if (na !== nb) return (na || 0) - (nb || 0);
    return a.localeCompare(b);
  });
}

// ------------------------------------------------------------------ 挑选

/**
 * 按类别和跑道挑程序，排好序。
 *
 * 排序按名字，而**变体（`variant`）跟在同名的后面** —— 进近的 `R01-Y` 和 `R01-Z`
 * 是同一条跑道的两套编码，摆在一起才看得出它们是一组。
 */
export function pickProcedures(
  list: Procedure[],
  kind: ProcedureKind,
  runway: string,
): Procedure[] {
  return list
    .filter((p) => p.kind === kind && servesRunway(p, runway))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.variant ?? "").localeCompare(b.variant ?? ""),
    );
}

/** 显示用的名字：`R01L-Y`。变体是编码的一部分，不能省。 */
export function procedureLabel(p: Procedure): string {
  if (!p.variant) return p.name;
  const suffix = `-${p.variant.toUpperCase()}`;
  // NAIP 有一批进近的名字里已经带着变体（`R01-Y` 配 `y`，89 条），再接一次就成了
  // `R01-Y-Y`。
  return p.name.toUpperCase().endsWith(suffix) ? p.name : p.name + suffix;
}

/**
 * 腿表里的速度限制：`-210` 上限、`+210` 下限、`210` 就是那个数。
 *
 * NAIP 那一份写的是 `below`，迁移里约定的是 `-`/`+`，两种都认。认不出的种类原样摆在前
 * 面，不猜 —— 和高度限制同一条：解错一个限制比没有更危险。
 */
export function speedLimitText(
  leg: Pick<ProcedureLeg, "speedKt" | "speedKind">,
): string {
  if (!leg.speedKt) return "";
  const kind = (leg.speedKind ?? "").trim().toLowerCase();
  const sign =
    kind === "-" || kind === "below"
      ? "-"
      : kind === "+" || kind === "above"
        ? "+"
        : kind
          ? `${leg.speedKind} `
          : "";
  return `${sign}${leg.speedKt}`;
}

// ------------------------------------------------------------------ 画线

/**
 * 程序转成地图上的点。
 *
 * **没有坐标的腿跳过，但不算错**：`CA`/`VI` 那类腿终止在高度或航向上，本来就没
 * 有定位点。它们仍然在腿表里 —— 这个函数回答的是「线画在哪儿」。
 *
 * `via` 一律是程序名，于是地图上那条沿线标注写的就是 `IDKE5Y`，和航图上读一条计
 * 划的方式一致：点、程序、点。
 */
/**
 * `RW19L` 这类跑道转换的名字。它面向跑道，不是接航路网的那一端。
 *
 * `B` 也得认：`RW19B` 不认的话会掉进下面「具名的航路转换」那一支，被当成一个接航路
 * 网的入口去比 `enrouteFix`。它指哪几条跑道由 `runwayMatches` 判。
 *
 * `RWY16` 也得认：ZSQD 的四条 SID 这么写。不认的话它同样掉进航路转换那一支 —— 选择器
 * 把「RWY16」当航路转换列出来，选了 16 号跑道时两条跑道的转换首尾相接一起画。
 */
const RUNWAY_TRANSITION = /^RWY?([0-9]{2}[LRCGB]?)$/;

/**
 * 一条程序里**实际要飞的那几段**。
 *
 * **一条程序的点列不是一条航迹。** NAIP 把一条 SID 的几个跑道转换和公共段全塞进同一
 * 串腿里 —— ZBAD 的 `ELKU4K` 就是这样，`AD4xx`/`AD5xx` 是各条跑道各自的转换，后面才
 * 接上公共段出到 ELKUR。整串连成一条折线画出来，是一团来回穿插的线，程序名沿线重复
 * 三次，而**每一段本身画得都很漂亮**，所以看不出错。346 条 SID 和 47 条 STAR 是这样，
 * 一行最多 11 组。
 *
 * 要画的是实际飞的那一条：
 *
 *   SID   所选跑道的转换 → 公共段 → 接得上航路的那个航路转换
 *   STAR  反过来
 *
 * **没给跑道就不画任何跑道转换**，只画公共段。随便挑一条会画出这架飞机不飞的线，而它
 * 看起来和真的一模一样 —— 这个站的判据是「错了不会被屏幕出卖的地方要格外小心」。
 * 同理，航路转换按 `enrouteFix` 挑，挑不中就不画。
 *
 * 一个转换都没有的程序（navigraph 那一份 33574 个点里 0 个带转换）原样返回。
 */
export interface TrackOptions {
  runway?: string | null;
  enrouteFix?: string | null;
  /**
   * 明确选定的航路转换（进近是进近转换）。给了就只认这个名字，不再按 `enrouteFix`
   * 去猜。
   */
  transition?: string | null;
  /** 进近的复飞段。默认带上（腿表要列）；地图的主线传 false。 */
  missed?: boolean;
}

/** 进近的腿带 `part` 时，按 part 分段取；不带时和 SID/STAR 一样按转换分组。 */
function approachTrack(p: Procedure, opts: TrackOptions): ProcedureLeg[] {
  const path = p.path ?? [];
  const want = (opts.transition ?? "").toUpperCase();
  const fix = (opts.enrouteFix ?? "").toUpperCase();
  const transitionLegs = path.filter((l) => l.part === "transition");
  let chosen: ProcedureLeg[] = [];
  if (want) {
    chosen = transitionLegs.filter(
      (l) => (l.transition ?? "").toUpperCase() === want,
    );
  } else if (fix) {
    // 没选时，取从 STAR 终点起始的那条转换。
    const name = transitionLegs.find((l, i, all) => {
      const first = i === 0 || all[i - 1].transition !== l.transition;
      return (
        first &&
        (l.ident.toUpperCase() === fix ||
          (l.transition ?? "").toUpperCase() === fix)
      );
    })?.transition;
    if (name) chosen = transitionLegs.filter((l) => l.transition === name);
  }
  const parts = finalAndMissed(path);
  const missed = opts.missed === false ? [] : parts.missed;
  return dedupeAdjacentLegs([...chosen, ...parts.final, ...missed]);
}

/** 爬升、航向这类终止在高度或航向上的腿。最后进近里不会有它们，复飞段从它们起头。 */
const CLIMB_LEG = /^(CA|VA|VI|VM|FA|CI)$/;

/**
 * 进近的最后进近段和复飞段。
 *
 * **NAIP 有 37 条进近把复飞的头几条腿切进了 `final`。** ZSPD `R34L` 的 final 是
 * `… PD041 PD040 · CA · DF PD231`，复飞段又从 `CA · CA · DF PD231 · HM` 重来一遍。照
 * `part` 画的话，PD040 → PD231 那一截是进近色实线，接着线回到跑道头，再从跑道头画虚线
 * 去 PD231 —— 图上是一根实线的发卡弯，死胡同，复飞看起来从错的地方开始。
 *
 * 所以 final 里第一条爬升/航向腿起的那几条归复飞段。复飞段已经把它们的定位点都走过一
 * 遍时（37 条里 31 条）它们只是一份截断的副本，丢掉；否则接在复飞段前面（复飞段是空
 * 的，或者从它们之后接着走）。
 */
function finalAndMissed(path: ProcedureLeg[]): {
  final: ProcedureLeg[];
  missed: ProcedureLeg[];
} {
  const final = path.filter(
    (l) => l.part !== "transition" && l.part !== "missed",
  );
  const missed = path.filter((l) => l.part === "missed");
  const cut = final.findIndex((l) =>
    CLIMB_LEG.test((l.path ?? "").toUpperCase()),
  );
  if (cut <= 0) return { final, missed };
  const tail = final.slice(cut).map((l) => ({ ...l, part: "missed" }));
  const seen = new Set(missed.map((l) => l.ident).filter(Boolean));
  const repeated =
    missed.length > 0 && tail.every((l) => !l.ident || seen.has(l.ident));
  return {
    final: final.slice(0, cut),
    missed: repeated ? missed : [...tail, ...missed],
  };
}

function dedupeAdjacentLegs(legs: ProcedureLeg[]): ProcedureLeg[] {
  const out: ProcedureLeg[] = [];
  for (const leg of legs) {
    const prev = out[out.length - 1];
    // 等待腿和它前一条同一个定位点，但它是另一件事（在这里等待），留着。
    // 没坐标又没代号的腿（`CA` 接 `CA`）是两条不同的腿，不是重复 —— 比 null === null 会把
    // 第二条连同它的转弯方向一起收掉。
    const same =
      prev && !isHoldLeg(leg.path)
        ? leg.ident && prev.ident
          ? leg.ident === prev.ident
          : leg.lat != null &&
            leg.lon != null &&
            leg.lat === prev.lat &&
            leg.lon === prev.lon
        : false;
    if (same) continue;
    out.push(leg);
  }
  return out;
}

/**
 * 一条程序可选的转换名：SID/STAR 是具名的航路转换，进近是进近转换。跑道转换和公共
 * 段不在其中，它们由跑道决定。
 */
export function procedureTransitions(p: Procedure): string[] {
  const path = p.path ?? [];
  const names = new Set<string>();
  const byPart = p.kind === "approach" && path.some((l) => l.part);
  for (const leg of path) {
    const name = (leg.transition ?? "").trim();
    if (!name || name === "ALL") continue;
    if (byPart) {
      if (leg.part === "transition") names.add(name);
      continue;
    }
    if (RUNWAY_TRANSITION.test(name)) continue;
    names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** 连续一段同名转换的腿。`kind` 由名字定：跑道转换、公共段、具名的航路转换。 */
interface TransitionRun {
  name: string;
  kind: "runway" | "common" | "enroute";
  legs: ProcedureLeg[];
}

/**
 * 把腿按转换切成**连续的段**，不是按名字归组。
 *
 * **同一个名字可以出现不止一段。** NAIP 常把一条跑道转换的尾巴标成 `ALL`：ZBAA 的
 * `OMDE9Z` 是 `RW01 · ALL(AA137 AA197) · RW36L · RW36R · ALL(AA197 OMDEK)`，前一个
 * `ALL` 其实是 RW01 那条的后半截。按名字归组会把两段 `ALL` 并成一个公共段，于是 36L
 * 画成 `…AA197 AA137 AA197 OMDEK` —— 一根出去又折回来的刺，而每一段本身都画得很漂亮。
 * 53 条 SID 和 5 条 STAR 是这样（ZSSS `SASAN7`、ZWWW `FKG5L` 是航路转换夹着 `ALL`）。
 *
 * 判据：夹在**两段同类转换之间**的 `ALL` 属于它前面那一段。边上的 `ALL` 仍是公共段 ——
 * 公共段排在跑道转换前面的 SID（NAIP 里 28 条）靠的就是这一条。
 *
 * 那截尾巴也可能**紧贴着真正的公共段**，名字相同、连成一片：ZSPD `SURAK1` 的最后是
 * `RW35R:…PD510 ALL:NINAS ALL:LASAN ALL:LASAN(IF) ALL:BOLEX…`。能分开它们的只有接缝
 * 上那个重复的起始点 —— 后一段以 `IF` 从同一个点起头。所以一条重复前一个代号的 `IF`
 * 腿另起一段；前面那截夹在转换和公共段之间，同样归前面那条转换。
 */
function transitionRuns(p: Procedure): TransitionRun[] {
  const raw: TransitionRun[] = [];
  for (const leg of p.path ?? []) {
    const name = leg.transition ?? "";
    const last = raw[raw.length - 1];
    const prevLeg = last?.legs[last.legs.length - 1];
    // 只在公共段里切：别的转换切开了，按外端挑航路转换时会丢掉前半截。
    const restart =
      last?.kind === "common" &&
      (leg.path ?? "").toUpperCase() === "IF" &&
      Boolean(leg.ident) &&
      leg.ident === prevLeg?.ident;
    if (last && last.name === name && !restart) {
      last.legs.push(leg);
      continue;
    }
    const kind =
      name === "" || name === "ALL"
        ? "common"
        : RUNWAY_TRANSITION.test(name)
          ? "runway"
          : "enroute";
    raw.push({ name, kind, legs: [leg] });
  }
  const out: TransitionRun[] = [];
  for (let i = 0; i < raw.length; i++) {
    const run = raw[i];
    const prev = out[out.length - 1];
    const next = raw[i + 1];
    if (
      run.kind === "common" &&
      prev &&
      next &&
      prev.kind !== "common" &&
      (prev.kind === next.kind || next.kind === "common")
    ) {
      out[out.length - 1] = { ...prev, legs: [...prev.legs, ...run.legs] };
      continue;
    }
    out.push({ ...run, legs: [...run.legs] });
  }
  return out;
}

/** 航路转换接航路网的那一端：SID 是末点，STAR 是首点。 */
function outerLeg(p: Procedure, run: TransitionRun): ProcedureLeg | undefined {
  return p.kind === "star" ? run.legs[0] : run.legs[run.legs.length - 1];
}

export function procedureTrack(
  p: Procedure,
  opts: TrackOptions = {},
): ProcedureLeg[] {
  if (p.kind === "approach" && (p.path ?? []).some((l) => l.part)) {
    return approachTrack(p, opts);
  }
  // 只有一个名字就是「没有转换」，原样返回 —— 分段不该改变这类程序的任何行为。
  if (new Set((p.path ?? []).map((l) => l.transition ?? "")).size <= 1) {
    return [...(p.path ?? [])];
  }

  const wantRunway = (opts.runway ?? "").toUpperCase();

  const runwayLegs: ProcedureLeg[] = [];
  const commonLegs: ProcedureLeg[] = [];
  const enrouteLegs: ProcedureLeg[] = [];
  for (const run of transitionRuns(p)) {
    const { name, legs } = run;
    if (run.kind === "runway") {
      const rw = RUNWAY_TRANSITION.exec(name);
      if (rw && wantRunway && runwayMatches(rw[1], wantRunway)) {
        runwayLegs.push(...legs);
      }
      continue;
    }
    if (run.kind === "common") {
      commonLegs.push(...legs);
      continue;
    }
    // 具名的航路转换。选定了就只认名字；没选时按接入点猜 —— 名字就是接入点，但按
    // **腿**判更稳：汇编偶尔用别名。
    if (opts.transition) {
      if (name.toUpperCase() === opts.transition.toUpperCase()) {
        enrouteLegs.push(...legs);
      }
      continue;
    }
    if (!opts.enrouteFix) continue;
    if (
      name === opts.enrouteFix ||
      outerLeg(p, run)?.ident === opts.enrouteFix
    ) {
      enrouteLegs.push(...legs);
    }
  }

  const ordered =
    p.kind === "star"
      ? [...enrouteLegs, ...commonLegs, ...runwayLegs]
      : [...runwayLegs, ...commonLegs, ...enrouteLegs];

  // 一段都没挑中时退回整串 —— 宁可画一团，也不能让这条程序从图上消失。
  if (!ordered.length) return [...(p.path ?? [])];

  // **接缝上的那个点是同一个点。** 一个航路转换从公共段结束的地方开始（ARINC 的常态），
  // 所以两组接起来会出现连着两个 ELKUR。收掉，否则腿表里多一行、地图上多一条零长腿 ——
  // 而零长腿会让 MapLibre 的碰撞检测随缩放随机藏掉一个标注，表现是标注忽隐忽现。
  //
  // 只收**相邻**的重复，和 composeRoutePoints 同一条规矩：一条程序合法地两次经过同一个
  // 点（等待、折返），全局去重会把中间那一整段吃掉。代号为空的腿比坐标。
  return dedupeAdjacentLegs(ordered);
}

/**
 * 一条程序实际飞的那几段里，最后一个画得出来的定位点。进近转换按它猜（STAR 的终点）。
 * 地图（`composeRoutePoints`）和腿表都从这里取，两边才会挑中同一条转换。
 */
export function trackEndIdent(
  p: Procedure,
  opts: TrackOptions = {},
): string | null {
  const legs = procedureTrack(p, opts).filter(
    (l) => l.ident && l.lat != null && l.lon != null,
  );
  return legs[legs.length - 1]?.ident || null;
}

export function procedureToMapPoints(
  p: Procedure,
  opts: TrackOptions & {
    /** 机场磁差，西为正。等待腿的磁航向靠它换成真方位。 */
    variation?: number;
  } = {},
): MapPoint[] {
  const out: MapPoint[] = [];
  // 已经从后面的腿拿到转弯方向的那个点（下标）。见下面「转弯方向」。
  let turned = -1;
  for (const leg of procedureTrack(p, opts)) {
    // **转弯方向记在这条腿的起点上，不是终点。** ARINC 424 的转弯方向说的是转上这条
    // 腿的那个弯，它发生在上一个定位点。记到终点上，画线时会在终点按这个方向强转 ——
    // ZGDY `HUY2D` 的 `DF DG964 L` 说的是在 DG462 左转，DG964 那里其实右转 12°，记错
    // 了就在 DG964 画出一圈 348° 的左转。
    //
    // 起点没画出来（`CA` 之类没有坐标的腿）时记到最后画出的那个点上。一个点只收第一
    // 个：它才是在这个点上的那个弯，后面的发生在没画出来的地方。等待腿的方向是等待自
    // 己的；`RF` 的方向是那段弧的，弧从起点相切出去，起点上没有弯 —— 两者都不往前记。
    const turn = (leg.turn ?? "").toUpperCase();
    const last = out.length - 1;
    if (
      (turn === "L" || turn === "R") &&
      !isHoldLeg(leg.path) &&
      (leg.path ?? "").toUpperCase() !== "RF" &&
      last >= 0 &&
      turned !== last
    ) {
      out[last] = { ...out[last], turn };
      turned = last;
    }
    if (leg.lat == null || leg.lon == null) continue;
    // 等待腿挂到它的定位点上，不另起一个点。定位点就是上一个点时挂到上一个点上。
    if (isHoldLeg(leg.path) && leg.courseMag != null) {
      const hold = holdShape({
        inboundMag: leg.courseMag,
        variationWest: opts.variation ?? 0,
        turn: leg.turn,
      });
      const prev = out[out.length - 1];
      if (
        prev &&
        (prev.ident === leg.ident ||
          (prev.lat === leg.lat && prev.lon === leg.lon))
      ) {
        out[out.length - 1] = { ...prev, hold };
        continue;
      }
      out.push({
        ident: leg.ident || "",
        lat: leg.lat,
        lon: leg.lon,
        kind: p.kind,
        via: p.name,
        hold,
      });
      continue;
    }
    out.push({
      ident: leg.ident || "",
      lat: leg.lat,
      lon: leg.lon,
      kind: p.kind,
      via: p.name,
      ...(leg.flyover ? { flyover: true } : {}),
    });
  }
  return out;
}

// ------------------------------------------------------------------ 衔接

/**
 * 程序和航路衔不衔接得上。
 *
 * **这是这个功能最容易安静出错的一处。** 换一条 SID 之后，如果它的最后一个点不
 * 是航路的第一个点，填出来的航路串是**断的** —— 而它在图上看起来完全正常（两段
 * 线都在，中间连一条直线），在计划表格里也正常（一串合法的代号）。管制员那边才
 * 会发现。
 *
 * 所以换程序这件事必须带着这个判断一起做，而不是换完就算。返回：
 *
 *   `true`   衔接上了
 *   `false`  接不上 —— 界面必须说出来，且要说出**两头各是什么**
 *   `null`   判不了（程序没有可用的点，或者航路那头是空的）—— 不能报成 false，
 *            「不知道」和「不对」是两回事
 */
export function joinsRoute(
  procedure: Procedure | null,
  enrouteIdent: string | null | undefined,
): boolean | null {
  if (!procedure || !enrouteIdent) return null;
  // 端点只由 `joinIdent` 一处决定：它按公共段取，不拿整串首末（跑道转换会排在两头）。
  // 两处各取一次，界面摆出来的「两头」和这里的判断就可能不是同一个点。方向同样在那
  // 里由类别决定，不由调用方传。
  //
  // **航路转换的外端也算接上。** ZSSS `SASAN9` 的航路以 PIMOL 收尾，地图按 PIMOL 那条
  // 转换画得完全正确，公共段的首点却是 SASAN —— 只比公共段就会对一条对的航路喊「接不
  // 上」。按名字或外端那个点认，和 `procedureTrack` 挑转换是同一个判据。
  const want = enrouteIdent.toUpperCase();
  const gates = transitionRuns(procedure)
    .filter((run) => run.kind === "enroute")
    .flatMap((run) => [run.name, outerLeg(procedure, run)?.ident ?? ""]);
  if (gates.some((g) => g && g.toUpperCase() === want)) return true;
  const edge = joinIdent(procedure);
  if (edge == null) return null;
  return edge.toUpperCase() === want;
}

/** 程序和航路相接的那一端的代号 —— 界面要把两头都摆出来，不然「接不上」没法查。 */
export function joinIdent(procedure: Procedure): string | null {
  // **不能拿整串的首末。** 整串的最后一个代号可能落在跑道转换那一组上（NAIP 里 28 条
  // SID 就是这样），于是界面会说「接不上」，而实际上接得上 —— 一个假警报会让人手改
  // 航路串，把本来对的改错。
  //
  // 不给跑道、不给衔接点地调 `procedureTrack`，剩下的正是公共段，它的那一端就是这条
  // 程序接上航路网的地方。
  const idents = procedureTrack(procedure)
    .map((l) => l.ident)
    .filter((i): i is string => Boolean(i));
  if (idents.length === 0) return null;
  return procedure.kind === "sid" ? idents[idents.length - 1] : idents[0];
}

// ------------------------------------------------------------------ 航路串

/**
 * 把选好的 SID / STAR 写回航路串。
 *
 * 规则只有一条：**首尾两个记号如果本来就是程序名，替换；否则插入。** 判断「本来
 * 是不是程序名」靠的是传进来的旧名字，而不是去猜某个记号长得像不像程序 ——
 * `BOTP2G` 和 `BOTPO` 在字符层面分不开，猜错就会把一个航路点当成程序删掉。
 *
 * 传 `null` 表示「不要程序」，传 `""` 表示「不改这一头」。两者必须分开：前者要
 * 删掉已有的，后者要原样留着。
 */
export function rewriteRoute(
  route: string,
  previous: { sid?: string | null; star?: string | null },
  next: { sid?: string | null; star?: string | null },
): string {
  const tokens = route.trim().split(/\s+/).filter(Boolean);

  if (next.sid !== undefined && next.sid !== "") {
    if (previous.sid && tokens[0] === previous.sid) tokens.shift();
    if (next.sid) tokens.unshift(next.sid);
  }
  if (next.star !== undefined && next.star !== "") {
    const last = tokens[tokens.length - 1];
    if (previous.star && last === previous.star) tokens.pop();
    if (next.star) tokens.push(next.star);
  }
  return tokens.join(" ");
}

// ------------------------------------------------------------------ 合成

/**
 * 把两端机场、程序和航路段接成一条画得出来的线。
 *
 * **重复点必须收掉。** SID 的最后一个点常常就是航路的第一个点（那正是「衔接上
 * 了」的意思），照抄的话同一个代号会连着出现两次 —— 地图会为它画一条零长度的
 * 腿。零长腿不报错，但沿线标注会挤在一个点上抢位置，而 MapLibre 的碰撞检测会随
 * 缩放**随机挑一个**藏掉，表现是标注忽隐忽现，没人查得到原因。
 *
 * 收的是**相邻的**重复，不是全局去重：一条航路合法地两次经过同一个点（等待、折
 * 返），全局去重会把中间那一整段吃掉。
 */
/** 进近的复飞段，画成 `kind: "missed"`。腿不带 `part` 的进近分不出复飞，返回空。 */
export function missedApproachPoints(
  approach: Procedure,
  transition?: string | null,
  variation?: number,
): MapPoint[] {
  return missedApproach(approach, transition, variation).points;
}

/**
 * 复飞段的点，外加**转上复飞段的那个弯**（`start`）。
 *
 * 转弯方向记在腿的起点上（见 `procedureToMapPoints`）。复飞段第一条画得出的腿的起点
 * 是复飞点，而复飞点属于最后进近那一段 —— 单算复飞段时这个方向没地方挂，就丢了。所以
 * 带上复飞点一起算，再把它拿到的方向交给调用方挂到复飞点上。
 */
function missedApproach(
  approach: Procedure,
  transition?: string | null,
  variation?: number,
): { points: MapPoint[]; start: Pick<MapPoint, "turn" | "hold"> } {
  const track = procedureTrack(approach, { transition, missed: true });
  const legs = track.filter((l) => l.part === "missed");
  const anchor = track
    .filter((l) => l.part !== "missed" && l.lat != null && l.lon != null)
    .at(-1);
  const withAnchor = anchor
    ? [{ ...anchor, path: "TF", turn: null }, ...legs]
    : legs;
  const points = procedureToMapPoints(
    { ...approach, path: withAnchor },
    { variation },
  );
  const head = anchor ? points.shift() : undefined;
  return {
    points: points.map((p) => ({ ...p, kind: "missed" })),
    // 复飞段以复飞点上的等待起头时（`HM` 挂在复飞点上），等待也在它身上。
    start: { turn: head?.turn, hold: head?.hold },
  };
}

export function composeRoutePoints(parts: {
  departure?: MapPoint | null;
  /** 起飞跑道端。给了就从它的跑道头沿跑道画到另一头，再接 SID。 */
  departureRunway?: AirportRunway | null;
  sid?: Procedure | null;
  /** 起飞跑道。**不给就不画任何跑道转换** —— 见 procedureTrack。 */
  sidRunway?: string | null;
  sidTransition?: string | null;
  enroute?: MapPoint[] | null;
  star?: Procedure | null;
  /** 落地跑道，同上。 */
  starRunway?: string | null;
  starTransition?: string | null;
  approach?: Procedure | null;
  approachTransition?: string | null;
  /** 两端机场的磁差，西为正。等待腿换算真方位用。 */
  departureVariation?: number;
  arrivalVariation?: number;
  /** 落地跑道端。给了就终止在它的跑道头，不画到机场基准点。 */
  arrivalRunway?: AirportRunway | null;
  arrival?: MapPoint | null;
}): MapPoint[] {
  // 衔接点从 `enroute` 自己推：SID 接航路的第一个点，STAR 接最后一个。调用方已经把
  // 航路交过来了，再要它算一遍只是多一处可以算错的地方。
  const first = parts.enroute?.[0]?.ident || null;
  const last = parts.enroute?.[parts.enroute.length - 1]?.ident || null;

  const chain: MapPoint[] = [];
  const depRwy = parts.departureRunway;
  if (depRwy) {
    const ident = `RW${depRwy.id}`;
    chain.push({
      ident,
      lat: depRwy.lat,
      lon: depRwy.lon,
      kind: "sid",
      via: ident,
    });
    chain.push({
      ident: "",
      lat: depRwy.endLat,
      lon: depRwy.endLon,
      kind: "sid",
      via: ident,
      shape: true,
    });
  } else if (parts.departure) {
    chain.push(parts.departure);
  }
  if (parts.sid) {
    const sidPoints = procedureToMapPoints(parts.sid, {
      runway: parts.sidRunway,
      enrouteFix: first,
      transition: parts.sidTransition,
      variation: parts.departureVariation,
    });
    // **SID 从跑道头起头时不再画一遍跑道头。** 上面已经从跑道头画到了另一头；ZGDY
    // `LIN5D` 的第一条腿是 `IF RW08`，照抄的话线从另一头折回跑道头再出去，沿跑道画出一
    // 根来回的线，RW08 的标注也叠成两个。
    const head = sidPoints[0];
    if (
      depRwy &&
      head &&
      (head.ident.toUpperCase() === `RW${depRwy.id}`.toUpperCase() ||
        (head.lat === depRwy.lat && head.lon === depRwy.lon))
    ) {
      sidPoints.shift();
    }
    chain.push(...sidPoints);
  }
  if (parts.enroute) chain.push(...parts.enroute);
  const starPoints = parts.star
    ? procedureToMapPoints(parts.star, {
        runway: parts.starRunway,
        enrouteFix: last,
        transition: parts.starTransition,
        variation: parts.arrivalVariation,
      })
    : [];
  chain.push(...starPoints);
  if (parts.approach) {
    const starEnd =
      (parts.star &&
        trackEndIdent(parts.star, {
          runway: parts.starRunway,
          enrouteFix: last,
          transition: parts.starTransition,
        })) ||
      last ||
      null;
    chain.push(
      ...procedureToMapPoints(parts.approach, {
        runway: parts.starRunway,
        enrouteFix: starEnd,
        transition: parts.approachTransition,
        missed: false,
        variation: parts.arrivalVariation,
      }),
    );
  }
  // 复飞段从复飞点接着画，自成一段（`kind: "missed"`）。
  const { points: missed, start: missedStart } = parts.approach
    ? missedApproach(
        parts.approach,
        parts.approachTransition,
        parts.arrivalVariation,
      )
    : { points: [], start: {} };
  // 转上复飞段的那个弯（和复飞点上的等待）挂到复飞点上：此刻线上最后一个点。跑道头和
  // 机场点还没接上 —— 挂到它们身上就错了。
  if (missedStart.turn || missedStart.hold) {
    const i = chain.findLastIndex((q) => !q.offPath);
    if (i >= 0) {
      chain[i] = {
        ...chain[i],
        ...(missedStart.turn && !chain[i].turn
          ? { turn: missedStart.turn }
          : {}),
        ...(missedStart.hold && !chain[i].hold
          ? { hold: missedStart.hold }
          : {}),
      };
    }
  }
  const arrRwy = parts.arrivalRunway;
  if (arrRwy) {
    chain.push({
      ident: `RW${arrRwy.id}`,
      lat: arrRwy.lat,
      lon: arrRwy.lon,
      kind: parts.approach ? "approach" : parts.star ? "star" : "fix",
    });
  } else if (parts.arrival) {
    // 有复飞段时线不回到机场基准点：机场只留标注（offPath），线从复飞点接下去。
    chain.push(
      missed.length ? { ...parts.arrival, offPath: true } : parts.arrival,
    );
  }
  chain.push(...missed);

  const out: MapPoint[] = [];
  for (const p of chain) {
    const prev = out[out.length - 1];
    // 代号相同，或者坐标完全相同，就是同一个点。只比代号不够：ZSPD 的复飞点 PD040 就
    // 在 34L 的跑道头上，两个名字各出一个标注，叠在一起谁也读不出来，中间还夹一条零长
    // 腿。留先到的那个（程序自己的定位点，和腿表一致）。无名的腿（`CA`/`VI` 那类）只能
    // 比坐标。
    const same = prev
      ? (Boolean(p.ident) && p.ident === prev.ident) ||
        (p.lat === prev.lat && p.lon === prev.lon)
      : false;
    if (same) {
      // 收掉的那个点可能挂着等待（STAR 终点和进近起点是同一个点时常见），并过去。转弯
      // 方向同理：进近第二条腿转上去的那个弯记在进近的首点上，而首点正是被收掉的这个。
      let kept = prev;
      if (p.hold && !kept.hold) kept = { ...kept, hold: p.hold };
      if (p.turn && !kept.turn) kept = { ...kept, turn: p.turn };
      out[out.length - 1] = kept;
      continue;
    }
    out.push(p);
  }
  return out;
}
