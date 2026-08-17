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
 * 览器其实用不到它**：岛屿走本站的 `/api/can/*` 反代（见
 * `src/pages/api/can/[...path].ts`），那样就不需要 can-api 那边为
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
 * **不带 callbackUrl。** can-web 的 `/signin` 只接受站内绝对路径
 * （`/^\/(?!\/)/`），那是一道防开放重定向的检查，把
 * `https://efb.ceruleanavi.net/...` 传过去只会被丢掉、回落到 `/pilots`。要让成员
 * 登录完回到 EFB，得先在 can-web 那边显式放行这个域 —— 那是一处对钓鱼很敏感
 * 的改动，属于 can-web 的评审范围，不该在这里偷偷绕过去。
 *
 * 所以现在的行为是：跳到主站登录，登录完落在 /pilots，成员自己回来。
 */
export function signInUrl(): string {
  return `${CAN_WEB_ORIGIN}/signin`;
}
