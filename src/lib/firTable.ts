/**
 * 区调呼号 → 它工作的那几块空域。
 *
 * **逐字取自 can-radar 的 `src/lib/firs.ts`**，只改了两处：对照表从 `src/` 里
 * `?url` 引进来（和 `lib/firs.ts` 同一个理由，哈希文件名才拿得到长缓存），以及多
 * 了一个给测试用的 `useFirTable`。改判据先改 can-radar 那一份，再同步过来。
 * 文件名不叫 `firs.ts`，因为这个站的 `lib/firs.ts` 已经是情报区图层那一份。
 *
 * 数据（`src/basemap/atc/firs.json`、`boundaries.geojson`）同样是 can-radar
 * `public/` 下那几份的拷贝，由它的 `scripts/build-vatspy.mjs` 生成；刷新时在那边
 * 重跑再拷过来，不在这里手改。
 *
 * `boundaries.geojson` 里的多边形只带一个 id（`KZME`、`RJDG-F01`），而管制员登
 * 录时用的是另一套写法（`MEM_22_CTR`、`RJDG_01_CTR`）。**两者之间的对照表在
 * VATSpy.dat 的 `[FIRs]`/`[UIRs]` 段里**，这个仓库以前没有那份数据，于是靠一堆
 * 手写规则去猜：拿呼号和边界 id 互相 `startsWith`、把 `A_B_CTR` 读成 `A-B` 扇
 * 区、再加三条写死的 `lax→kzla` / `hkg→vhhk` / `tpe→rcaa`。
 *
 * 猜得中的只有一种情况：**呼号第一段就是边界 id**。中国和港台的席位恰好都是这
 * 样（`ZSHA_CTR` → `ZSHA`），所以本网自己的空域一直是对的，而北美整个错过 ——
 * 美国的呼号前缀是三字代码（孟菲斯是 `MEM`，边界 id 是 `KZME`），两串字符没有
 * 任何公共前缀，于是 `MEM_22_CTR` 上线时地图上既不高亮空域、也不出标牌，整个席
 * 位等于不存在。日本的小扇区错得更隐蔽：`RJDG_01_CTR` 会匹配上父 FIR `RJDG`，
 * 于是「有人管福冈 F01 扇区」画成了「有人管整个福冈」。
 *
 * 现在按 vatsim-radar 的做法来（`app/composables/vatsim/enroute.ts` 和
 * `app/composables/render/update/atc.ts` 是同一套判据的两处实现）：把对照表编译
 * 成 `public/firs.json`，运行时按**最长前缀**匹配。生成见
 * `scripts/build-vatspy.mjs`。
 */

import FIR_TABLE_URL from "@/basemap/atc/firs.json?url";

/** 一条 `[FIRs]`：某个呼号前缀对应某一块边界。 */
export interface FirEntry {
  /** 呼号前缀，`MEM`、`RJDG_01`、`ZSHA`。 */
  prefix: string;
  /** `boundaries.geojson` 里的要素 id。 */
  boundary: string;
  /** FIR/扇区名，详情卡上那一行。 */
  name: string;
}

/** 一条 `[UIRs]`：一个人管着好几个 FIR。 */
export interface UirEntry {
  prefix: string;
  name: string;
  boundaries: string[];
}

export interface FirTable {
  /** 生成这份表所用的 VATSpy 上游 commit。 */
  version: string;
  firs: FirEntry[];
  uirs: UirEntry[];
}

/** 一次匹配的结果。 */
export interface FirMatch {
  /** 要点亮的边界 id，至少一个。 */
  boundaries: string[];
  /** 匹配到的那条的名字，用来给席位一个人话标题。 */
  name: string;
}

let table: FirTable | null = null;
let request: Promise<FirTable | null> | null = null;

/**
 * 按呼号第一段建的索引。
 *
 * 表里一千五百条，而每次匹配只可能落在同一个「首段」上（`MEM_22_CTR` 只需要看
 * `MEM` 开头的那几条）—— 不建索引就是每个席位每一轮刷新扫一遍全表。
 */
const firsByHead = new Map<string, FirEntry[]>();
const uirsByHead = new Map<string, UirEntry[]>();
/**
 * VATSpy 边界 id 的短名 → 那些 id。`RJTG-T30` 的短名是 `T30`，也就是 ATC info
 * 里 `Covering sector - T30` 写的那个。
 */
const sectorIdsByName = new Map<string, string[]>();

function index(entries: FirTable) {
  firsByHead.clear();
  uirsByHead.clear();
  sectorIdsByName.clear();
  for (const entry of entries.firs) {
    const head = entry.prefix.split("_")[0];
    const list = firsByHead.get(head);
    if (list) list.push(entry);
    else firsByHead.set(head, [entry]);

    const dash = entry.boundary.lastIndexOf("-");
    if (dash < 0) continue;
    const name = entry.boundary.slice(dash + 1).toUpperCase();
    const ids = sectorIdsByName.get(name);
    if (!ids) sectorIdsByName.set(name, [entry.boundary]);
    else if (!ids.includes(entry.boundary)) ids.push(entry.boundary);
  }
  for (const entry of entries.uirs) {
    const head = entry.prefix.split("_")[0];
    const list = uirsByHead.get(head);
    if (list) list.push(entry);
    else uirsByHead.set(head, [entry]);
  }
}

/** 取一次对照表，进程内只取一次。失败返回 null —— 地图照常画，只是没人高亮。 */
export async function loadFirs(): Promise<FirTable | null> {
  if (table) return table;

  request ??= fetch(FIR_TABLE_URL)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((data: FirTable | null) => {
      if (data?.firs?.length) {
        table = data;
        index(table);
      }
      return table;
    });

  return request;
}

/** 直接装一份表，不走网络。测试用。 */
export function useFirTable(data: FirTable): void {
  table = data;
  index(table);
}

/** 已经取到的那份表，还没取到就是 null。 */
export function loadedFirs(): FirTable | null {
  return table;
}

/**
 * 前缀必须落在下划线的分界上。
 *
 * vatsim-radar 那边是裸的 `callsign.startsWith(prefix)`，而 VATSpy 里既有
 * `RJTG_O`（东京 T36 扇区）又有 `RJTG`，裸判断会让 `RJTG_OCEANIC_CTR` 命中
 * `RJTG_O` —— 一个管海洋区的人被画进了本州上空一块小扇区里。呼号本来就是按下
 * 划线分段的，按段比较不会更严，只会更准。
 */
function startsWithSegment(callsign: string, prefix: string): boolean {
  return callsign === prefix || callsign.startsWith(`${prefix}_`);
}

/**
 * 这个呼号工作哪几块空域。
 *
 * **最长前缀赢**，这是全部规则。`RJDG_01_CTR` 同时匹配 `RJDG`（福冈全境）和
 * `RJDG_01`（F01 扇区），取后者；`RJDG_CTR` 只匹配得上前者，于是拿到整个 FIR
 * 而不会连它的分扇区一起点亮。上游还有一条「呼号去掉最后一段正好等于前缀就直
 * 接判胜」的特例，这里没有：按段匹配之下，能匹配的最长前缀本来就是「去掉最后
 * 一段」那一个，那条特例是它的子集。
 *
 * `[UIRs]` 先看 —— 一个 UIR 呼号（`PRC_FSS`、`ASEA_FSS`）管的是一串 FIR，而它
 * 的前缀也可能同时是某个 FIR 的前缀，那种情况下该画的是一串而不是一块。
 */
export function firMatch(callsign: string): FirMatch | null {
  if (!table) return null;

  // 数据源里偶尔有连着两个下划线的呼号；VATSpy 的前缀一律是单个。
  const normalized = callsign.toUpperCase().trim().replace(/_+/g, "_");
  if (!normalized) return null;
  const head = normalized.split("_")[0];

  let uirMatch: FirMatch | null = null;
  let uirBest = 0;
  for (const uir of uirsByHead.get(head) ?? []) {
    if (!startsWithSegment(normalized, uir.prefix)) continue;
    if (uir.prefix.length <= uirBest) continue;
    uirBest = uir.prefix.length;
    uirMatch = { boundaries: [...uir.boundaries], name: uir.name };
  }
  if (uirMatch) return uirMatch;

  let best = 0;
  let boundaries: string[] = [];
  let name = "";
  for (const fir of firsByHead.get(head) ?? []) {
    if (!startsWithSegment(normalized, fir.prefix)) continue;
    if (fir.prefix.length < best) continue;
    if (fir.prefix.length > best) {
      best = fir.prefix.length;
      boundaries = [];
      name = fir.name;
    }
    if (!boundaries.includes(fir.boundary)) boundaries.push(fir.boundary);
  }

  return boundaries.length ? { boundaries, name } : null;
}

/**
 * 这个席位要的是海上那一半还是陆上那一半。
 *
 * 只有 `KZNY` 和 `SUEO` 是一个 id 底下同时挂着两个要素（一块陆地、一块公海），
 * 判据照 vatsim-radar：`_FSS` 要海上的，别的要陆上的。它是**同一个 id 的两个要
 * 素之间挑一个**，不是过滤条件 —— 绝大多数 id 只有一个要素，挑不到就用它。
 *
 * 东京以前也在这张表上（`RJTG` 一个 id 两块地），所以这里原本还认 `_O_` /
 * `_OCEANIC_`。上游已经把东京海洋区拆成独立的 `RJJJ`，而 `RJTG_O` 现在是 T36
 * 扇区的前缀 —— 再认 `_O_` 就会把 T36 判成海洋区。
 */
export function prefersOceanic(callsign: string): boolean {
  return callsign.toUpperCase().trim().endsWith("_FSS");
}

/**
 * ATC info 里的扇区短名（`T30`、`F01`）对应哪几块 VATSpy 边界。
 *
 * 短名是边界 id 连字符后面那一段。全世界不止一个 `E` / `N`，所以：唯一就直接
 * 用；不唯一时拿呼号第一段收窄到同一个 FIR（`RJTG_CTR` + `E` → `RJTG-E`）；
 * 还是不唯一就当作认不出，总比把半个地球点亮好。
 *
 * 表还没取回来时返回空，和 `firMatch` 同一条规矩。
 */
export function boundariesForSectorName(
  name: string,
  hintCallsign?: string,
): string[] {
  const token = name.toUpperCase().trim();
  if (!token || !table) return [];

  const ids = sectorIdsByName.get(token);
  if (!ids?.length) return [];
  if (ids.length === 1) return [...ids];

  const head = hintCallsign?.toUpperCase().trim().split("_")[0];
  if (head) {
    const scoped = ids.filter((id) => id === head || id.startsWith(`${head}-`));
    if (scoped.length) return scoped;
  }

  return [];
}
