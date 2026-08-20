/**
 * 飞行情报区边界。
 *
 * ## 这一层不走 can-db
 *
 * 站里其余空域（扇区、限制区）都从 can-db 取，唯独情报区不是，而且是**故意的**：
 *
 * **汇编没有发布完整的情报区边界。** 它给的是边界国内一侧的折线，首尾标着「是国境
 * 点」，其余沿国境线走 —— 而国境线不在那份数据里。照 seq 闭合成环就等于在国境线该
 * 在的地方切一条直线：乌鲁木齐全区只有 6 个顶点（VATSpy 那份 275 个），那条弦直接
 * 横穿新疆。**它不报错，看起来还挺像回事**，这才是麻烦的地方。
 *
 * 用的是 VATSpy 那份（经 `scripts/build-firs.mjs` 处理），边界是描好的完整轮廓，还
 * 自带标注位置。can-radar 画管制区边界用的是同一份数据 —— 两个站的边界因此对得上，
 * 而不是各画各的。
 *
 * ## 由此还带来两件事
 *
 * **不需要登录也看得到。** 它是随站点发的静态文件，不是 can-db 的接口 —— 没有
 * `aipAccess` 的成员打开 EFB 也有边界可看，而这一层是默认开的。
 *
 * **必须署名。** VATSpy 是 CC BY-SA 4.0，`RouteMap.vue` 的 `attributionControl`
 * 因此是开着的。换这份数据之前它是关的，理由是 Natural Earth 属公有领域 —— 那个理
 * 由不再成立。
 */
import type { FeatureCollection } from "geojson";

/**
 * **从 `src/` 里 `?url` 引进来，不放 `public/`** —— 理由和陆地那份一样，写在
 * `RouteMap.vue` 的 `LAND_URL` 上面：`public/` 下的固定名字只能拿到
 * `max-age=0`，边缘不缓存、每次回源；`?url` 之后是内容哈希名字，一年 immutable
 * 且边缘命中。
 */
import FIRS_URL from "@/basemap/firs.json?url";

/** 取过就不再取：这份文件是静态的，一个周期内不会变。 */
let cache: FeatureCollection | null = null;

export async function fetchFIRs(): Promise<FeatureCollection> {
  if (cache) return cache;
  const response = await fetch(FIRS_URL);
  if (!response.ok) throw new Error(`firs: ${response.status}`);
  cache = (await response.json()) as FeatureCollection;
  return cache;
}
