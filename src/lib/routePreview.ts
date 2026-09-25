/**
 * 飞行计划页上「边打字边画」：把表单里那串航路交给 can-db 解析成点，交给地图。
 *
 * 走的是 can-db 的 `/aip/resolve`，和地图画已提交计划用的是同一条（理由写在
 * useRouteLayer 的 loadPlanRoute 里：can-api 的 `/route` 读全球 navdata，链式消歧
 * 会一路错到俄罗斯）。结果落成 `RequestState`：没权限、没读到、一个点都没对上，各说
 * 各的 —— 三种都是「图上没有线」，但对填表的人意思完全不同。
 *
 * **走 `dbFetch`，不直接 `fetch`**：设置里「不使用受限汇编」开着时它补上
 * `unrestricted=1`。直接 `fetch` 的话，预览会给一个藏起 NAIP 的成员画出 NAIP 解析的线。
 *
 * 校验规则不在这里：画不出来不等于航路有误，交计划时 can-api 的 422 才是权威。
 */
import { unwrapList } from "@/lib/aip";
import type { MapPoint } from "@/lib/mapBus";
import { dbFetch } from "@/lib/naip";
import { fromDbResponse, type RequestState } from "@/lib/requestState";

const ICAO = /^[A-Z]{4}$/;

export function shouldPreview(
  departure: string,
  arrival: string,
  route: string,
): boolean {
  return (
    ICAO.test(departure.trim().toUpperCase()) &&
    ICAO.test(arrival.trim().toUpperCase()) &&
    route.trim().length > 0
  );
}

/** 同一份输入的签名：大小写、多余空白不算改动，免得每敲一个空格就重画一次。 */
export function previewKey(
  departure: string,
  arrival: string,
  route: string,
): string {
  return [
    departure.trim().toUpperCase(),
    arrival.trim().toUpperCase(),
    route.trim().replace(/\s+/g, " ").toUpperCase(),
  ].join("|");
}

export async function resolveRoute(
  departure: string,
  arrival: string,
  route: string,
  signal?: AbortSignal,
): Promise<RequestState<MapPoint[]>> {
  const params = new URLSearchParams({
    departure: departure.trim().toUpperCase(),
    arrival: arrival.trim().toUpperCase(),
    route: route.trim().replace(/\s+/g, " "),
  });
  let response: Response;
  try {
    response = await dbFetch(`aip/resolve?${params}`, { signal });
  } catch {
    return { kind: "error", status: 0 };
  }
  if (!response.ok)
    return fromDbResponse<MapPoint[]>(false, response.status, null);
  const points = unwrapList<MapPoint>(await response.json().catch(() => null));
  return fromDbResponse(true, response.status, points, (list) => !list.length);
}
