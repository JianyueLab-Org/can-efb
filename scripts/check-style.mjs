#!/usr/bin/env bun
/**
 * 用 MapLibre 自己的校验器验地图样式。
 *
 * ## 为什么需要它
 *
 * 样式里到处是 MapLibre 的**表达式**（`["interpolate", …]`、`["step", …]`、
 * `["match", …]`），TypeScript 检查不了。写错不会在构建期报错：浏览器里 MapLibre
 * 把那一层默默跳过，`map.on("error")` 里一行，图上少一层。这个站栽过三次（整张图
 * 空白、航路网一条线不画、`icon-size` 把 zoom 包进乘法），所以挂在 `lint` 里。
 *
 * ## 验的是真的那份
 *
 * 样式由 `src/lib/chartStyle.ts` 的 `buildStyle(theme)` 建，`RouteMap.vue` 用的就
 * 是它。这里 import 同一个函数，两套主题各建一次、各验一次 —— 没有第二份拷贝，也
 * 不靠源码缩进去抠。
 *
 * ```bash
 * bun run check:style
 * ```
 */
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { buildStyle } from "../src/lib/chartStyle.ts";

let failed = false;
for (const theme of ["light", "dark"]) {
  const style = buildStyle(theme);
  const errors = validateStyleMin(style);
  if (errors.length) {
    failed = true;
    console.error(`[check:style] ${theme}：${errors.length} 处不合法`);
    for (const e of errors) console.error(`  ${e.message}`);
    continue;
  }
  console.log(
    `[check:style] ${theme} ok — ${Object.keys(style.sources).length} 个 source，` +
      `${style.layers.length} 个图层，表达式全部合法`,
  );
}
if (failed) process.exit(1);
