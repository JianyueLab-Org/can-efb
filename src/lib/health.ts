/**
 * `/health` 的检查逻辑：给外部可用性监控用，不给 kubelet 用。
 *
 * 每项检查 3 秒超时；整体结果每个进程缓存 10 秒，刷新期间并发请求共用同一次检查。
 */
export type Check = (signal: AbortSignal) => Promise<void>;

export interface HealthResult {
  status: "ok" | "fail";
  checks: Record<string, string>;
}

const CHECK_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 10_000;

/** 上游 `/health` 非 2xx 即失败。 */
export function upstreamCheck(
  url: string,
  fetcher: typeof fetch = fetch,
): Check {
  return async (signal) => {
    const res = await fetcher(url, { signal, cache: "no-store" });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`status ${res.status}`);
  };
}

async function runCheck(check: Check): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
  try {
    await check(ctl.signal);
    return "ok";
  } catch (err) {
    if (ctl.signal.aborted) return "timeout";
    return err instanceof Error && err.message.startsWith("status ")
      ? err.message
      : "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export function createHealth(
  checks: Record<string, Check>,
  now: () => number = Date.now,
): () => Promise<HealthResult> {
  let cached: { at: number; result: HealthResult } | null = null;
  let inflight: Promise<HealthResult> | null = null;

  async function refresh(): Promise<HealthResult> {
    const names = Object.keys(checks);
    const values = await Promise.all(names.map((n) => runCheck(checks[n])));
    const out: Record<string, string> = {};
    names.forEach((n, i) => (out[n] = values[i]));
    const failed = values.some((v) => v !== "ok");
    if (failed) console.warn("health check failed", out);
    const result: HealthResult = {
      status: failed ? "fail" : "ok",
      checks: out,
    };
    cached = { at: now(), result };
    return result;
  }

  return () => {
    if (cached && now() - cached.at < CACHE_TTL_MS)
      return Promise.resolve(cached.result);
    inflight ??= refresh().finally(() => (inflight = null));
    return inflight;
  };
}

export function healthResponse(result: HealthResult): Response {
  return new Response(JSON.stringify(result), {
    status: result.status === "ok" ? 200 : 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
