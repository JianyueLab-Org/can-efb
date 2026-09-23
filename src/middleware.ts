import { defineMiddleware } from "astro:middleware";
import { resolveSession } from "@/server/canApi";
import { signInUrl } from "@/lib/config";

/**
 * 每个请求先问一次 can-api「你是谁」，答案放进 `Astro.locals.user`。
 *
 * **这个站整站都要登录**，所以没有 PROTECTED_PREFIXES 这样一份清单 —— 清单的
 * 意义在于区分公开页和受保护页，而 EFB 一页公开的都没有：航图、计划、日志全
 * 是「这名飞行员自己的」。反过来说，将来真要开一个公开页（比如分享一份放行
 * 单），得在这里显式开口子，而不是默认就开着。
 *
 * 例外只有 `/api/*`：那是本站的反代，它自己有白名单，而且它的调用方要的是状态
 * 码不是 302 —— 把一个 fetch 重定向到登录页，岛屿拿到的会是一段 HTML。
 *
 * 重定向去的是 **can-web 的登录页**：EFB 自己没有登录页，也不该有。会话由
 * can-api 在父域上签发，主站上登录过的成员到这里本来就带着 cookie。
 * `signInUrl()` 会把当前地址当 callbackUrl 带上，成员登录完直接回到他本来要去
 * 的那一页 —— can-web 那边有一份显式白名单接住它，这个域在名单上。
 */
/**
 * 不问会话、也不重定向的两条路径。
 *
 * - `/api/` 是本站的反代，它自己有白名单，而且调用方要的是状态码不是 302 ——
 *   把一个 fetch 重定向到登录页，岛屿拿到的会是一段 HTML。
 * - `/healthz` 是探活，理由写在那个文件里：它必须能在 can-api 挂掉时照样回
 *   200，否则上游一抖，kubelet 就会把这边的 Pod 一起滚掉。
 */
function isUnguarded(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/healthz";
}

export const onRequest = defineMiddleware(async (context, next) => {
  if (isUnguarded(context.url.pathname)) {
    context.locals.user = null;
    return withSecurityHeaders(await next());
  }

  const session = await resolveSession(context);

  // can-api 没给出答案时回 503，**不重定向**：这时成员多半是登录着的，把他踢去
  // 登录页只会让一次上游故障看起来像被登出，而且登录完回来还是同一个故障。
  if (session.status === "unavailable") {
    context.locals.user = null;
    return withSecurityHeaders(unavailable());
  }

  if (session.status === "anonymous") {
    context.locals.user = null;
    return withSecurityHeaders(context.redirect(signInUrl(context.url)));
  }

  context.locals.user = session.user;
  return withSecurityHeaders(await next());
});

/**
 * can-api 不可用时的那一页。
 *
 * 故意写成一段内联 HTML，不走布局：布局要渲染轨脚的账户区、要读词典，而这时会
 * 话本身就是缺的那一块。`/api/*` 不经过这里（见 `isUnguarded`），反代自己会回
 * 502 JSON，所以这里只需要一种形状。
 */
function unavailable(): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>503 · CAN EFB</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b1220;color:#e2e8f0}
main{max-width:28rem;padding:1.5rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{margin:.5rem 0;color:#94a3b8;line-height:1.6}
a{color:#7dd3fc}
</style>
</head>
<body>
<main>
<h1>暂时无法验证登录状态</h1>
<p>会话服务暂时不可用，你的登录并没有失效。请稍后<a href="">刷新</a>重试。</p>
<p lang="en">The session service is temporarily unavailable. You have not been signed out — please retry shortly.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "30",
    },
  });
}

/**
 * 和三个兄弟站一致的安全头。
 *
 * 用函数包一层而不是在 `next()` 之后就地设置：上面那个重定向是提前返回的，内
 * 联写法会让它成为唯一一个什么头都没有的响应 —— can-web 正是被这一条咬过。
 */
function withSecurityHeaders(response: Response): Response {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "origin-when-cross-origin");
  return response;
}
