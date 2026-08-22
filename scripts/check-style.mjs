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
 * ## 现在在 `lint` 里了
 *
 * 从前不在，理由是「它依赖源码布局，挂进 CI 等于给一个格式变动加一条会红的路
 * 径」。**那个权衡在 2026-08-22 被推翻了**，因为两件事同时发生：
 *
 * 一，这个脚本自己**沉默失效了一段时间** —— 源码里新增了 `GROUND_MIN_ZOOM`、
 * `groundWidth`、`groundFeatureColor`、`altitudeBandColor` 等，而它没跟上，于是
 * 每次跑都是 `ReferenceError`。一个没人跑的检查，坏了也没人知道。
 *
 * 二，正因为没人跑，一处非法表达式漏到了线上：航路层的 `line-width` 把
 * `interpolate` 包在了 `case` 里面，MapLibre 拒绝整条 paint，**航路网一条线都
 * 不画**，而构建期一个字都没有。这已经是这一类第二次（上一次是 `icon-size` 里
 * 把 zoom 包进乘法）。
 *
 * 格式变动会让它红 —— 但它红的时候是 `exit 2` 加一句「靠缩进定位，源码结构变了
 * 就要跟着改」，那是**有指向的失败**；而不挂进来的代价是地图整层不画、没有任何
 * 提示。
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
      /^function airwayColor\([\s\S]*?\)\s*(?::[^{]*)?\{/,
      "function airwayColor(c) {",
    ),
)();

/* 地面那几个也照 airwayColor 的办法抠出来求值 —— 它们返回的同样是要被验的表达式。
 *
 * **打桩会让这个检查失去意义**：桩返回一个合法的常数，于是里面写错的表达式永远验不
 * 到，而这个脚本存在的全部理由就是验那些表达式。 */
/* GROUND_MIN_ZOOM 直接从真的那个模块 import，不抄一个数字过来 —— 抄的话它和源码迟
 * 早分叉，而分叉之后这个检查验的是一个不存在的门槛。 */
const { GROUND_MIN_ZOOM } = await import("../src/lib/ground.ts");
const { FACILITY_COLORS } = await import("../src/lib/atc.ts");
const { altitudeRamp } = await import("../src/lib/traffic.ts");

/* 实时那两层的分色表达式也抠出来求值，依赖同样从真模块 import。
 *
 * `isDark()` 摸 DOM，这里没有 —— 打成常量是安全的，因为它只决定取哪一套颜色，而这
 * 个脚本验的是表达式的**形状**，两套颜色的形状一样。 */
const isDark = () => false;
const altitudeBandColor = new Function(
  "altitudeRamp",
  "isDark",
  "return " +
    block("function altitudeBandColor() {", "}").replace(
      /: \(string \| number\)\[\]/g,
      "",
    ),
)(altitudeRamp, isDark);
const facilityCircleColor = new Function(
  "FACILITY_COLORS",
  "return " +
    block("function facilityCircleColor() {", "}").replace(
      /: \(string \| number\)\[\]/g,
      "",
    ),
)(FACILITY_COLORS);

const groundFeatureColor = new Function(
  "return " +
    block(
      "function groundFeatureColor(c: ReturnType<typeof palette>): unknown {",
      "}",
    ).replace(
      /^function groundFeatureColor\([\s\S]*?\)\s*(?::[^{]*)?\{/,
      "function groundFeatureColor(c) {",
    ),
)();
const groundPointColor = new Function(
  "return " +
    block(
      "function groundPointColor(c: ReturnType<typeof palette>): unknown {",
      "}",
    ).replace(
      /^function groundPointColor\([\s\S]*?\)\s*(?::[^{]*)?\{/,
      "function groundPointColor(c) {",
    ),
)();
/* `groundWidth` 的函数体里引用了 `GROUND_MIN_ZOOM`，而 `new Function` 是独立作用
 * 域 —— 看不到这个文件里的变量。所以要显式注入，否则它在**被调用时**才炸，而那时
 * 报的是「GROUND_MIN_ZOOM is not defined」，指向这个脚本而不是指向源码。 */
const groundWidth = new Function(
  "GROUND_MIN_ZOOM",
  "return " +
    block("function groundWidth(fallbackM: number): never {", "}")
      .replace(
        /^function groundWidth\([\s\S]*?\)\s*(?::[^{]*)?\{/,
        "function groundWidth(fallbackM) {",
      )
      .replace(/\s+as\s+never/g, ""),
)(GROUND_MIN_ZOOM);

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
  "groundFeatureColor",
  "groundPointColor",
  "groundWidth",
  "GROUND_MIN_ZOOM",
  "altitudeBandColor",
  "facilityCircleColor",
  `return (${body});`,
)(
  palette,
  graticule,
  airwayColor,
  groundFeatureColor,
  groundPointColor,
  groundWidth,
  GROUND_MIN_ZOOM,
  altitudeBandColor,
  facilityCircleColor,
);

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
