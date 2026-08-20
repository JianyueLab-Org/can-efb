/**
 * 这个站要知道的三个地址，集中在一处。
 *
 * can-dev 当年把 can-api 的地址和同意页的地址塞进同一个 `CAN_ISSUER`，结果是
 * 改其中一个的人以为自己改完了。这里从一开始就分开命名。
 */

function clean(value: string | undefined): string {
  return (value || "").replace(/\/+$/, "");
}

/**
 * can-api 的 origin。数据全部来自它。
 *
 * `PUBLIC_` 前缀让 Astro 把它内联进客户端包 —— 它是主机名，不是密钥。但**浏
 * 览器其实用不到它**：岛屿走本站的 `/api/v1/*` 反代（见
 * `src/pages/api/v1/[...path].ts`），那样就不需要 can-api 那边为
 * efb.ceruleanavi.net 开一条 CORS。真正用它的是 SSR 和那个反代。
 *
 * 兜底成生产地址而不是空串：can-web 的 `src/server/canApi.ts` 记着这一条的代
 * 价 —— 空串在浏览器里能解析成同源相对地址，在服务端却是
 * `ERR_INVALID_URL`，而且每一个请求都失败，日志看起来像是 can-api 挂了，其实
 * 只是没人设过这个变量。
 */
export const CAN_API_ORIGIN =
  clean(process.env.CAN_API_ORIGIN) ||
  clean(import.meta.env.PUBLIC_CAN_API_ORIGIN) ||
  "https://api.ceruleanavi.net";

/**
 * can-web 的 origin。**只用来指登录页**，别的什么都不走它。
 *
 * EFB 自己没有登录页，也不该有：会话由 can-api 在父域上签发，主站上登录过的
 * 成员到这里本来就带着 cookie。
 */
export const CAN_WEB_ORIGIN =
  clean(process.env.CAN_WEB_ORIGIN) ||
  clean(import.meta.env.PUBLIC_CAN_WEB_ORIGIN) ||
  "https://ceruleanavi.net";

/**
 * 本站自己的 origin，写操作的 Origin 头要和它比对。
 *
 * 必须是**显式配置**的值，不能从 `Host` 头推：这个站跑在 TLS 终止的反代后面，
 * 推出来的是 `http://…`，浏览器发的是 `https://…`，永远对不上。
 * `astro.config.mjs` 里关掉 `checkOrigin` 正是这个原因，而这里是补上的那一半。
 */
export function origin(): string {
  return (
    clean(process.env.PUBLIC_ORIGIN) ||
    clean(import.meta.env.PUBLIC_ORIGIN) ||
    "https://efb.ceruleanavi.net"
  );
}

/**
 * 登录去哪儿。
 *
 * **带 callbackUrl。** 这里以前写着「不带」，理由是 can-web 的 `/signin` 会把跨
 * 站地址丢掉、回落到 `/pilots` —— 于是成员登录完停在主站，还得自己走回 EFB。
 *
 * 那个前提已经不成立：can-web 有一份**显式白名单**
 * （`src/lib/callbackUrl.ts` 的 `ALLOWED_CALLBACK_ORIGINS`），而
 * `https://efb.ceruleanavi.net` 在名单上。同域的 can-controller 一直这么跳，线上
 * 的 302 就带着 callbackUrl，这条路是走通了的。
 *
 * **白名单是精确匹配 origin，不是前缀或包含。** 那份文件里写了为什么：
 * `https://efb.ceruleanavi.net.evil.com` 能骗过任何「以我们的域名开头」的检查。
 * 所以这里传过去的必须是一个正规化过的 origin，不能是拼出来的字符串。
 */
export function signInUrl(returnTo?: URL): string {
  const base = `${CAN_WEB_ORIGIN}/signin`;
  if (!returnTo) return base;

  // 用 origin() 而不是 returnTo.origin：这个站跑在 TLS 终止的反代后面，请求 URL
  // 推出来的 origin 是 `http://`。那既配不上白名单里的 `https://`（于是被拒、回
  // 落 /pilots，白做一场），也会把成员从 https 降到 http。
  //
  // 片段（`#...`）不带：它本来就不会发到服务端，这里也无从得知。
  const target = `${origin()}${returnTo.pathname}${returnTo.search}`;
  return `${base}?callbackUrl=${encodeURIComponent(target)}`;
}
