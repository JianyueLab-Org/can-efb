#!/usr/bin/env bun
/**
 * 从 VATSpy 的 `boundaries.geojson` 生成这个站要用的飞行情报区边界。
 *
 * ## 为什么不用 can-db 的 `?family=fir`
 *
 * **汇编（NAIP）根本没有发布完整的情报区边界。** `AIRSPACE_BORDER_VERTEX` 里给的是
 * 边界**国内一侧的折线**，首尾两个顶点标着 `是国境点` —— 剩下那一段沿国境线走，而
 * **国境线本身不在这份数据里**。
 *
 * can-db 照 `seq` 把顶点拼成一个闭合环，于是从最后一个点直接连回第一个点，在国境线
 * 该在的地方切一条直线。乌鲁木齐最明显：全区**只有 6 个顶点**（VATSpy 那份是 275
 * 个），首尾都是国境点，那条弦直接横穿新疆。沈阳 9 个对 469 个，昆明 18 个对 322
 * 个，都是同一回事。
 *
 * 这类错误最难发现的地方在于**它不报错，看起来还挺像回事**：屏幕上确实有一圈边界，
 * 只是圈错了地方。
 *
 * 换句话说这不是 can-db 的实现问题，**是它那份来源缺这段几何** —— 要用它画边界，得
 * 先有一份国境线数据去补那一段。VATSpy 那份是描好的完整边界，直接可用。
 *
 * 它还带 `label_lon`/`label_lat`，是数据自己选好的标注位置。
 *
 * ## 上游是谁
 *
 * `boundaries.geojson` 的上游之源在 **can-web**（`data/vatspy/README.md`），
 * can-radar 是一份拷贝，这里是第二份 —— 拷的是**派生结果**。刷新时回到 can-web 那
 * 条流程再重跑这个脚本，不要在这里手改坐标。
 *
 * 许可是 **CC BY-SA 4.0**，所以 `RouteMap.vue` 里手动加了一个 `AttributionControl`
 * 署名（内建那个关着，因为要的是自己那行字）。这不是风格选择：换成这份数据之前那里
 * 一行署名都没有，理由是 Natural Earth 属公有领域 —— 那个理由现在不成立了。
 *
 * ## 带连字符的一律筛掉，而且这件事是自证的
 *
 * 768 个要素里有 343 个是扇区划分（`ADR-E`、`BIRD-N`），画在自己所属 FIR 之上。全
 * 铺开就是每个被拆过的 FIR 一圈外框加几条内部分割线，叠成一张网 —— 这张图要的是情
 * 报区边界，不是那张网。
 *
 * **can-radar 的判据比这里严**（「父要素也在数据里」才算子扇区），因为它画的是**管
 * 制席位覆盖**：有人上了 `ZJSY_CTR`，那块就必须画得出来。这张图不是那件事，所以这
 * 里一刀切 —— 但一刀切会不会切掉一整块空域，不能靠猜。
 *
 * 所以脚本自己查：**每一个被筛掉的"无父"要素，都必须落在某个保留下来的要素里面**。
 * 当前周期的 22 个无父要素全部通过（`ZJSY-*`⊂ZJSA、`ZWWW-*`⊂ZWUQ、`TEH-*`⊂OIIX、
 * `LGMD-*`⊂LGGG）。哪天 VATSpy 换了结构、某块空域只以连字符形式存在，这里会直接报
 * 错而不是安静地少画一块。
 *
 * ## 两个标记：`fir` 和 `atc`
 *
 * 这份文件有两个消费者：情报区图层，和实时那一层（拿边界圈出在线席位管的范围，
 * `lib/datafeed.ts` 的 `toControllerAreas`）。两边要的要素不一样，所以不删，打标记：
 *
 * - `fir`：情报区图层画不画它。
 * - `atc`：实时那一层用不用它。
 *
 * **区调 `fir: false`。** VATPRC 把每个情报区又按区调切了一遍，而且用的是**不带
 * 连字符的 id**：`ZSAM` 是厦门区调，名字写成 `Xiamen ACC - Shanghai FIR - Xiamen`，
 * 画在 `ZSHA` 里面。上面那条连字符规则挡不住它们。判据取自 VATSpy 的 `[FIRs]` 名字
 * （can-radar 的 `public/firs.json`）：名字里写着 `ACC`，并且**自己点名了所属的
 * FIR**。只看 `ACC` 不够 —— `RKRR`（Incheon ACC）、`VTBB`（Bangkok ACC）本身就是那
 * 个情报区的边界，没有别的要素替它。实时那一层仍要它们：`ZSSS_CTR` 上线要圈出上海区调。
 *
 * **日本是一个情报区（福冈，RJJJ），VATSpy 里没有这一块。** 它给的是 `RJDG`（陆上
 * 全境）、`RJTG`/`RJBG`（其中两个区调）和 `RJJJ`（只有洋区那一半）。`MERGED_FIRS`
 * 把陆上和洋区沿共用的边拼成一块 `RJJJ`，只给情报区图层（`atc: false`）；参与拼接的
 * 和被它盖住的区调都 `fir: false`，留给实时那一层。拼不成一个环就报错退出。
 *
 * ## 输出在 `src/`，不是 `public/`
 *
 * 那样 Vite 会给它一个内容哈希的名字，从而拿到一年的 immutable 缓存和边缘命中。
 * 放 `public/` 的话名字是固定的，只能拿到 `max-age=0` —— 理由写在 `lib/firs.ts`
 * 上面。所以**改完记得重新构建**，光换文件不会生效。
 *
 * ## 坐标留四位小数
 *
 * 0.0001° 约 11 m —— 在这张图能放到的任何比例尺上都看不出差别，而它把 786 KB 压到
 * 653 KB。再往下砍（三位，约 111 m）省得不多，却开始接近能看出来的量级。
 *
 * ## 用法
 *
 * ```bash
 * bun scripts/build-firs.mjs \
 *   ../can-radar/public/boundaries.geojson ../can-radar/public/firs.json \
 *   src/basemap/firs.json
 * ```
 */
import { readFileSync, writeFileSync } from "node:fs";

const [input, names, output] = process.argv.slice(2);
if (!input || !names || !output) {
  console.error(
    "usage: bun scripts/build-firs.mjs <boundaries.geojson> <firs.json> <out.json>",
  );
  process.exit(2);
}

const source = JSON.parse(readFileSync(input, "utf8"));

/* 边界 id → 它在 `[FIRs]` 里的全部名字。见文件头「区调打标记」。 */
const namesByBoundary = new Map();
for (const entry of JSON.parse(readFileSync(names, "utf8")).firs) {
  const list = namesByBoundary.get(entry.boundary) ?? [];
  list.push(entry.name);
  namesByBoundary.set(entry.boundary, list);
}
const ACC_IN_FIR = /\bACC\b.* - .*\bFIR\b/;
const isAcc = (id) => {
  const list = namesByBoundary.get(id);
  return Boolean(list?.length) && list.every((name) => ACC_IN_FIR.test(name));
};

/* VATSpy 里拆开了、实际是一个情报区的。`parts` 拼成一块，`covers` 是落在里面的
 * 区调。见文件头「两个标记」。 */
const MERGED_FIRS = [
  { code: "RJJJ", parts: ["RJDG", "RJJJ"], covers: ["RJTG", "RJBG"] },
];
const replacedByMerge = new Set(
  MERGED_FIRS.flatMap((m) => [...m.parts, ...m.covers]),
);

/* 把几个单环多边形沿**完全重合的边**拼成一个环：统一成逆时针，两边方向相反的边
 * 成对抵消，剩下的边首尾接成环。VATSpy 相邻两块共用同一串顶点，所以不需要真正的
 * 多边形求并。 */
function dissolve(rings) {
  const key = ([x, y]) => `${x},${y}`;
  const area = (ring) => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return sum / 2;
  };
  const edges = new Map();
  for (const raw of rings) {
    const ring = area(raw) < 0 ? [...raw].reverse() : raw;
    for (let i = 0; i < ring.length - 1; i++) {
      const [a, b] = [ring[i], ring[i + 1]];
      if (key(a) === key(b)) continue;
      const back = `${key(b)}>${key(a)}`;
      if (edges.has(back)) edges.delete(back);
      else edges.set(`${key(a)}>${key(b)}`, [a, b]);
    }
  }
  const next = new Map();
  for (const [a, b] of edges.values()) {
    if (next.has(key(a))) return null;
    next.set(key(a), b);
  }
  const [start] = edges.values();
  const ring = [start[0]];
  let at = start[1];
  while (key(at) !== key(start[0])) {
    ring.push(at);
    at = next.get(key(at));
    if (!at || ring.length > edges.size) return null;
  }
  ring.push(start[0]);
  return ring.length - 1 === edges.size ? ring : null;
}

const outerRing = (feature) => {
  const { type, coordinates } = feature.geometry;
  const polys = type === "MultiPolygon" ? coordinates : [coordinates];
  if (polys.length !== 1 || polys[0].length !== 1) return null;
  return polys[0][0];
};

const idOf = (f) => String(f.properties?.id ?? "");

function bbox(geometry) {
  const polys =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  for (const poly of polys) {
    for (const ring of poly) {
      for (const [lon, lat] of ring) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
  }
  return [w, s, e, n];
}

const kept = [];
const dropped = [];
for (const feature of source.features) {
  const id = idOf(feature);
  if (!id) continue;
  (id.includes("-") ? dropped : kept).push(feature);
}

/* 自证：筛掉的每一块都得落在留下的某一块里。见文件头。
 *
 * 用包围盒而不是真正的点在多边形内判断 —— 这里要挡的是「一整块空域消失」，那种
 * 情况下包围盒也不会被含住。为一个构建期的健全性检查引进一套多边形运算不划算。 */
const keptBoxes = kept.map((f) => [idOf(f), bbox(f.geometry)]);
const orphaned = [];
for (const feature of dropped) {
  const id = idOf(feature);
  const [w, s, e, n] = bbox(feature.geometry);
  const covered = keptBoxes.some(
    ([, b]) =>
      b[0] <= w + 0.01 &&
      b[1] <= s + 0.01 &&
      b[2] >= e - 0.01 &&
      b[3] >= n - 0.01,
  );
  if (!covered) orphaned.push(id);
}
if (orphaned.length) {
  console.error(
    "这些扇区划分没有任何保留下来的情报区含住它们 —— 一刀切会让这几块空域整个消失：\n  " +
      orphaned.join(", ") +
      "\n改回 can-radar 那条「父要素也在数据里」的判据，或者单独放行它们。",
  );
  process.exit(1);
}

const round = (c) =>
  typeof c[0] === "number"
    ? [Number(c[0].toFixed(4)), Number(c[1].toFixed(4))]
    : c.map(round);

const features = kept.map((feature) => {
  const labelLat = Number(feature.properties?.label_lat);
  const labelLon = Number(feature.properties?.label_lon);
  return {
    type: "Feature",
    properties: {
      // `code` 而不是 `id`：图层里读的就是这个名字，和 can-db 那批空域一致。
      code: idOf(feature),
      oceanic: String(feature.properties?.oceanic ?? "0") === "1",
      fir: !isAcc(idOf(feature)) && !replacedByMerge.has(idOf(feature)),
      atc: true,
      // 数据自己选的标注位置。取不到就留 null，画的那一边自己决定怎么办。
      labelLat: Number.isFinite(labelLat) ? labelLat : null,
      labelLon: Number.isFinite(labelLon) ? labelLon : null,
    },
    geometry: {
      type: feature.geometry.type,
      coordinates: round(feature.geometry.coordinates),
    },
  };
});

for (const merge of MERGED_FIRS) {
  const parts = merge.parts.map((code) =>
    kept.find((f) => idOf(f) === code && outerRing(f)),
  );
  const ring = parts.every(Boolean) && dissolve(parts.map((f) => outerRing(f)));
  if (!ring) {
    console.error(
      `${merge.code}：${merge.parts.join(" + ")} 拼不成一个环 —— ` +
        "缺了某一块、它不是单环，或者两块不再共用同一串顶点。",
    );
    process.exit(1);
  }
  const label = parts[0].properties;
  features.push({
    type: "Feature",
    properties: {
      code: merge.code,
      oceanic: false,
      fir: true,
      atc: false,
      labelLat: Number(label.label_lat),
      labelLon: Number(label.label_lon),
    },
    geometry: { type: "Polygon", coordinates: round([ring]) },
  });
}

writeFileSync(output, JSON.stringify({ type: "FeatureCollection", features }));
const hidden = features
  .filter((f) => !f.properties.fir)
  .map((f) => f.properties.code);
console.log(
  `firs: ${features.length} 个要素（筛掉 ${dropped.length} 个扇区划分，` +
    `全部已核对落在保留的情报区内）→ ${output}\n` +
    `  情报区图层不画：${[...new Set(hidden)].join(" ")}\n` +
    `  拼接：${MERGED_FIRS.map((m) => `${m.code} = ${m.parts.join(" + ")}`).join("，")}`,
);
