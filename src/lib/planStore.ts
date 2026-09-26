/**
 * 成员已提交的飞行计划，`GET /api/v1/pilot/flightplan`，同一个标签页里共用一次。
 *
 * 概览页和地图（`components/map/useRouteLayer.ts`）都要它：打开概览时，地图挂载时
 * 读一次、概览自己读一次、`showPlanOnMap` 又让地图读一次 —— 三个一模一样的请求。
 * 换页时地图的 `astro:after-swap` 再读一次，而那一页如果是概览，又是两个。
 *
 * 两条规矩：
 *
 * - **并发的共用一次**，路上那个 promise 大家一起等。
 * - **读到的在 `PLAN_FRESH_MS` 之内直接给**。计划只在飞行计划页交、撤时变，而那一
 *   页会发 `PLAN_CHANGED_EVENT`（`lib/mapBus.ts`）—— 收到就作废，连路上那一次也不
 *   要了（它可能是改之前发出去的）。
 *
 * 失败不留：下一个调用方会重新问，概览的「重试」按下去就是真的重试。
 *
 * 结果是同一个对象给所有调用方，**只读不改**。
 */
import { api, type ApiResult } from "@/lib/canApi";
import { PLAN_CHANGED_EVENT } from "@/lib/mapBus";

/** 读到的计划多久之内算新鲜。另一个标签页交的计划，最多晚这么久才被这里看见。 */
const PLAN_FRESH_MS = 10_000;

let last: { at: number; result: ApiResult<unknown> } | null = null;
let inFlight: Promise<ApiResult<unknown>> | null = null;
/** 每次作废加一。回来时代号变了，就不写 `last`，免得改之前的答案被当成新鲜的。 */
let generation = 0;

/** 作废。飞行计划页交、撤之后由 `PLAN_CHANGED_EVENT` 触发。 */
export function invalidatePlan(): void {
  generation++;
  last = null;
  inFlight = null;
}

if (typeof window !== "undefined") {
  window.addEventListener(PLAN_CHANGED_EVENT, invalidatePlan);
}

/**
 * 读计划。`fresh: true` 跳过新鲜窗口（但仍然和路上那一次共用）。
 *
 * 类型参数只是调用方想看的那几个字段：两个调用方读的是同一份响应的不同子集。
 */
export function loadFlightPlan<T>(
  options: { fresh?: boolean } = {},
): Promise<ApiResult<T | null>> {
  if (!options.fresh && last && Date.now() - last.at < PLAN_FRESH_MS) {
    return Promise.resolve(last.result as ApiResult<T | null>);
  }
  if (inFlight) return inFlight as Promise<ApiResult<T | null>>;

  const gen = generation;
  const request = api<unknown>("/api/v1/pilot/flightplan").then((result) => {
    if (gen === generation) {
      inFlight = null;
      if (result.ok) last = { at: Date.now(), result };
    }
    return result;
  });
  inFlight = request;
  return request as Promise<ApiResult<T | null>>;
}
