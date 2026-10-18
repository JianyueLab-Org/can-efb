/**
 * 不登录也能看的页面。整站要登录，例外只有 404：走错地址的人不该先被送去登录页，
 * 登录完回来还是一个 404。
 *
 * 匹配不到路由时 Astro 渲染 404 页，`routePattern` 是 `/404`，而 `pathname` 仍是
 * 原地址，所以两样都看。
 */
export function isPublicRoute(
  pathname: string,
  routePattern: string | undefined,
): boolean {
  return routePattern === "/404" || pathname === "/404";
}
