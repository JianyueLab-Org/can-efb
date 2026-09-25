import { describe, expect, test } from "bun:test";
import {
  handleState,
  initialSnap,
  SHEET_PEEK_PX,
  sheetOffsets,
  snapAfterDrag,
} from "@/lib/sheet";

const geometry = { height: 800, peek: SHEET_PEEK_PX };

/**
 * 偏移量是抽屉向下平移的像素：0 是拉满，越大露出来越少。算错了抽屉会停在两个档
 * 位之间，或者收起后连把手都看不见 —— 那时它就再也拉不回来了。
 */
describe("sheetOffsets", () => {
  test("三档：拉满、一半、只剩把手", () => {
    expect(sheetOffsets(geometry)).toEqual({
      full: 0,
      half: 400,
      collapsed: 800 - SHEET_PEEK_PX,
    });
  });

  test("抽屉比把手还矮时三档重合在 0，不给负数", () => {
    expect(sheetOffsets({ height: 60, peek: SHEET_PEEK_PX })).toEqual({
      full: 0,
      half: 0,
      collapsed: 0,
    });
  });
});

/**
 * 松手后停在哪一档由**动量**决定，不是由松手的位置决定：同一个像素上的慢拖和快
 * 甩应该落到不同的地方（can-ui 的 `projectToDetent` 讲了为什么）。
 */
describe("snapAfterDrag", () => {
  test("慢慢松手，停在最近的一档", () => {
    expect(snapAfterDrag(390, 0, geometry)).toBe("half");
    expect(snapAfterDrag(100, 0, geometry)).toBe("full");
    expect(snapAfterDrag(700, 0, geometry)).toBe("collapsed");
    expect(snapAfterDrag(420, 100, geometry)).toBe("half");
  });

  test("往下快甩，从拉满直接收起", () => {
    expect(snapAfterDrag(100, 2500, geometry)).toBe("collapsed");
  });

  test("往上快甩，从收起直接拉满", () => {
    expect(snapAfterDrag(700, -2500, geometry)).toBe("full");
  });
});

/** 表单页（wide）要打字，一打开就该拉满；地图页只占一半，把图让出来。 */
describe("initialSnap", () => {
  test("wide 页拉满，standard 页一半", () => {
    expect(initialSnap("wide")).toBe("full");
    expect(initialSnap("standard")).toBe("half");
  });
});

/**
 * 把手是一个按钮，读屏只念得出它的名字。所以此刻在哪一档要写进名字里，`aria-expanded`
 * 说的是抽屉有没有打开（一半和拉满都算开）。
 */
describe("handleState", () => {
  const text = {
    handle: "{state}。拖动或按方向键调整面板高度",
    states: { collapsed: "已收起", half: "半屏", full: "全屏" },
  };

  test("收起：没打开，名字里是收起", () => {
    expect(handleState("collapsed", text)).toEqual({
      expanded: false,
      label: "已收起。拖动或按方向键调整面板高度",
    });
  });

  test("一半和拉满都算打开，名字各报各的档", () => {
    expect(handleState("half", text)).toEqual({
      expanded: true,
      label: "半屏。拖动或按方向键调整面板高度",
    });
    expect(handleState("full", text).expanded).toBe(true);
    expect(handleState("full", text).label).toStartWith("全屏");
  });
});
