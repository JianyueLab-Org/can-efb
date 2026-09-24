/**
 * 反代里公开路径的进程内缓存。
 *
 * **为什么要有它。** 反代转给 can-api 的只有 cookie 和 content-type，没有客户端
 * IP —— can-api 看到的永远是集群出口那一个地址。于是它按 IP 计的限流（METAR 每
 * 小时 60 次、航路展开 120 次）不是每个成员一份，而是**全站所有成员共用一份**：
 * 十来个人同时打开概览页，桶就空了，之后每个人拿到的都是 429。
 *
 * 缓存把「同一个问题」收拢成一次上游请求，和 can-radar 给 METAR 放五分钟是同一个
 * 思路。它只该用在**答案与请求者无关**的路径上 —— 会话、飞行计划、SimBrief 这些
 * 按 cookie 回答的东西绝不能进来，否则一个成员的数据会被发给下一个人。能进的路径
 * 在白名单里逐条标注，这个模块本身不判断。
 *
 * 只存成功的响应：把一次 429 或 502 记五分钟，等于把一次上游抖动放大成五分钟的
 * 故障。
 *
 * 容量有上限，满了先丢最早放进来的那条 —— 键里带着成员输入的航路串，不设上限就
 * 是一个任何人都能灌满内存的口子。
 */

export interface CachedResponse {
  status: number;
  /** 只存 content-type 这类与请求者无关的头；set-cookie 绝不进来。 */
  headers: [string, string][];
  body: ArrayBuffer;
}

interface Entry {
  value: CachedResponse;
  expires: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): CachedResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: CachedResponse, ttlMs: number): void {
    // 先删再插，让重新写入的键排到 Map 的末尾 —— 淘汰按插入顺序走。
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: this.now() + ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}

/** 上游会 trim + 转大写再用的参数；这里先做一遍，让大小写不同的同一个问题共用一条。 */
const ICAO_PARAMS = new Set(["icao", "departure", "arrival"]);

/**
 * 缓存键：路径 + 排过序、归一化过的查询串。
 *
 * 排序是因为 `?a=1&b=2` 和 `?b=2&a=1` 是同一个问题。机场代码按上游的规矩归一；
 * 航路串只 trim，不改大小写 —— 那是上游怎么解释它的事，这里不替它决定。
 */
export function cacheKey(path: string, search: URLSearchParams): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of search) {
    const trimmed = value.trim();
    pairs.push([name, ICAO_PARAMS.has(name) ? trimmed.toUpperCase() : trimmed]);
  }
  pairs.sort(([a, x], [b, y]) =>
    a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
  );
  return path + "?" + new URLSearchParams(pairs).toString();
}

/**
 * 只留下 `names` 里的参数，每个取第一个值 —— 和 Go 的 `Query().Get` 读法一致。
 * 其余参数一律丢掉：上游不读它们，留着只会把同一个问题拆成不同的缓存键。
 */
export function pickParams(
  search: URLSearchParams,
  names: readonly string[],
): URLSearchParams {
  const out = new URLSearchParams();
  for (const name of names) {
    const value = search.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}
