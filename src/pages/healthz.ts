import type { APIRoute } from "astro";

export const prerender = false;

/**
 * 探活。**故意不碰 can-api。**
 *
 * 兄弟站探的是 `/`，那在这个站上是错的：这里整站要登录，`/` 会先向 can-api 问
 * 一次会话再 302 出去 —— 两个副本、10 秒一次，等于给 can-api 加一份纯粹白花的
 * 流量，而且探活的语义也歪了：它这时测的是「can-api 活着吗」，不是「这个进程
 * 在服务 HTTP 吗」。上游抖一下就把自己的 Pod 滚掉，是最不该有的故障放大。
 *
 * 所以这里只回一个 200，只证明这一件事。中间件对它放行（见 `src/middleware.ts`
 * 的 skip 列表），否则探活会被重定向到登录页。
 */
export const GET: APIRoute = () =>
  new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
