#!/usr/bin/env bun
/**
 * 用 MapLibre 自己的校验器验 `RouteMap.vue` 里那个手写 style。
 *
 * ## 为什么需要它：TypeScript 检查不了这些东西
 *
 * 那个 style 里到处是 MapLibre 的**表达式**（`["interpolate", …]`、
 * `["step", …]`、`["match", …]`），而 TS 对它们无能为力 —— 源码里那一串
 * `as never` 就是证据：类型系统被明确地关掉了，因为它表达不了这套 DSL。
 *
 * 于是表达式写错**不会在构建期报任何错**。它在浏览器里的表现是：MapLibre 把那
 * 一层默默跳过，`map.on("error")` 里出现一行，图上少一层。**这个站已经完整地栽
 * 过一次**（换 MapLibre 之后整张图空白，控制台一个字都没有），所以这里的判断
 * 是：能在命令行里发现的，就不要留到浏览器里发现。
 *
 * ## 它是从源码里抠出来求值的，不是抄一份
 *
 * 抄一份的话，抄的那份和真的那份迟早分叉，而分叉之后这个检查就只是在验它自己。
 * 代价是**它依赖源码的缩进**（靠 `      style: {` 和 `      },` 定位）—— prettier
 * 把格式钉死了，所以这在实践中是稳的；真挪了位置这里会直接报错退出，而不是安静
 * 地少验一段。
 *
 * ## 不在 `lint` 里
 *
 * 有意的：CI 的门是 format + astro check + vue-tsc，而这一条依赖源码布局，把它
 * 挂进 CI 等于给一个格式变动加一条会红的路径。需要的时候手跑：
 *
 * ```bash
 * bun run check:style
 * ```
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "src", "components", "RouteMap.vue");
const lines = readFileSync(file, "utf8").split("\n");

function block(startLine, endLine) {
  const start = lines.indexOf(startLine);
  if (start < 0) {
    console.error(
      `在 RouteMap.vue 里找不到 \`${startLine.trim()}\` —— 这个脚本靠缩进定位，` +
        "源码结构变了就要跟着改。见文件头。",
    );
    process.exit(2);
  }
  const end = lines.findIndex((l, i) => i > start && l === endLine);
  if (end < 0) {
    console.error(`\`${startLine.trim()}\` 没有找到配对的结束行。`);
    process.exit(2);
  }
  return lines.slice(start, end + 1).join("\n");
}

// 配色对象：这里验的是结构和表达式，具体颜色无关。
const palette = new Proxy(
  {},
  { get: (_t, k) => (typeof k === "string" ? "#123456" : undefined) },
);
// 经纬网：给一个合法的空集合，这里不验那几条线的坐标。
const graticule = () => ({ type: "FeatureCollection", features: [] });

// airwayColor 也抠出来求值而不是打桩 —— 它返回的正是一个要被验的表达式。
const airwayColor = new Function(
  "return " +
    block("function airwayColor(c: {", "}").replace(
      /^function airwayColor\([\s\S]*?\)\s*\{/,
      "function airwayColor(c) {",
    ),
)();

let body = block("      style: {", "      },")
  .replace(/^\s*style:\s*/, "")
  // TS 断言在这里求值不了，去掉；它们不改变运行时的值。
  .replace(/\s+as\s+never/g, "")
  .replace(/\s+as\s+const/g, "")
  // 结束行是 `},`，尾逗号留着 `return (…,)` 不合法。
  .replace(/,\s*$/, "");

const style = new Function(
  "c",
  "graticule",
  "airwayColor",
  `return (${body});`,
)(palette, graticule, airwayColor);

const errors = validateStyleMin(style);
if (errors.length) {
  console.error(`样式有 ${errors.length} 处不合法：`);
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(1);
}

console.log(
  `[check:style] ok — ${Object.keys(style.sources).length} 个 source，` +
    `${style.layers.length} 个图层，表达式全部合法`,
);
