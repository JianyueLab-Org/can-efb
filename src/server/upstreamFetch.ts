/**
 * 反代用的 fetch：超时**只管到响应头到达为止**。
 *
 * 为什么不用 `AbortSignal.timeout()`：那个信号在整个请求的生命期里都挂着，包括
 * 之后把 body 流给浏览器的那一段。反代把 `upstream.body` 原样交给 `Response`，
 * 于是一个慢客户端（机上 Wi-Fi、弱信号的平板）下载几百 KB 的航路网时，只要总
 * 用时过了 15 秒，流就被从中间掐断 —— 而状态码早已是 200 发出去了，浏览器看到
 * 的是一个被截断的 JSON，报的是解析错误，不是超时。
 *
 * 这里要防的只是「上游迟迟不回话」。头一到，上游就已经在回答了，剩下的快慢取决
 * 于客户端那一头，不该由我们替它计时。
 */
export async function fetchHeadersWithin(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("upstream timed out", "TimeoutError")),
    timeoutMs,
  );
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把上游的 `Set-Cookie` 逐条抄到 `out` 上。
 *
 * `headers.get("set-cookie")` 会把多条用逗号拼成一条，而 cookie 的 `Expires`
 * 里本身就带逗号 —— 拼起来的那一行浏览器没法再拆开，结果是一条都设不对。
 * `getSetCookie()` 是 Fetch 规范专为这件事留的口子。
 */
export function copySetCookies(from: Headers, out: Headers): void {
  for (const value of from.getSetCookie()) out.append("set-cookie", value);
}
