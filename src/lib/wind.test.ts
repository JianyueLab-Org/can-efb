import { describe, expect, test } from "bun:test";
import { parseMetarWind, windComponents } from "./wind";

describe("parseMetarWind", () => {
  test("reads direction, speed and gust in knots", () => {
    expect(
      parseMetarWind("RJTT 260030Z 18012G22KT 9999 FEW020 24/18 Q1012"),
    ).toEqual({ direction: 180, speedKt: 12, gustKt: 22 });
  });

  test("converts metres per second", () => {
    expect(parseMetarWind("ZBAA 260000Z 32004MPS CAVOK")).toEqual({
      direction: 320,
      speedKt: 8,
      gustKt: null,
    });
  });

  test("VRB has no direction", () => {
    expect(parseMetarWind("ZSSS 260000Z VRB02KT 9999")).toEqual({
      direction: null,
      speedKt: 2,
      gustKt: null,
    });
  });

  test("does not take the variable-direction group or a missing group", () => {
    expect(parseMetarWind("RJOO 260000Z 29008KT 250V320 9999")?.direction).toBe(
      290,
    );
    expect(parseMetarWind("RJOO 260000Z /////KT 9999")).toBeNull();
    expect(parseMetarWind("")).toBeNull();
    expect(parseMetarWind(null)).toBeNull();
  });
});

describe("windComponents", () => {
  test("straight down the runway is all headwind", () => {
    expect(
      windComponents({ direction: 320, speedKt: 10, gustKt: null }, 320),
    ).toEqual({ headKt: 10, crossKt: 0, crossFrom: null });
  });

  test("a reciprocal wind is a tailwind", () => {
    expect(
      windComponents({ direction: 140, speedKt: 10, gustKt: null }, 320)
        ?.headKt,
    ).toBe(-10);
  });

  test("crosswind side follows the wind, not the runway", () => {
    // Runway 360, wind from 090: from the right.
    expect(
      windComponents({ direction: 90, speedKt: 10, gustKt: null }, 0),
    ).toEqual({ headKt: 0, crossKt: 10, crossFrom: "right" });
    expect(
      windComponents({ direction: 270, speedKt: 10, gustKt: null }, 0)
        ?.crossFrom,
    ).toBe("left");
  });

  test("VRB with speed has no components; calm is zero", () => {
    expect(
      windComponents({ direction: null, speedKt: 5, gustKt: null }, 0),
    ).toBeNull();
    expect(
      windComponents({ direction: null, speedKt: 0, gustKt: null }, 0),
    ).toEqual({ headKt: 0, crossKt: 0, crossFrom: null });
  });
});
