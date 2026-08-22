/**
 * 生成底图：细一档的陆地，加上国界。
 *
 * 现有的 `land-50m.json` 是 1:50m 的全球陆地，**留着不动** —— 它是缩到最小时的底
 * 子，任何时候都在。这个脚本出的是**放大之后才加载的那一层**：1:10m 的陆地和国
 * 界，裁到本网络覆盖得到的那一块。
 *
 * ## 为什么分两层而不是直接换掉
 *
 * 1:10m 的全球陆地是 15 MB 的 GeoJSON —— 那是每次首屏都要付的钱，而缩到最小时那些
 * 细节一个像素都看不出来。裁到区域内是 3.55 MB，但裁过之后框外就没有陆地了：谁往
 * 西平移一下就会看到地图"缺了一块"。
 *
 * 所以 50m 全球做底子（照旧、开图就有），10m 区域做细节（放大到 z5 才拉）。两层叠
 * 着画，细节那层盖在上面。
 *
 * ## 取整不是压缩技巧
 *
 * Natural Earth 1:10m 的固有精度是百米级，而原始坐标带着十几位小数。保留四位（约
 * 11 米）**比数据本身精确一个量级**，却能把体积砍掉一半 —— 那些位数不是信息。
 *
 * ## 国界只要国与国之间那条
 *
 * `topojson.mesh` 的第三个参数筛的就是这个：`(a, b) => a !== b` 只留内边界。海岸线
 * 已经由 `land-outline` 画了，再画一遍等于在同一条线上叠两种颜色。
 *
 *     bun scripts/build-basemap.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as topojson from "topojson-client";
import land10 from "world-atlas/land-10m.json" with { type: "json" };
import countries10 from "world-atlas/countries-10m.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "src", "basemap");

/**
 * 裁剪框。**比覆盖区放得宽**：网络自己是 12 个情报区（约 73–155E / 3–55N），这里
 * 放到 55–180E / 20S–70N，好让人往外平移一两屏时细节还在，而不是撞上一条直边。
 */
const BOX = { w: 55, e: 180, s: -20, n: 70 };

/** 保留小数位。见文件头 —— 四位约 11 米，比 1:10m 数据本身精确一个量级。 */
const DP = 4;

const round = (v) => Number(v.toFixed(DP));

/**
 * 多边形按矩形裁剪（Sutherland–Hodgman）。
 *
 * 对**矩形**是精确的，不是近似 —— 这就是选它而不是引一个通用裁剪库的理由：裁剪框
 * 永远是一个正的经纬度矩形。
 */
function clipRing(ring, box) {
  const sides = [
    ["w", (p) => p[0] >= box.w],
    ["e", (p) => p[0] <= box.e],
    ["s", (p) => p[1] >= box.s],
    ["n", (p) => p[1] <= box.n],
  ];
  let poly = ring;
  for (const [side, inside] of sides) {
    const src = poly;
    poly = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i + src.length - 1) % src.length];
      const cut = (a, b) => {
        if (side === "w" || side === "e") {
          const x = side === "w" ? box.w : box.e;
          const t = (x - a[0]) / (b[0] - a[0]);
          return [x, a[1] + t * (b[1] - a[1])];
        }
        const y = side === "s" ? box.s : box.n;
        const t = (y - a[1]) / (b[1] - a[1]);
        return [a[0] + t * (b[0] - a[0]), y];
      };
      if (inside(cur)) {
        if (!inside(prev)) poly.push(cut(prev, cur));
        poly.push(cur);
      } else if (inside(prev)) {
        poly.push(cut(prev, cur));
      }
    }
    if (!poly.length) return null;
  }
  // 少于四个点围不成面 —— 那是被裁成了一条线或一个点。
  return poly.length >= 4 ? poly.map((p) => [round(p[0]), round(p[1])]) : null;
}

function clipPolygon(geometry, box) {
  const polys =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const kept = [];
  for (const poly of polys) {
    const rings = poly.map((r) => clipRing(r, box)).filter(Boolean);
    if (rings.length) kept.push(rings);
  }
  if (!kept.length) return null;
  return kept.length === 1
    ? { type: "Polygon", coordinates: kept[0] }
    : { type: "MultiPolygon", coordinates: kept };
}

/** 线按框裁：留在框里的那些连续段，各自成为一条线。 */
function clipLines(lines, box) {
  const inside = (p) =>
    p[0] >= box.w && p[0] <= box.e && p[1] >= box.s && p[1] <= box.n;
  const out = [];
  for (const line of lines) {
    let run = [];
    for (const p of line) {
      if (inside(p)) run.push([round(p[0]), round(p[1])]);
      else {
        if (run.length > 1) out.push(run);
        run = [];
      }
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

const mb = (o) => (JSON.stringify(o).length / 1048576).toFixed(2) + " MB";

// ---- 陆地 ----------------------------------------------------------------
const land = topojson.feature(land10, land10.objects.land);
const landOut = {
  type: "FeatureCollection",
  features: land.features
    .map((f) => {
      const g = clipPolygon(f.geometry, BOX);
      return g ? { type: "Feature", properties: {}, geometry: g } : null;
    })
    .filter(Boolean),
};

// ---- 国界 ----------------------------------------------------------------
// `a !== b` 只留国与国之间那条。海岸线由 land-outline 画，这里不要。
const mesh = topojson.mesh(
  countries10,
  countries10.objects.countries,
  (a, b) => a !== b,
);
const bordersOut = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiLineString",
        coordinates: clipLines(mesh.coordinates, BOX),
      },
    },
  ],
};

writeFileSync(join(out, "land-10m.json"), JSON.stringify(landOut));
writeFileSync(join(out, "borders-10m.json"), JSON.stringify(bordersOut));

console.log(
  `裁剪框 ${BOX.w}–${BOX.e}E / ${Math.abs(BOX.s)}S–${BOX.n}N，保留 ${DP} 位小数`,
);
console.log(
  `  land-10m.json     ${mb(landOut)}   ${landOut.features.length} 块`,
);
console.log(
  `  borders-10m.json  ${mb(bordersOut)}   ${bordersOut.features[0].geometry.coordinates.length} 段`,
);
