/**
 * 会话的**接缝**，目前还是空的。
 *
 * 这个文件现在恒返回 null，外壳因此渲染「未登录」。它存在是为了让「以后接上
 * 会话」是改一个函数，而不是在轨、快速跳转和每个页面里各找一遍 —— can-web 当
 * 年就是那样长成三件事穿一件外套的。
 *
 * 接的时候照抄 can-dev/src/lib/session.ts，不要另发明一套：
 *
 * 1. can-api 在**父域**上签发 cookie，所以 airwaysn.org 上登录过的成员到这里
 *    本来就带着它 —— EFB 不需要自己的登录页，需要的是把 cookie 转发给
 *    can-api（can-web/src/server/canApi.ts 是那半边的样板）。
 * 2. 中间件里的重定向只是**便利**，不是边界。真正的判断在 can-api：加一条
 *    PROTECTED_PREFIXES 而 can-api 那边没有对应的守卫，那个页面就是没保护的。
 * 3. 这个站一行数据库凭据都不该有，理由和 can-dev / can-radar 一模一样。
 */

export interface EfbUser {
  /** 显示名；没有就退回用户名。 */
  name: string;
  /** ASN ID，账户菜单里显示。 */
  id: string;
}

export function getUser(_cookies: {
  get(name: string): { value: string } | undefined;
}): EfbUser | null {
  return null;
}
