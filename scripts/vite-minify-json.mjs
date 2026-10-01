/**
 * 构建时压缩 `?url` 引入的 JSON / GeoJSON 资源：去掉空白，`coordinates` 里的数
 * 保留 5 位小数（约 1 m）。
 *
 * 源文件不动：`src/basemap/atc/` 下是 can-radar 文件的逐字拷贝，改在源头会让下一次
 * 拷贝冲掉。只改 `_astro/` 里的产物。文件名里的哈希仍按源文件算；变换是确定的，同一
 * 份源永远产出同一份内容，长缓存不受影响。
 */
const DECIMALS = 5;
const SCALE = 10 ** DECIMALS;

function round(value) {
  if (typeof value === "number") return Math.round(value * SCALE) / SCALE;
  if (Array.isArray(value)) return value.map(round);
  return value;
}

function shrink(value) {
  if (Array.isArray(value)) return value.map(shrink);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = key === "coordinates" ? round(item) : shrink(item);
    }
    return out;
  }
  return value;
}

/** @returns {import("vite").Plugin} */
export function minifyJsonAssets() {
  return {
    name: "efb:minify-json-assets",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !/\.(geo)?json$/.test(file.fileName)) {
          continue;
        }
        const text =
          typeof file.source === "string"
            ? file.source
            : new TextDecoder().decode(file.source);
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          continue;
        }
        file.source = JSON.stringify(shrink(data));
      }
    },
  };
}
