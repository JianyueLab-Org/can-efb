import { describe, expect, test } from "bun:test";

import { lookupAllowed } from "./allowList";

/**
 * 这一组钉的是 `lib/allowList.ts` 里那一条：**继承来的键不算命中**。
 *
 * 判据和这个仓库里其余测试一样 —— 「错了会不会被屏幕出卖」。这一条不会：反代
 * 平时看起来完全正常，只有有人恰好请求 `/api/v1/toString` 的那一刻，一个本该
 * 是 404 的路径变成 500。没有人会在浏览页面时撞见它。
 */

/** 形状和两条反代里那张表一样，键是路径尾巴。 */
const TABLE: Record<string, { methods: string[] }> = {
  "auth/session": { methods: ["GET"] },
  metar: { methods: ["GET"] },
};

/**
 * `Object.prototype` 上每一个会被当成命中的名字。
 *
 * 直接 `TABLE[key]` 时它们全都返回真值 —— 前四个是函数，`__proto__` 是
 * `Object.prototype` 本身。调用方的 `if (!entry) return 404` 因此一个都挡不住。
 */
const INHERITED = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__proto__",
];

describe("lookupAllowed", () => {
  test("表里写着的键照常命中", () => {
    expect(lookupAllowed(TABLE, "auth/session")).toEqual({ methods: ["GET"] });
    expect(lookupAllowed(TABLE, "metar")).toEqual({ methods: ["GET"] });
  });

  test("表里没有的普通键返回 undefined", () => {
    expect(lookupAllowed(TABLE, "super/roster")).toBeUndefined();
    expect(lookupAllowed(TABLE, "")).toBeUndefined();
  });

  test.each(INHERITED)("继承来的 %s 不算命中", (key) => {
    // 先确认这条测试确实有话可说：直接下标是**有**东西的，那正是原来的写法。
    expect((TABLE as Record<string, unknown>)[key]).toBeTruthy();

    expect(lookupAllowed(TABLE, key)).toBeUndefined();
  });

  test("调用方那道 404 因此真的挡得住，而不是往下抛 TypeError", () => {
    // 复刻两条反代里的那三行。修好之前，`entry` 是一个函数，`!entry` 是假，
    // 于是执行会走到 `entry.methods.includes(...)` 并抛 TypeError。
    const respond = (path: string) => {
      const entry = lookupAllowed(TABLE, path);
      if (!entry) return 404;
      return entry.methods.includes("GET") ? 200 : 405;
    };

    for (const key of INHERITED) {
      expect(respond(key)).toBe(404);
    }
    expect(respond("metar")).toBe(200);
  });
});
