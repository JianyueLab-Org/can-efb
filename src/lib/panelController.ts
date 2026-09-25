/**
 * 浮动面板的行为：桌面和平板上折叠成一条，手机上是三档的底部抽屉，以及随时把自
 * 己盖住了哪一块告诉地图（`panel:layout`）。
 *
 * 面板是 Astro 渲染的静态 HTML，里面装着各页自己的岛屿 —— 把整页塞进一个 Vue 岛
 * 屿，正是轨当初避开的水合代价。所以行为写成这一段普通脚本：每次
 * `astro:page-load`（首屏和每次换页都会发）挂一次，`astro:before-swap` 拆一次。
 *
 * 纯计算在 `lib/panelLayout.ts` 和 `lib/sheet.ts`；这里只碰 DOM。
 */
import {
  prefersReducedMotion,
  rubberbandClamp,
  VelocityTracker,
} from "@jianyuelab-org/can-ui/motion";
import { announcePanelLayout } from "@/lib/mapBus";
import {
  parseShellMode,
  type PanelWidth,
  type ShellMode,
} from "@/lib/panelLayout";
import {
  initialSnap,
  SHEET_PEEK_PX,
  sheetOffsets,
  snapAfterDrag,
  type SheetSnap,
} from "@/lib/sheet";

/** 手指移动超过这么多才算拖，之前的都当点按 —— 否则抽屉里的按钮点不动。 */
const DRAG_SLOP_PX = 6;

/**
 * 尺寸变化引起的位置播报合并成一次。窗口拖动、宽度过渡都会连着触发几十次
 * ResizeObserver，每一次都让地图 easeTo 一回，镜头会一直在抖。
 */
const ANNOUNCE_DEBOUNCE_MS = 80;

let teardown: (() => void) | null = null;

function readShellMode(): ShellMode {
  return parseShellMode(
    getComputedStyle(document.documentElement).getPropertyValue("--shell-mode"),
  );
}

export function unmountPanel(): void {
  teardown?.();
  teardown = null;
}

export function mountPanel(): void {
  unmountPanel();

  const found = document.querySelector<HTMLElement>("[data-floating-panel]");
  if (!found) return;
  const root: HTMLElement = found;
  const body = root.querySelector<HTMLElement>("[data-panel-body]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-panel-toggle]");
  const handle = root.querySelector<HTMLButtonElement>("[data-panel-handle]");
  const width: PanelWidth = root.dataset.width === "wide" ? "wide" : "standard";

  let mode = readShellMode();
  let snap: SheetSnap = initialSnap(width);
  let announceTimer: ReturnType<typeof setTimeout> | null = null;

  const geometry = () => ({ height: root.offsetHeight, peek: SHEET_PEEK_PX });

  function announce() {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = null;
    const r = root.getBoundingClientRect();
    announcePanelLayout({
      mode,
      collapsed:
        mode === "phone"
          ? snap === "collapsed"
          : root.dataset.collapsed === "true",
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    });
  }

  function scheduleAnnounce() {
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(announce, ANNOUNCE_DEBOUNCE_MS);
  }

  /* ------------------------------------------------ 桌面 / 平板：折叠成一条 */

  function setCollapsed(next: boolean) {
    root.dataset.collapsed = String(next);
    // 收起时正文还在 DOM 里，只是看不见；inert 让键盘和读屏也跳过它，否则 Tab 会
    // 走进一块看不见的表单里。
    if (body) body.inert = next;
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(!next));
    const label = next
      ? toggle.dataset.labelExpand
      : toggle.dataset.labelCollapse;
    if (label) {
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
  }

  const onToggle = () => setCollapsed(root.dataset.collapsed !== "true");

  /* ------------------------------------------------ 手机：三档抽屉 */

  function applySnap(next: SheetSnap, animate = true) {
    snap = next;
    root.dataset.sheet = next;
    const moving = animate && !prefersReducedMotion();
    root.style.transition = moving ? "" : "none";
    root.style.setProperty(
      "--sheet-offset",
      `${sheetOffsets(geometry())[next]}px`,
    );
    if (body) body.inert = next === "collapsed";
    // 有动画时等 transitionend 再报位置；没有动画它就不会来，直接报。
    if (!moving) announce();
  }

  const tracker = new VelocityTracker();
  let pointerId: number | null = null;
  let startY = 0;
  let startOffset = 0;
  let dragging = false;
  let suppressClick = false;

  function onPointerDown(event: PointerEvent) {
    // 拖过之后手指抬起时不一定有 click（触屏上移动过就没有），留着这个标记，下一次
    // 点按 —— 把手、表单按钮、链接 —— 就会被 onClickCapture 吞掉。每次按下都清掉。
    suppressClick = false;
    if (mode !== "phone" || event.button !== 0) return;
    // 拉满时只有把手能拖，正文留给滚动；没拉满时整张抽屉都能拖。
    if (snap === "full" && !handle?.contains(event.target as Node)) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startOffset = sheetOffsets(geometry())[snap];
    dragging = false;
    tracker.reset();
    tracker.add(0, event.clientY, event.timeStamp);
  }

  function onPointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      // 过了门槛才抓住指针：一开始就抓，按钮上的点按会被改投到面板上，按钮就点不动了。
      dragging = true;
      root.setPointerCapture(event.pointerId);
      root.style.transition = "none";
    }
    const g = geometry();
    const o = sheetOffsets(g);
    root.style.setProperty(
      "--sheet-offset",
      `${rubberbandClamp(startOffset + dy, o.full, o.collapsed, g.height)}px`,
    );
    tracker.add(0, event.clientY, event.timeStamp);
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    applySnap(
      snapAfterDrag(
        startOffset + (event.clientY - startY),
        tracker.velocity().y,
        geometry(),
      ),
    );
  }

  /**
   * 浏览器把手势收走了（pointercancel）：回到原来那一档，不按松手投影。取消事件的
   * clientY 在有的引擎里是 0，拿它算落点会把抽屉甩到一个谁也没选的档位。取消之后
   * 也不会补 click，所以不置 suppressClick。
   */
  function onPointerCancel(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    applySnap(snap);
  }

  /** 拖完松手浏览器还会补一个 click；别让它落到把手上再翻一次档。 */
  function onClickCapture(event: MouseEvent) {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
    event.preventDefault();
  }

  /** 把手能点：一半 ↔ 拉满，收起时回到一半。 */
  function onHandleClick() {
    applySnap(snap === "half" ? "full" : "half");
  }

  /** 也能用方向键，拖不了的人一样能调。 */
  function onHandleKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      applySnap(snap === "collapsed" ? "half" : "full");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      applySnap(snap === "full" ? "half" : "collapsed");
    }
  }

  /** 抽屉没拉满时点进输入框就拉满：一半高度放不下键盘上面那一截。 */
  function onFocusIn(event: FocusEvent) {
    if (mode !== "phone" || snap === "full") return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches("input, textarea, select")
    ) {
      applySnap("full");
    }
  }

  /* ------------------------------------------------ 尺寸变化 */

  /**
   * 手机上视口高度变了（转屏、地址栏收放）而排布没变：`--sheet-offset` 是按旧高度
   * 算出的 px，不重算的话横过来一半那档会比整张面板还长，抽屉掉出屏幕，报给地图的
   * 矩形也跟着错。拖动中不动它，松手时会按新尺寸落档。
   */
  function onGeometryChange() {
    if (mode === "phone" && pointerId === null) {
      root.style.transition = "none";
      root.style.setProperty(
        "--sheet-offset",
        `${sheetOffsets(geometry())[snap]}px`,
      );
    }
    scheduleAnnounce();
  }

  /* ------------------------------------------------ 跨过断点 */

  function onResize() {
    const next = readShellMode();
    if (next !== mode) {
      mode = next;
      if (mode === "phone") {
        setCollapsed(false);
        applySnap(snap, false);
        return;
      }
      // 离开手机排布：抽屉那一套行内样式全部撤掉，交回给 CSS。
      root.style.removeProperty("--sheet-offset");
      root.style.transition = "";
      if (body) body.inert = root.dataset.collapsed === "true";
    }
    onGeometryChange();
  }

  /* 过渡被打断（换档途中又拖、宽度过渡途中又折叠）时不会有 transitionend，
     cancel 也要报一次，否则地图停在打断之前的内边距上。 */
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.target === root) announce();
  };
  const resizeObserver = new ResizeObserver(onGeometryChange);

  /* 轨折叠或展开：面板的 `left` 跟着 `--rail-current` 变，宽度不变，所以
     ResizeObserver 不响。有动画时靠 transitionend 报；减少动态效果时
     `transition: none`，transitionend 不会来 —— 不看 `data-rail` 的话地图的内边
     距一直按旧的轨宽算，差出一整条轨。 */
  const railObserver = new MutationObserver(scheduleAnnounce);

  toggle?.addEventListener("click", onToggle);
  handle?.addEventListener("click", onHandleClick);
  handle?.addEventListener("keydown", onHandleKeydown);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerCancel);
  root.addEventListener("click", onClickCapture, true);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("transitionend", onTransitionEnd);
  root.addEventListener("transitioncancel", onTransitionEnd);
  window.addEventListener("resize", onResize);
  resizeObserver.observe(root);
  railObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-rail"],
  });

  if (mode === "phone") applySnap(snap, false);
  else announce();

  teardown = () => {
    if (announceTimer) clearTimeout(announceTimer);
    toggle?.removeEventListener("click", onToggle);
    handle?.removeEventListener("click", onHandleClick);
    handle?.removeEventListener("keydown", onHandleKeydown);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", onPointerUp);
    root.removeEventListener("pointercancel", onPointerCancel);
    root.removeEventListener("click", onClickCapture, true);
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("transitionend", onTransitionEnd);
    root.removeEventListener("transitioncancel", onTransitionEnd);
    window.removeEventListener("resize", onResize);
    resizeObserver.disconnect();
    railObserver.disconnect();
  };
}
