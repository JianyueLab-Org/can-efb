import { describe, expect, test } from "bun:test";

import { allowed } from "../pages/api/v1/[...path]";
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

describe("通知铃", () => {
  const BELL: Array<[string, string[]]> = [
    ["notifications", ["GET"]],
    ["notifications/unread", ["GET"]],
    ["notifications/read-all", ["POST"]],
    ["notifications/member/1", ["PATCH"]],
    ["notifications/broadcast/12345678901234567890", ["PATCH"]],
  ];

  test("五条都在，方法对得上，不进 ResponseCache", () => {
    for (const [path, methods] of BELL) {
      const entry = allowed(path);
      expect(entry?.methods).toEqual(methods);
      expect(entry?.who).toContain("通知铃");
      // 标了 cacheSeconds 的路径进进程内缓存、且不转发 cookie —— 一个人的
      // 未读数会被发给下一个人。
      expect(entry?.cacheSeconds).toBeUndefined();
    }
  });

  test.each([
    "notifications/member",
    "notifications/member/abc",
    "notifications/member/1/read",
    "notifications/other/1",
    "notifications/broadcast/123456789012345678901",
    "notifications/unread/x",
    "notifications/../pilot/data",
  ])("%s 不在名单上", (path) => {
    expect(allowed(path)).toBeUndefined();
  });

  test.each(INHERITED)("继承来的 %s 仍然不算命中", (key) => {
    expect(allowed(key)).toBeUndefined();
  });
});
