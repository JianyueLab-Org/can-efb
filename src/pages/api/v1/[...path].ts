import type { APIRoute } from "astro";
import { CAN_API_ORIGIN, origin } from "@/lib/config";

export const prerender = false;

/**
 * 走白名单的 can-api 反代。
 *
 * **为什么有这一层，而不是让岛屿直接打 api.ceruleanavi.net。** can-web 是直连
 * 的，因为 `ceruleanavi.net` 写在 can-api 的 `ALLOWED_ORIGINS` 里；EFB 这个域没
 * 写，加进去要改 can-api 的部署环境变量并重启。同源反代让这个站**今天**就能
 * 跑，一行 can-api 都不用动 —— can-radar 出于同一个理由代理了 `/track` 和
 * `/metar`。
 *
 * 顺带解决的两件事：浏览器不需要 CORS，会话 cookie 也不必跨站travel（它在父域
 * 上，本来就会跟着同源请求过来，再由 `callApi` 转发）。
 *
 * **白名单是重点，不是修饰。** 一个通配的 `/api/*` 转发等于在这里重建一遍当年
 * 拆掉的网关：任何人都能拿这个站当跳板去打 can-api 的 super/staff 接口，而那
 * 些接口的鉴权虽然自己也会拦，但一个可以任意转发的开放代理迟早会被当成别的东
 * 西用。每一条都写清楚谁在用。
 *
 * 鉴权本身**不在这里判**。can-api 每条路由自己有守卫，在这里再抄一份只会有两
 * 份可能不一致的判断 —— 这一层只管「这个路径允许被转发吗」，以及写操作的
 * Origin。
 */

interface Allowed {
  /** 允许的方法。 */
  methods: string[];
  /** 谁在用它 —— 没有这一句，以后没人敢删任何一条。 */
  who: string;
}

const ALLOW_LIST: Record<string, Allowed> = {
  // 外壳：轨脚的账户区、退出按钮。
  "auth/session": { methods: ["GET"], who: "AppRail / middleware" },
  "auth/signout": { methods: ["POST"], who: "AppRail 退出登录" },

  // 概览、设置：成员自己的资料。
  "pilot/data": { methods: ["GET"], who: "Settings.vue / Dashboard.vue" },

  // 飞行日志。
  // 概览页的统计。飞行日志那一页删掉之后只剩它一个调用方 —— 但接口本身还在
  // 用，别顺手把这条也删了。
  "pilot/flights": { methods: ["GET"], who: "Dashboard.vue" },

  // 飞行计划：读、提交、撤销。
  "pilot/flightplan": {
    methods: ["GET", "POST", "DELETE"],
    who: "FlightPlan.vue / Dashboard.vue",
  },

  // SimBrief 绑定与导入。
  "pilot/simbrief": {
    methods: ["GET", "POST", "DELETE"],
    who: "Settings.vue",
  },
  "pilot/simbrief/import": { methods: ["GET"], who: "FlightPlan.vue 导入" },

  // 公开数据：气象、航路。
  //
  // `/api/v1/atis` **故意不在这里**：它返回的是 text/plain，而且内容就是同一份
  // METAR（can-api 的 handleATIS 调的也是 metar.Fetch），对这个站没有任何增量。
  // 它的消费者是 EuroScope 的宏。
  //
  // `/api/v1/track` 也不在，但**理由已经不是原来那条了**。原来写的是「EFB 没有
  // 地图」—— 这个站现在有一张常驻地图，那句话不再成立。
  //
  // 真正的理由是：`track` 是 can-api 里**某个 CID 的历史航迹**，而图上要的实时
  // 位置来自 can-fsd 的 datafeed（公开、无鉴权、带 `ACAO: *`，岛屿直连，见
  // `lib/datafeed.ts`）。两者不是一回事，datafeed 到位并不意味着需要这一条。
  // 哪天真要画"这架飞机刚才飞过哪里"再加。
  metar: { methods: ["GET"], who: "Weather.vue / Dashboard.vue" },
  route: { methods: ["GET"], who: "RoutePlanner.vue" },
};

const UNSAFE = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * 逐字转发给 can-api 的响应头。
 *
 * `set-cookie` **必须**在里面：退出登录是 can-api 用一个 Set-Cookie 清掉会话
 * 的，漏掉它成员就永远登不出去。
 */
const PASS_THROUGH = ["content-type", "cache-control", "set-cookie"];

const handler: APIRoute = async (context) => {
  const rest = context.params.path ?? "";
  const entry = ALLOW_LIST[rest];

  if (!entry) {
    return Response.json(
      { error: "not_allowed", message: "该接口不在此站的转发白名单内。" },
      { status: 404 },
    );
  }

  const method = context.request.method.toUpperCase();
  if (!entry.methods.includes(method)) {
    return Response.json(
      { error: "method_not_allowed", message: "方法不被允许。" },
      { status: 405, headers: { allow: entry.methods.join(", ") } },
    );
  }

  // 写操作的 Origin 检查 —— Astro 的 checkOrigin 关掉了（反代下它永远误判，见
  // astro.config.mjs），这是补上的那一半。缺 Origin 头的请求放行：非浏览器的
  // 调用方本来就不带它，而它们要过的是 can-api 的守卫，不是这一关。
  if (UNSAFE.has(method)) {
    const sent = context.request.headers.get("origin");
    if (sent && sent !== origin()) {
      return Response.json(
        { error: "bad_origin", message: "跨站请求被拒绝。" },
        { status: 403 },
      );
    }
  }

  const target = CAN_API_ORIGIN + "/api/v1/" + rest + context.url.search;

  const headers = new Headers();
  const cookie = context.request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const contentType = context.request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : context.request.body,
      // body 是流，Node 的 fetch 要求显式声明才肯发。
      ...(method === "GET" || method === "HEAD" ? {} : { duplex: "half" }),
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
  } catch (error) {
    console.error(`can-api ${rest} unreachable:`, error);
    return Response.json(
      { error: "unreachable", message: "无法连接到 can-api，请稍后再试。" },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
};

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
