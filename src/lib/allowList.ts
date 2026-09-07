/**
 * 反代白名单的查表。**一行代码，但它必须存在。**
 *
 * 两条反代（`pages/api/v1/[...path].ts` 和 `pages/api/db/[...path].ts`）都把
 * 路径尾巴当键去查一张对象字面量：
 *
 * ```ts
 * const entry = ALLOW_LIST[rest];      // ← rest 直接来自 context.params.path
 * if (!entry) return notAllowed();     // ← 这道门以为自己挡住了不在表里的东西
 * entry.methods.includes(method);      // ← 然后这一行抛 TypeError
 * ```
 *
 * 对象字面量继承 `Object.prototype`，所以表里从来没写过的一批键**查得到东西**：
 * `constructor`、`toString`、`valueOf`、`hasOwnProperty` 全都返回一个真值函数，
 * `__proto__` 返回 `Object.prototype`。于是 `!entry` 是假、404 那道门放行，下一
 * 行 `entry.methods` 是 undefined，`.includes` 抛异常 —— 一个匿名的
 * `GET /api/v1/toString` 拿到的不是 `{"error":"not_allowed"}`，是一个 500。
 *
 * **这不是鉴权绕过**：异常发生在向上游 `fetch` 之前，一个字节都没转出去。它是
 * 四条公开路径上的一个匿名可触发的未捕获异常，而 500 的响应体长得像堆栈。
 *
 * `Object.hasOwn` 只认这张表**自己**的键，继承来的一概不算 —— 这正是白名单本来
 * 的语义。（另一条路是把表建成 `Object.create(null)`，效果一样；用 hasOwn 是因
 * 为它把意图写在了查表的那一处，而不是藏在表的构造里。）
 */
export function lookupAllowed<T>(
  table: Record<string, T>,
  key: string,
): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
