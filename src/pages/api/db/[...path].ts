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
  // 格子最低超障高度。**必须带 `?bbox=`**，can-db 那边没有「取全世界」的形式 ——
  // 这一层是画在图上的标注，而一张显示 180 度纬度的图没地方画它们。
  "aip/mora": { methods: ["GET"], who: "MapSurface.vue 的 Grid MORA 图层" },
  // 机场索引。**上面那句「特意不在这里」到期了**：地面图层要按机场取数据，而地
  // 图只知道自己在看哪一块地 —— 中间缺的就是一张 ICAO → 坐标的表。这正是那句话
  // 说的「哪天真有岛屿要在浏览器里查机场」。
  //
  // 它按 `aipAccess` 分级（1–2 级 246 个，3–4 级 433 个），分级在 can-db 那边判，
  // 这一层不抄。
  "aip/airports": {
    methods: ["GET"],
    who: "lib/airports.ts，地面图层的机场索引",
  },
  // 把一条**填报的**航路解析成线。和 `aip/route` 不是一回事：那条回答「该怎么
  // 飞」，这条回答「他填的这条画在哪儿」，一段都不裁。
  //
  // **为什么不用 can-api 的 `/api/v1/route`** —— 它也做展开，而且只要登录不要
  // `aipAccess`：那一条读的是**全球** navdata，消歧只有「离上一个点最近的同名点」
  // 一条规则，而那是**链式的** —— 前一个解错，后一个的「最近」就从错的位置起算。
  // 实际见过一条浙江境内的航路因此一路走到俄罗斯（`FK` 这个代号全球有好几个，浙
  // 江那个在 28.6N/121.5E）。
  //
  // can-db 这一份的点表只覆盖本网络 12 个情报区，压根没有别处那个同名点。它要
  // `aipAccess >= 1`，但**这张图上每一个航行图层本来就都要**（航路、导航台、空
  // 域、MORA、地面全走 can-db）—— 拿不到的成员看到的本来就是一张空底图，所以这
  // 条不多挡任何人。
  "aip/resolve": { methods: ["GET"], who: "MapSurface.vue 画已提交的飞行计划" },
};

/**
 * 带一个参数的那些路径。
 *
 * **正则而不是通配**，而且只有一处能变：`aip/airports/<四字母 ICAO>/ground`。写成
 * `aip/airports/*` 就等于把机场详情、地面、以及将来挂在这个前缀下的一切都开出去，
 * 那正是文件头那句「通配转发等于把 can-db 挂到公网上当开放代理」说的事。
 *
 * ICAO 必须是四个字母：can-db 自己也只认四位（不是就回 400），在这里同样收死，是
 * 为了让这条转发的形状**一眼看得出边界**，而不是靠上游兜底。
 *
 * **大小写都收。** 收死的是形状（一段、四个字母、然后 /ground），不是大小写 ——
 * can-db 自己会转大写，两种拼法到的是同一个资源。只认大写不会拦住任何东西，只会
 * 让下一个用这条路的人撞上一个说「不在白名单内」的 404，而他明明写对了。
 */
const ALLOW_PATTERNS: { pattern: RegExp; entry: Allowed }[] = [
  {
    pattern: /^aip\/airports\/[A-Za-z]{4}\/ground$/,
    entry: {
      methods: ["GET"],
      who: "lib/ground.ts，放大后画的机场地面",
    },
  },
];

const PASS_THROUGH = ["content-type", "cache-control"];

const handler: APIRoute = async (context) => {
  const rest = context.params.path ?? "";
  const entry =
    ALLOW_LIST[rest] ?? ALLOW_PATTERNS.find((p) => p.pattern.test(rest))?.entry;

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

  /* 缓存。**can-db 一个 Cache-Control 都不发**（核对过它的源码），所以浏览器对这
     几百 KB 的航路网没有任何缓存依据，每次整页刷新都要重新下载一遍。

     在代理这一层补上，理由和 can-radar 给 METAR 补五分钟缓存是同一条：上游没说，
     而我们知道这份数据多久变一次。

     两个决定，都别改：

     **`private` 是必须的，不是保守。** 这些是按 `aipAccess` 分级的航行资料，里面
     有受限的官方 AIP 材料。少了 `private`，路上任何一层共享缓存（Cloudflare、企业
     代理）都可能把 3 级成员的响应存下来发给 1 级的人 —— 那是把权限判断绕过去。
     只有发起请求的那个浏览器可以存。

     **十分钟，不是一天。** 数据本身一个 AIRAC 周期（28 天）才变，按内容算可以缓存
     很久 —— 但**重新导入是随时可能发生的**，而且此刻正好有一次待办（航段的 level
     一列全是默认值，高空视图因此是空的）。缓存久了，重导修好之后成员还会继续看到
     那张空图，而且不知道为什么。十分钟拿到了绝大部分好处（同一次使用里反复刷新），
     又让一次修复在十分钟内传到所有人。

     只给成功的响应加。给 401/502 加缓存，等于让一次权限变更或一次上游抖动被记住
     十分钟。 */
  if (upstream.ok && !out.has("cache-control")) {
    out.set("cache-control", "private, max-age=600");
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
};

export const GET = handler;
