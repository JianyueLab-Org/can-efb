/**
 * 和 can-web、can-dev、can-radar 逐字相同的那一份 i18n —— 没有第二套实现。
 *
 * 词典只有一个命名空间 `efb`，因为这个站的每一个字都是它自己的：它不共享站头
 * 和页脚（它根本没有），所以从 can-web 镜像 `header`/`footer` 的那条规矩在这
 * 里不适用。真要用到共享文案时，照 can-dev 的做法把那半本原样镜像过来，不要
 * 在这里重写一遍。
 *
 * cookie 名是 `NEXT_LOCALE`，Next.js 时代留下来的。四个站共用一个父域，所以在
 * 主站上选的语言到这里仍然有效 —— 那正是它值得保留原名的原因：改名等于让所有
 * 人在跨站时语言被重置一次。
 */
import enUs from "../../language/en-us.json";
import jaJp from "../../language/ja-jp.json";
import zhCn from "../../language/zh-cn.json";
import zhTw from "../../language/zh-tw.json";

export type Locale = "en-us" | "ja-jp" | "zh-cn" | "zh-tw";

export const LOCALES: Locale[] = ["zh-cn", "zh-tw", "en-us", "ja-jp"];
export const DEFAULT_LOCALE: Locale = "zh-cn";

const messages: Record<Locale, Record<string, unknown>> = {
  "en-us": enUs,
  "ja-jp": jaJp,
  "zh-cn": zhCn,
  "zh-tw": zhTw,
};

/** Resolve a `NEXT_LOCALE` cookie value to a supported locale (replaces next-intl). */
export function resolveLocale(cookieValue?: string | null): Locale {
  if (cookieValue && (LOCALES as string[]).includes(cookieValue)) {
    return cookieValue as Locale;
  }
  return DEFAULT_LOCALE;
}

/** Read the active locale from an Astro `cookies` store. */
export function getLocale(cookies: {
  get(name: string): { value: string } | undefined;
}): Locale {
  return resolveLocale(cookies.get("NEXT_LOCALE")?.value);
}

function lookup(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === "object"
          ? (acc as Record<string, unknown>)[part]
          : undefined,
      obj,
    );
}

function interpolate(
  template: string,
  values?: Record<string, string | number>,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    values[key] !== undefined ? String(values[key]) : `{${key}}`,
  );
}

export type Translator = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** next-intl–style `useTranslations(namespace)` returning a `t(key, values)` fn. */
export function useTranslations(
  locale: Locale,
  namespace?: string,
): Translator {
  const base = namespace
    ? lookup(messages[locale], namespace)
    : messages[locale];
  return (key, values) => {
    const value = lookup(base, key);
    return typeof value === "string" ? interpolate(value, values) : key;
  };
}

/** Return the raw message dictionary for a namespace — to pass into a Vue island as a prop. */
export function getMessages(
  locale: Locale,
  namespace?: string,
): Record<string, unknown> {
  const base = namespace
    ? lookup(messages[locale], namespace)
    : messages[locale];
  return (base as Record<string, unknown>) ?? {};
}

/** Client-side translator over a pre-resolved namespace dictionary (used inside Vue islands). */
export function createTranslator(dict: Record<string, unknown>): Translator {
  return (key, values) => {
    const value = lookup(dict, key);
    return typeof value === "string" ? interpolate(value, values) : key;
  };
}
