/**
 * 只认最后一个请求：`next()` 发新的之前撤掉旧的，`cancel()` 撤掉正在路上的那个。
 *
 * 飞行计划页的航路预览用它。**凡是不再需要那个回答的分支都要 `cancel()`**，不只是
 * 发新请求的那一条：框里填得不够画了、回到了已画过的那份、回到了已提交的那份，这
 * 几条提前返回如果放着旧请求不管，它晚到的回答会把框里已经没有的那条线画上地图。
 */
export interface LatestOnly {
  next(): AbortSignal;
  cancel(): void;
}

export function latestOnly(): LatestOnly {
  let current: AbortController | undefined;
  return {
    next() {
      current?.abort();
      current = new AbortController();
      return current.signal;
    },
    cancel() {
      current?.abort();
      current = undefined;
    },
  };
}
