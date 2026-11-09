import type { APIRoute } from "astro";
import { CAN_API_ORIGIN } from "@/lib/config";
import { createHealth, healthResponse, upstreamCheck } from "@/lib/health";

export const prerender = false;

/**
 * 给外部可用性监控的健康检查：探 can-api 的 `/health`。
 *
 * 和 `/healthz` 分开：探活不碰上游（见 `healthz.ts`），k8s 探针别指到这里。
 */
const health = createHealth({
  "can-api": upstreamCheck(`${CAN_API_ORIGIN}/health`),
});

export const GET: APIRoute = async () => healthResponse(await health());
