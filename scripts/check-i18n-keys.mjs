/**
 * Checks that every `t("…")` key a component asks for actually exists.
 *
 * ## 为什么需要一道闸
 *
 * 翻译器在**查不到键的时候回退成显示键名本身**。那是一个合理的回退（总比空白
 * 好），但它有一个很坏的后果：屏幕上会出现 `logbook.stats.flights` 这样一串东西，
 * 而它**看起来像一个真的标签** —— 排版正常、位置正常、旁边还有一个真的数字。四种
 * 语言的站点上都是同一串英文，没有任何东西会报错。
 *
 * 这不是假想。概览页底下曾经有两块统计，写着：
 *
 *     logbook.stats.flights      91
 *     logbook.stats.total        …
 *
 * 来历是删飞行日志那一页时，**词典里的 `logbook` 命名空间跟着删了，模板却没有**。
 * 删一页时最容易漏的正是这一半：页面没了，别处引用它文案的地方还在。类型检查看不
 * 见（键是字符串），构建看不见，只有人打开那一页才看得见。
 *
 * ## 它查两件事
 *
 * **一、`t("…")` 引用的键在 zh-cn 里存在。** 只认**字面量**的键：`t("a.b.c")`。
 * 拼出来的（`t(\`nav.${key}\`)`）查不了，也不该强行查 —— 那会逼着大家把动态键写成
 * 一长串 if。所以这道闸的承诺是"写死的键不会挂"，不是"所有键都不会挂"。
 *
 * **二、四本词典的键对得齐。** 这一条是后加的，因为最初那句"别的语言缺键会回退到
 * zh-cn"**是错的** —— `useTranslations` 里就一句
 * `typeof value === "string" ? … : key`，**没有任何跨语言回退**。于是一个键只加进
 * zh-cn，英文、繁体、日文三个站当场开始把键名画到屏幕上，而**中文用户永远看不
 * 到**，也就没人会报。
 *
 * 换句话说「先加中文，翻译以后再补」不是欠一笔债，是当场就坏。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** zh-cn 是默认语言，也是最全的一本 —— 引用检查以它为准。 */
const BASE = "zh-cn";
const LOCALES = ["zh-cn", "zh-tw", "en-us", "ja-jp"];

const load = (locale) =>
  JSON.parse(readFileSync(join(ROOT, "language", `${locale}.json`), "utf8"))
    .efb;

const dictionaries = Object.fromEntries(LOCALES.map((l) => [l, load(l)]));
const dictionary = dictionaries[BASE];

/** 键存在，且指向一个字符串（指向一个对象说明写少了一层）。 */
function resolves(key) {
  let node = dictionary;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) {
      return false;
    }
    node = node[part];
  }
  return typeof node === "string";
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".vue") || name.endsWith(".astro")) yield path;
  }
}

// 开头必须是字母：把 `t(\`nav.${item.key}\`)` 这种模板串排除掉，它以 ` 开头的部分
// 虽然是字面量，整体却是拼出来的。
const CALL = /\bt\(\s*["'`]([a-zA-Z][\w.]*)["'`]\s*[),]/g;

const missing = [];
let checked = 0;

for (const path of walk(SRC)) {
  const text = readFileSync(path, "utf8");
  for (const [, key] of text.matchAll(CALL)) {
    checked++;
    if (!resolves(key)) missing.push([relative(ROOT, path), key]);
  }
}

let failed = false;

if (missing.length) {
  console.error(
    `[i18n] ${missing.length} 处引用了 language/${BASE}.json 里没有的键。\n` +
      `      这些会被原样画到屏幕上，看起来像一个真的标签：\n`,
  );
  for (const [path, key] of missing) console.error(`      ${path}: ${key}`);
  console.error(
    `\n      要么补上词条，要么删掉这处引用 —— 删页面时两边都要动。\n`,
  );
  failed = true;
} else {
  console.log(`[i18n] ${checked} 处字面量键引用，全部在 ${BASE} 词典里。`);
}

/* ------------------------------------------------------- 四本词典的键要对齐

   **这一半守的是另外三种语言。** `useTranslations` 查不到键时返回键名，而它
   **没有跨语言回退** —— 一个键只加进 zh-cn，英文、繁体、日文三个站当场开始把键名
   画到屏幕上，和上面那种坏法一模一样，只是中文用户永远看不到。

   所以「只往默认语言加一条」不是"以后再补翻译"，是**当场就坏**。这道闸让它在提交
   之前就红，而不是等某个说英文的成员打开那一页。

   多出来的键也报：它多半是改键名时漏改了一本，那本里旧键还留着、新键没有 —— 只查
   "缺"的话，会看到一边缺一边多，却只报一半。 */

const flatten = (node, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
};

const baseKeys = new Set(Object.keys(flatten(dictionary)));

for (const locale of LOCALES) {
  if (locale === BASE) continue;
  const keys = new Set(Object.keys(flatten(dictionaries[locale])));
  const absent = [...baseKeys].filter((k) => !keys.has(k)).sort();
  const extra = [...keys].filter((k) => !baseKeys.has(k)).sort();
  if (!absent.length && !extra.length) continue;

  failed = true;
  console.error(`[i18n] language/${locale}.json 和 ${BASE} 对不齐：`);
  for (const key of absent) console.error(`      缺 ${key}`);
  for (const key of extra) console.error(`      多 ${key}（${BASE} 里没有）`);
  console.error("");
}

if (failed) process.exit(1);

console.log(
  `[i18n] ${LOCALES.length} 本词典，${baseKeys.size} 个键，全部对齐。`,
);
