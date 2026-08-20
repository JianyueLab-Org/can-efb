/**
 * 从「航路生成」交到「飞行计划」的那一小包东西。
 *
 * 两个功能在**两个页面**上（`/route` 和 `/flightplan`），所以要跨一次导航。用
 * sessionStorage 而不是查询串，理由有两条：
 *
 * - 航路字符串里有空格，塞进 URL 要编码，而它会长到几百个字符 —— 一条被截断的
 *   航路和一条完整的航路在输入框里长得一模一样。
 * - 计划的内容不该出现在地址栏、历史记录和 Referer 头里。
 *
 * **一次性的**：`takeDraft` 读完就删。留着的话，填完计划回头刷新一次页面就会被
 * 再填一遍 —— 而那时用户可能已经手改过了。
 */
const KEY = "efb.plan.draft";

export interface PlanDraft {
  departure: string;
  arrival: string;
  route: string;
  /**
   * `"published"`（汇编发布的走法）或 `"computed"`（我们算的最短路径）。
   *
   * 带过来是为了在计划那边说清楚**这条航路是哪来的** —— 两者不是同一种答案，而
   * 一旦填进输入框就再也看不出区别了。
   */
  source: string;
}

export function saveDraft(draft: PlanDraft): boolean {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
    return true;
  } catch {
    // 锁死的浏览器里 sessionStorage 会抛。回 false，让调用方别跳转 —— 跳过去
    // 什么都没填才是真的莫名其妙。
    return false;
  }
}

/** 读出来并删掉。没有就返回 null。 */
export function takeDraft(): PlanDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const d = JSON.parse(raw) as Partial<PlanDraft>;
    if (typeof d.route !== "string" || !d.route) return null;
    return {
      departure: typeof d.departure === "string" ? d.departure : "",
      arrival: typeof d.arrival === "string" ? d.arrival : "",
      route: d.route,
      source: typeof d.source === "string" ? d.source : "",
    };
  } catch {
    return null;
  }
}
