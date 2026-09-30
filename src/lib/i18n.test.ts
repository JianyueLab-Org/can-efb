import { describe, expect, test } from "bun:test";
import { CHROME_MESSAGES } from "@jianyuelab-org/can-ui/i18n";
import { LOCALES, getMessages, useTranslations } from "@/lib/i18n";
import enUs from "../../language/en-us.json";
import jaJp from "../../language/ja-jp.json";
import zhCn from "../../language/zh-cn.json";
import zhTw from "../../language/zh-tw.json";

/**
 * 外壳文案在 `efb.frame`，键名照 can-ui 的 `CHROME_MESSAGES`。
 *
 * 读的是原始词典，不经 `getMessages`：后者把 zh-cn 垫在底下，漏翻的键会以中文出现
 * 在英文、繁体、日文页面上，测试看不出来。
 */
const RAW: Record<string, { efb: { frame?: Record<string, unknown> } }> = {
  "zh-cn": zhCn,
  "zh-tw": zhTw,
  "en-us": enUs,
  "ja-jp": jaJp,
};

function leaves(node: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object"
      ? leaves(value as Record<string, unknown>, path)
      : [path];
  });
}

const chromeKeys = leaves(CHROME_MESSAGES);

describe("efb.frame", () => {
  for (const locale of LOCALES) {
    test(`${locale} 翻齐了 CHROME_MESSAGES 的每个键`, () => {
      const have = new Set(leaves(RAW[locale].efb.frame ?? {}));
      expect(chromeKeys.filter((key) => !have.has(key))).toEqual([]);
    });
  }

  test("27.1.0 的新键都在 CHROME_MESSAGES 里", () => {
    for (const key of [
      "openMenu",
      "siteNavigation",
      "signingOut",
      "signOutFailed",
      "rail.collapse",
      "rail.expand",
      "rail.me",
      "search.label",
      "noAccess.title",
      "noAccess.rating",
      "noAccess.permission",
      "noAccess.signedInAs",
      "noAccess.reachable",
    ]) {
      expect(chromeKeys).toContain(key);
    }
  });

  test("getMessages 取得到 efb.frame，带插值", () => {
    expect(getMessages("ja-jp", "efb.frame").signOut).toBe("ログアウト");
    const t = useTranslations("en-us", "efb.frame");
    expect(t("rail.me")).toBe("Me");
    expect(t("noAccess.signedInAs", { name: "Li", id: 1234 })).toBe(
      "Signed in as Li (#1234).",
    );
  });
});
