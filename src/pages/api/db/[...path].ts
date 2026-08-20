import type { APIRoute } from "astro";
import { CAN_DB_ORIGIN } from "@/lib/config";

export const prerender = false;

/**
 * 走白名单的 **can-db** 反代。
 *
 * 和隔壁 `api/v1/[...path].ts` 是同一件事、同一套规矩，只是目标换成航行资料库。
 * 分成两个文件而不是在一个里按前缀分流：两边的白名单要各自说清楚谁在用，混在一
 * 起之后，「这一条是给哪个后端开的」就得靠读代码而不是读清单。
 *
 * **为什么浏览器要打这一层，而不是 SSR 传 props。** 机场那一页是 SSR 取好传进
 * 去的 —— 它是一页的数据，随页面走。航路网不是：它是**图层**，一张全国的图
 * （2,308 个航路点、上千条航段），而地图挂在外壳上、每一页都在。SSR 传它等于每
 * 打开任何一页都背一次整张航路网。所以改成图层打开时按需拉，而按需拉就必须有一
 * 条浏览器能打的同源地址。
 *
 * **白名单是重点，不是修饰。** 通配转发等于把 can-db 挂到公网上当开放代理 ——
 * 它背后是全网唯一的 PostgreSQL，而且里面有受限的官方 AIP 材料。每一条都写清楚
 * 谁在用。
 *
 * **鉴权不在这里判。** can-db 自己不验会话：它拿转发过去的 cookie 去问 can-api，
 * 再按 `aipAccess >= 1 || rating >= 8` 决定给不给。这一层只管「这个路径允许被转
 * 发吗」。在这里抄一份权限判断只会有两份可能不一致的答案。
 */

interface Allowed {
  methods: string[];
  /** 谁在用它 —— 没有这一句，以后没人敢删任何一条。 */
  who: string;
}

const ALLOW_LIST: Record<string, Allowed> = {
  // 航路网图层。`?level=high|low` 由 can-db 处理，省略是全量。
  //
  // 机场（`aip/airports`）**特意不在这里**：那一页是 SSR 取的，浏览器不需要这条
  // 路。哪天真有岛屿要在浏览器里查机场再加，别为对称而开。
  "aip/airways": { methods: ["GET"], who: "RouteMap.vue 的航路图层" },
  // 航路生成。规划逻辑在 can-db（internal/aip/route.go）—— 这一条只是把它开给
  // 浏览器，EFB 一行规划代码都没有。
  "aip/route": { methods: ["GET"], who: "RouteGenerator.vue" },
  // 导航台与空域图层。空域按 `?family=` 分批取 —— 扇区（controlled）和限制区
  // （restricted）画法不同，也各自开关，没必要一次全拉。
  "aip/navaids": { methods: ["GET"], who: "RouteMap.vue 的导航台图层" },
  "aip/airspaces": { methods: ["GET"], who: "RouteMap.vue 的空域图层" },
};

const PASS_THROUGH = ["content-type", "cache-control"];

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

  const target = CAN_DB_ORIGIN + "/api/v1/" + rest + context.url.search;

  const headers = new Headers();
  const cookie = context.request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      // 航路网是几百 KB 且要打 PostgreSQL，比 can-api 那边的调用重 —— 超时给得
      // 比那边的 15 秒宽一点没有意义，它要么很快要么是真的出问题了。
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error(`can-db ${rest} unreachable:`, error);
    return Response.json(
      { error: "unreachable", message: "无法连接到航行资料库，请稍后再试。" },
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
