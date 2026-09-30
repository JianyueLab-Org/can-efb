/**
 * i18n：can-ui 的 `createSiteI18n`，这里只有四本词典和一次调用。
 *
 * 缺键回退到 zh-cn。cookie 名是 `NEXT_LOCALE`，全网共用一个父域。
 *
 * 词典只有一个顶层命名空间 `efb`。外壳文案在 `efb.frame`，键名照 can-ui 的
 * `CHROME_MESSAGES`。
 */
import {
  createSiteI18n,
  createTranslator,
  type Locale,
  type Translator,
} from "@jianyuelab-org/can-ui/i18n";
import enUs from "../../language/en-us.json";
import jaJp from "../../language/ja-jp.json";
import zhCn from "../../language/zh-cn.json";
import zhTw from "../../language/zh-tw.json";

export { createTranslator, type Locale, type Translator };
export const {
  LOCALES,
  DEFAULT_LOCALE,
  resolveLocale,
  getLocale,
  useTranslations,
  getMessages,
} = createSiteI18n({
  "zh-cn": zhCn,
  "zh-tw": zhTw,
  "en-us": enUs,
  "ja-jp": jaJp,
});
