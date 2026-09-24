/**
 * 地图上那几处**直接写成文字**的东西：角落坐标读数、署名。
 *
 * 单拎出来是因为两件都属于「错了屏幕不出卖」那一类（见 AGENTS.md〈命令〉）：
 * 经度没折回时读数是一个像模像样的 `E190.0°`；署名没转义时，一段数据里的
 * HTML 会被 MapLibre 原样插进页面，而看起来只是一行署名。
 */

/**
 * 把经度折回 [-180, 180)。
 *
 * MapLibre 的 `getBounds()` 在平移过日界线之后给的是**展开**的经度（可以是 190、
 * -200），画图要的正是这种连续值，但给人读的时候没有「东经 190 度」这回事。
 */
export function wrapLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // -0 显示成 "W0.0°" 之类的怪样子，统一成 0。
  return wrapped === 0 ? 0 : wrapped;
}

/** 角落读数，`N39.9° E116.4°` 这种形状。经度先折回再判东西。 */
export function formatLatLon(lat: number, lon: number): string {
  const x = wrapLon(lon);
  const ns = lat >= 0 ? "N" : "S";
  const ew = x >= 0 ? "E" : "W";
  return `${ns}${Math.abs(lat).toFixed(1)}° ${ew}${Math.abs(x).toFixed(1)}°`;
}

/**
 * 当纯文本处理：转义成可以安全拼进 HTML 的串。
 *
 * MapLibre 的 `customAttribution` 按 **HTML** 渲染，而随数据来的署名（can-db 地面
 * 数据的 `attribution`）是一列我们不写的字符串 —— 原样拼进去等于让数据往页面里注
 * 入标签。常驻的那一行是我们自己写的 HTML（带链接），不走这里。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
