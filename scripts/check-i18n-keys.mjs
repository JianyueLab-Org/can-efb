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
 * ## 它查什么、不查什么
 *
 * 只认**字面量**的键：`t("a.b.c")`。拼出来的（`t(\`nav.${key}\`)`）查不了，也不该
 * 强行查 —— 那会逼着大家把动态键写成一长串 if。所以这道闸的承诺是"写死的键不会
 * 挂"，不是"所有键都不会挂"。
 *
 * 只对 **zh-cn** 那本查，因为它是默认语言、也是最全的一本。别的语言缺键是另一件事
 * （回退到 zh-cn，显示的是中文而不是键名），不该混在同一个检查里。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DICT = join(ROOT, "language", "zh-cn.json");
const SRC = join(ROOT, "src");

const dictionary = JSON.parse(readFileSync(DICT, "utf8")).efb;

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

if (missing.length) {
  console.error(
    `[i18n] ${missing.length} 处引用了 language/zh-cn.json 里没有的键。\n` +
      `      这些会被原样画到屏幕上，看起来像一个真的标签：\n`,
  );
  for (const [path, key] of missing) console.error(`      ${path}: ${key}`);
  console.error(
    `\n      要么补上词条，要么删掉这处引用 —— 删页面时两边都要动。`,
  );
  process.exit(1);
}

console.log(`[i18n] ${checked} 处字面量键引用，全部在词典里。`);
