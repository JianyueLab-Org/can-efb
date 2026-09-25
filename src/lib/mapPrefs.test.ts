import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, PREF_KEY, readPrefs, writePrefs } from "@/lib/mapPrefs";

/** 一个够用的 Storage：只要 getItem / setItem。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

/**
 * 偏好读错不会报错：图层按默认值打开，看起来一切正常，只是成员上次关掉的那几层
 * 又回来了 —— 或者更糟，上次开着的航路没了。
 */
describe("readPrefs", () => {
  test("什么都没存，给默认值", () => {
    expect(readPrefs(memoryStorage())).toEqual(DEFAULT_PREFS);
  });

  test("旧的三选一：off 折成关", () => {
    const prefs = readPrefs(
      memoryStorage({ [PREF_KEY]: JSON.stringify({ airway: "off" }) }),
    );
    expect(prefs.airways).toBe(false);
    expect("airway" in prefs).toBe(false);
  });

  test("旧的三选一：high / low 都折成开", () => {
    expect(
      readPrefs(
        memoryStorage({ [PREF_KEY]: JSON.stringify({ airway: "low" }) }),
      ).airways,
    ).toBe(true);
  });

  test("新旧键都在时以新键为准", () => {
    expect(
      readPrefs(
        memoryStorage({
          [PREF_KEY]: JSON.stringify({ airway: "high", airways: false }),
        }),
      ).airways,
    ).toBe(false);
  });

  test("存坏了、或者 localStorage 本身会抛，一律回到默认", () => {
    expect(readPrefs(memoryStorage({ [PREF_KEY]: "{" }))).toEqual(
      DEFAULT_PREFS,
    );
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readPrefs(throwing)).toEqual(DEFAULT_PREFS);
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe("writePrefs", () => {
  test("写进去再读出来是同一份", () => {
    const storage = memoryStorage();
    const prefs = { ...DEFAULT_PREFS, mora: true, traffic: false };
    writePrefs(prefs, storage);
    expect(readPrefs(storage)).toEqual(prefs);
  });

  test("setItem 会抛也不中断", () => {
    const throwing = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writePrefs(DEFAULT_PREFS, throwing)).not.toThrow();
  });
});
