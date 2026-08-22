import type { MapPoint } from "@/lib/mapBus";

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
  /** `-` 上限 | `+` 下限 | null 就是那个数。 */
  speedKind: string | null;
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

/** 详情接口里我们要的那两块。其余字段还在，只是这个模块不关心。 */
export interface AirportProcedures {
  icao: string;
  runways: AirportRunway[];
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
  const response = await fetch(`/api/db/aip/airports/${code}`);
  if (!response.ok) throw new ProcedureError(response.status);
  const data = unwrapObject<AirportProcedures>(await response.json());
  if (!data) throw new ProcedureError(response.status);
  return {
    icao: data.icao ?? code,
    runways: data.runways ?? [],
    procedures: data.procedures ?? [],
  };
}

// ------------------------------------------------------------------ 跑道

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
  return list.includes(runway.toUpperCase());
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
  return p.variant ? `${p.name}-${p.variant.toUpperCase()}` : p.name;
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
export function procedureToMapPoints(p: Procedure): MapPoint[] {
  const out: MapPoint[] = [];
  for (const leg of p.path ?? []) {
    if (leg.lat == null || leg.lon == null) continue;
    out.push({
      ident: leg.ident || "",
      lat: leg.lat,
      lon: leg.lon,
      kind: p.kind,
      via: p.name,
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
  const idents = (procedure.path ?? [])
    .map((l) => l.ident)
    .filter((i): i is string => Boolean(i));
  if (idents.length === 0) return null;
  // SID 的出口是最后一个点，STAR 的入口是第一个点 —— 进近同 STAR（它接在 STAR
  // 后面）。方向由类别决定，不由调用方传，免得两边各判一次而判反。
  const edge = procedure.kind === "sid" ? idents[idents.length - 1] : idents[0];
  return edge.toUpperCase() === enrouteIdent.toUpperCase();
}

/** 程序和航路相接的那一端的代号 —— 界面要把两头都摆出来，不然「接不上」没法查。 */
export function joinIdent(procedure: Procedure): string | null {
  const idents = (procedure.path ?? [])
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
export function composeRoutePoints(parts: {
  departure?: MapPoint | null;
  sid?: Procedure | null;
  enroute?: MapPoint[] | null;
  star?: Procedure | null;
  approach?: Procedure | null;
  arrival?: MapPoint | null;
}): MapPoint[] {
  const chain: MapPoint[] = [];
  if (parts.departure) chain.push(parts.departure);
  if (parts.sid) chain.push(...procedureToMapPoints(parts.sid));
  if (parts.enroute) chain.push(...parts.enroute);
  if (parts.star) chain.push(...procedureToMapPoints(parts.star));
  if (parts.approach) chain.push(...procedureToMapPoints(parts.approach));
  if (parts.arrival) chain.push(parts.arrival);

  const out: MapPoint[] = [];
  for (const p of chain) {
    const prev = out[out.length - 1];
    // 代号为空的腿（`CA`/`VI` 那类）比不了代号，改比坐标 —— 否则连着两条无名腿
    // 会被当成同一个点收掉，而它们是两个不同的位置。
    const same = prev
      ? p.ident && prev.ident
        ? p.ident === prev.ident
        : p.lat === prev.lat && p.lon === prev.lon
      : false;
    if (same) continue;
    out.push(p);
  }
  return out;
}
