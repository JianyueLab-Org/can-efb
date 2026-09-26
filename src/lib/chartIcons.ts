/**
 * 航图符号和斜线图块，**运行时用 canvas 画出来注册**，不引 sprite 文件。
 *
 * 名字和颜色都来自 `lib/chartStyle.ts`：这里只管形状。两套主题各画一份，颜色画进
 * 图里（细线走 SDF 会被吃掉抗锯齿的那半边）；每个符号先用底色描一圈宽边再画本体，
 * 压在航路线上也读得出来。飞机例外，按 SDF 注册，颜色由 `icon-color` 给。
 *
 * 画布按符号实际大小裁（`Shape.size`），`icon-size` 留在 1 附近。航路代号牌是可拉
 * 伸图（`stretchX` / `stretchY` / `content`），配 `icon-text-fit: both` 随字变宽。
 *
 * 只能在浏览器里跑（要 `document`）。注册了哪些名字由 `chartStyle.test.ts` 对着
 * `allImageIds()` 钉住。
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  AIRSPACE,
  AIRCRAFT_ICON,
  COLORS,
  HOLD_ARROW_ICON,
  PATTERNS,
  SHIELDS,
  themedImage,
  type Pattern,
  type Shield,
  type Theme,
  type ThemedIcon,
} from "@/lib/chartStyle";

/** 底色描边比本体宽多少（画布像素）。 */
const HALO = 3;

type Pass = { color: string; grow: number };
/** `c` 是画布中心。 */
type Draw = (ctx: CanvasRenderingContext2D, pass: Pass, c: number) => void;

function canvas(w: number, h = w): CanvasRenderingContext2D | null {
  const el = document.createElement("canvas");
  el.width = w;
  el.height = h;
  return el.getContext("2d");
}

/** 先画一遍加宽的底色，再画本体。 */
function render(shape: Shape, color: string, halo: string): ImageData | null {
  const ctx = canvas(shape.size);
  if (!ctx) return null;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const c = shape.size / 2;
  shape.draw(ctx, { color: halo, grow: HALO }, c);
  shape.draw(ctx, { color, grow: 0 }, c);
  return ctx.getImageData(0, 0, shape.size, shape.size);
}

function strokePath(ctx: CanvasRenderingContext2D, p: Pass, width: number) {
  ctx.strokeStyle = p.color;
  ctx.lineWidth = width + p.grow;
  ctx.stroke();
}

/** 填充；底色那一遍额外描一圈，让填充的形状也有边。 */
function fillPath(ctx: CanvasRenderingContext2D, p: Pass) {
  ctx.fillStyle = p.color;
  ctx.fill();
  if (p.grow) strokePath(ctx, p, 0);
}

function dot(
  ctx: CanvasRenderingContext2D,
  p: Pass,
  x: number,
  y: number,
  r: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  fillPath(ctx, p);
}

/** 正六边形的顶点，平顶（VOR 的画法）。 */
function hexagon(c: number, r: number): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  });
}

function polygon(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** TACAN 的三块"耳朵"：隔一条边向外伸出一块。 */
function tacanLobes(
  ctx: CanvasRenderingContext2D,
  p: Pass,
  c: number,
  r: number,
) {
  const hex = hexagon(c, r);
  for (const i of [0, 2, 4]) {
    const [x1, y1] = hex[i];
    const [x2, y2] = hex[(i + 1) % 6];
    const mx = (x1 + x2) / 2 - c;
    const my = (y1 + y2) / 2 - c;
    const len = Math.hypot(mx, my);
    const ox = (mx / len) * 3;
    const oy = (my / len) * 3;
    polygon(ctx, [
      [x1, y1],
      [x2, y2],
      [x2 + ox, y2 + oy],
      [x1 + ox, y1 + oy],
    ]);
    fillPath(ctx, p);
  }
}

function ring(
  ctx: CanvasRenderingContext2D,
  p: Pass,
  c: number,
  r: number,
  width: number,
) {
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  strokePath(ctx, p, width);
}

/** 画布边长（画布像素，pixelRatio 2，一半就是 CSS px），贴着符号加底色描边裁。 */
type Shape = { size: number; draw: Draw };

const SHAPES: Record<ThemedIcon, Shape> = {
  // 航路点：空心三角，重心在画布中心。
  waypoint: {
    size: 18,
    draw: (ctx, p, c) => {
      const r = 5.6;
      polygon(
        ctx,
        [90, 210, 330].map((deg): [number, number] => {
          const a = (deg * Math.PI) / 180;
          return [c + r * Math.cos(a), c - r * Math.sin(a)];
        }),
      );
      strokePath(ctx, p, 1.6);
    },
  },
  // VOR：六边形加中心点。
  vor: {
    size: 22,
    draw: (ctx, p, c) => {
      polygon(ctx, hexagon(c, 7));
      strokePath(ctx, p, 1.6);
      dot(ctx, p, c, c, 1.3);
    },
  },
  // VOR/DME：六边形套在方框里。
  vordme: {
    size: 24,
    draw: (ctx, p, c) => {
      ctx.beginPath();
      ctx.rect(c - 8.5, c - 8.5, 17, 17);
      strokePath(ctx, p, 1.4);
      polygon(ctx, hexagon(c, 6.5));
      strokePath(ctx, p, 1.4);
      dot(ctx, p, c, c, 1.2);
    },
  },
  // 单独的 DME：方框加中心点。
  dme: {
    size: 20,
    draw: (ctx, p, c) => {
      ctx.beginPath();
      ctx.rect(c - 6.5, c - 6.5, 13, 13);
      strokePath(ctx, p, 1.6);
      dot(ctx, p, c, c, 1.3);
    },
  },
  // TACAN：三块耳朵加中心点，不画六边形的其余三条边。
  tacan: {
    size: 24,
    draw: (ctx, p, c) => {
      tacanLobes(ctx, p, c, 6.5);
      dot(ctx, p, c, c, 1.3);
    },
  },
  // VORTAC：完整六边形加三块耳朵。
  vortac: {
    size: 24,
    draw: (ctx, p, c) => {
      polygon(ctx, hexagon(c, 6.5));
      strokePath(ctx, p, 1.4);
      tacanLobes(ctx, p, c, 6.5);
      dot(ctx, p, c, c, 1.2);
    },
  },
  // NDB：中心一个点，外面两圈小点。
  ndb: {
    size: 26,
    draw: (ctx, p, c) => {
      dot(ctx, p, c, c, 1.8);
      for (const [radius, count, r] of [
        [5.5, 10, 0.85],
        [9.5, 16, 0.8],
      ] as const) {
        for (let i = 0; i < count; i++) {
          const a = ((Math.PI * 2) / count) * i;
          dot(ctx, p, c + radius * Math.cos(a), c + radius * Math.sin(a), r);
        }
      }
    },
  },
  // 认不出台型的：一个圈加中心点，不冒充任何一种。
  navaid: {
    size: 20,
    draw: (ctx, p, c) => {
      ring(ctx, p, c, 5.5, 1.5);
      dot(ctx, p, c, c, 1.2);
    },
  },
  // 主要机场：实心圆。
  "apt-major": {
    size: 18,
    draw: (ctx, p, c) => dot(ctx, p, c, c, 5),
  },
  // 其余机场：空心圆。
  "apt-minor": {
    size: 18,
    draw: (ctx, p, c) => ring(ctx, p, c, 4.2, 1.8),
  },
};

/**
 * 代号牌：圆角矩形，外圈一道底色边。画布像素，pixelRatio 2。四角（`r`）不拉伸，
 * 中间那一段横竖都能拉；`content` 是字放进去的那块。
 */
const SHIELD_W = 20;
const SHIELD_H = 18;
const SHIELD_R = 5;

function shield(fill: string, halo: string): ImageData | null {
  const ctx = canvas(SHIELD_W, SHIELD_H);
  if (!ctx) return null;
  const box = (inset: number) => {
    ctx.beginPath();
    ctx.roundRect(
      inset,
      inset,
      SHIELD_W - inset * 2,
      SHIELD_H - inset * 2,
      SHIELD_R - inset,
    );
  };
  ctx.fillStyle = halo;
  box(0);
  ctx.fill();
  ctx.fillStyle = fill;
  box(1.5);
  ctx.fill();
  return ctx.getImageData(0, 0, SHIELD_W, SHIELD_H);
}

type ImageOptions = NonNullable<Parameters<MapLibreMap["addImage"]>[2]>;

const SHIELD_OPTIONS: ImageOptions = {
  stretchX: [[SHIELD_R, SHIELD_W - SHIELD_R]] as [number, number][],
  stretchY: [[SHIELD_R, SHIELD_H - SHIELD_R]] as [number, number][],
  content: [3, 3, SHIELD_W - 3, SHIELD_H - 3] as [
    number,
    number,
    number,
    number,
  ],
};

/** 45° 斜线图块，无缝平铺。 */
function hatch(color: string, spacing: number): ImageData | null {
  const { tile, lineWidth } = AIRSPACE.hatch;
  const ctx = canvas(tile);
  if (!ctx) return null;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "square";
  ctx.beginPath();
  for (let k = -tile; k <= tile * 2; k += spacing) {
    ctx.moveTo(k, tile);
    ctx.lineTo(k + tile, 0);
  }
  ctx.stroke();
  return ctx.getImageData(0, 0, tile, tile);
}

/** 飞机，机头朝上（航向 0）。SDF，所以画成白色实心。 */
function aircraft(): ImageData | null {
  const size = 22;
  const ctx = canvas(size);
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 1);
  ctx.lineTo(size - 3, size - 4);
  ctx.lineTo(size / 2, size - 8);
  ctx.lineTo(3, size - 4);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** 等待航线的方向箭头：朝北的实心箭头。SDF，所以画成白色实心，颜色和描边由样式给。 */
function holdArrow(): ImageData | null {
  const size = 16;
  const ctx = canvas(size);
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 2);
  ctx.lineTo(size - 3, size - 3);
  ctx.lineTo(size / 2, size - 6);
  ctx.lineTo(3, size - 3);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

/** 注册 `allImageIds()` 里的每一张图。重复调用无害。 */
export function registerChartIcons(map: MapLibreMap): void {
  const add = (
    id: string,
    data: ImageData | null,
    options: ImageOptions = {},
  ) => {
    if (!data || map.hasImage(id)) return;
    map.addImage(id, data, { pixelRatio: 2, ...options });
  };

  add(AIRCRAFT_ICON, aircraft(), { sdf: true });
  add(HOLD_ARROW_ICON, holdArrow(), { sdf: true });

  for (const theme of ["light", "dark"] as Theme[]) {
    const c = COLORS[theme];
    const colorOf: Record<ThemedIcon, string> = {
      waypoint: c.waypoint,
      vor: c.navaid,
      vordme: c.navaid,
      dme: c.navaid,
      tacan: c.navaid,
      vortac: c.navaid,
      ndb: c.ndb,
      navaid: c.navaid,
      "apt-major": c.airport,
      "apt-minor": c.airport,
    };
    for (const [key, shape] of Object.entries(SHAPES) as [
      ThemedIcon,
      Shape,
    ][]) {
      add(themedImage(key, theme), render(shape, colorOf[key], c.halo));
    }
    const shields: Record<Shield, ImageData | null> = {
      "shield-rnav": shield(c.shieldRnav, c.halo),
      "shield-conv": shield(c.shieldConv, c.halo),
    };
    for (const key of SHIELDS) {
      add(themedImage(key, theme), shields[key], SHIELD_OPTIONS);
    }
    const patterns: Record<Pattern, ImageData | null> = {
      "hatch-restricted": hatch(c.restricted, AIRSPACE.hatch.spacing),
      "hatch-prohibited": hatch(c.prohibited, AIRSPACE.prohibitedSpacing),
    };
    for (const [key, data] of Object.entries(patterns) as [
      Pattern,
      ImageData | null,
    ][]) {
      add(themedImage(key, theme), data);
    }
  }
}

/** 这个模块会注册的全部图片名（给测试对照 `allImageIds()`）。 */
export function registeredImageIds(): string[] {
  const out: string[] = [AIRCRAFT_ICON, HOLD_ARROW_ICON];
  for (const theme of ["light", "dark"] as Theme[]) {
    for (const key of Object.keys(SHAPES) as ThemedIcon[]) {
      out.push(themedImage(key, theme));
    }
    for (const key of PATTERNS) out.push(themedImage(key, theme));
    for (const key of SHIELDS) out.push(themedImage(key, theme));
  }
  return out;
}
