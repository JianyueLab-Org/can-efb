/**
 * 导航台和空域的分类。分错了图上照样画得出一个符号、一块空域，只是画成了别的东西
 * —— 禁区画成普通扇区、VOR/DME 画成 NDB —— 屏幕不会说。
 */
import { expect, test, describe } from "bun:test";
import {
  airspaceClass,
  navaidClass,
  navaidTier,
  toNavaidPoints,
  type Navaid,
} from "@/lib/aip";
import { NAVAID_ICON } from "@/lib/chartStyle";

describe("导航台 kind → 类别 → 符号", () => {
  // can-db 今天实际有的四种取值，加上预留的两种和缺席。
  const cases: [string | null, string, string][] = [
    ["VOR/DME", "vordme", "vordme"],
    ["VOR", "vor", "vor"],
    ["DME", "dme", "dme"],
    ["NDB", "ndb", "ndb"],
    ["TACAN", "tacan", "tacan"],
    ["VORTAC", "vortac", "vortac"],
    ["vor / dme", "vordme", "vordme"],
    [null, "other", "navaid"],
    ["LOC", "other", "navaid"],
  ];
  test.each(cases)("%p", (kind, cls, icon) => {
    expect(navaidClass(kind)).toBe(cls as never);
    expect(NAVAID_ICON[navaidClass(kind)]).toBe(icon as never);
  });

  test("VOR 一族中等缩放，NDB 和 DME 放大才画", () => {
    expect(navaidTier("vordme")).toBe("vor");
    expect(navaidTier("vortac")).toBe("vor");
    expect(navaidTier("ndb")).toBe("minor");
    expect(navaidTier("dme")).toBe("minor");
  });

  test("要素带着类别和档位", () => {
    const n: Navaid = {
      ident: "SJD",
      kind: "NDB",
      name: "YANGZHOU",
      lat: 32,
      lon: 119,
      freqMhz: null,
      freqKhz: 300,
      channel: null,
      magVar: null,
      elevM: null,
      servedAirport: null,
      inAirway: false,
    };
    const props = toNavaidPoints([n]).features[0].properties;
    expect(props).toMatchObject({ cls: "ndb", tier: "minor" });
  });
});

describe("空域类别", () => {
  const a = (family: string, kind: string | null, localType: string | null) =>
    airspaceClass({ family, kind, localType });

  test("NAIP 的 P / R / D", () => {
    expect(a("restricted", "P", "禁区")).toBe("prohibited");
    expect(a("restricted", "R", "限制区")).toBe("restricted");
    expect(a("restricted", "D", "危险区")).toBe("danger");
  });

  test("kind 缺席时看 local_type", () => {
    expect(a("restricted", null, "危险区")).toBe("danger");
    expect(a("restricted", null, "禁区")).toBe("prohibited");
  });

  test("限制族里认不出的按限制区画，不降成普通扇区", () => {
    expect(a("restricted", "X", null)).toBe("restricted");
  });

  test("管制空域和等待空域", () => {
    expect(a("controlled", "CTA", null)).toBe("ctr");
    expect(a("controlled", "APP", null)).toBe("app");
    expect(a("special", "HAS", "等待空域")).toBe("other");
  });
});
