import { describe, expect, test } from "bun:test";
import {
  allowsExtending,
  extendedCallsign,
  facilitySuffix,
  parseAtisSectors,
} from "./atisSectors";

describe("parseAtisSectors", () => {
  test("reads the EuroScope ATIS3 covering line", () => {
    expect(
      parseAtisSectors([
        "Tokyo Control / Tokyo Kontororu (JA)",
        "Covering sector - T30",
        "AIP levels - Area 1 SFC-UNL",
      ]),
    ).toEqual({ covering: ["T30"], extending: [] });
  });

  test("accepts CRC Covering Sectors and a list", () => {
    expect(parseAtisSectors(["Covering Sectors - T30, T31 T32"])).toEqual({
      covering: ["T30", "T31", "T32"],
      extending: [],
    });
  });

  test("reads Extending as same-position airports", () => {
    expect(parseAtisSectors(["Extending - ZSSS"])).toEqual({
      covering: [],
      extending: ["ZSSS"],
    });
    expect(parseAtisSectors(["Extending - ZSSS, ZSNJ"])).toEqual({
      covering: [],
      extending: ["ZSSS", "ZSNJ"],
    });
  });

  test("accepts an empty Extending line", () => {
    expect(parseAtisSectors(["Extending - "])).toEqual({
      covering: [],
      extending: [],
    });
  });

  test("ignores Covering area and unprefixed extending", () => {
    expect(
      parseAtisSectors([
        "Covering area - Ground movement area",
        "Extending N47 133.55",
      ]),
    ).toEqual({ covering: [], extending: [] });
  });

  test("drops a trailing frequency", () => {
    expect(parseAtisSectors(["Covering Sectors - T30 127.500"])).toEqual({
      covering: ["T30"],
      extending: [],
    });
  });

  test("does not require the covering line to be second", () => {
    expect(
      parseAtisSectors([
        "RJTG_30_CTR 127.500",
        "Tokyo Control / Tokyo Kontororu (JA)",
        "Covering sectors - T30",
      ]),
    ).toEqual({ covering: ["T30"], extending: [] });
  });
});

describe("extendedCallsign", () => {
  test("copies the logged-on facility onto the other airport", () => {
    expect(facilitySuffix("ZSPD_TWR")).toBe("TWR");
    expect(facilitySuffix("ZSPD_N_TWR")).toBe("TWR");
    expect(extendedCallsign("ZSPD_TWR", "ZSSS")).toBe("ZSSS_TWR");
    expect(extendedCallsign("ZSPD_TWR", "ZSSS_APP")).toBe("ZSSS_TWR");
    expect(extendedCallsign("ZSPD_APP", "ZSSS")).toBe("ZSSS_APP");
    expect(extendedCallsign("ZSPD_GND", "ZSSS")).toBe("ZSSS_GND");
    expect(extendedCallsign("ZSPD_DEL", "ZSSS")).toBe("ZSSS_DEL");
    expect(extendedCallsign("ZSHA_CTR", "ZGGG")).toBe("ZGGG_CTR");
    expect(extendedCallsign("ZSPD_DEP", "ZSSS")).toBe("ZSSS_DEP");
  });

  test("FSS does not extend", () => {
    expect(allowsExtending({ facility: 1, callsign: "PRC_FSS" })).toBe(false);
    expect(allowsExtending({ facility: 6, callsign: "ZSHA_FSS" })).toBe(false);
    expect(allowsExtending({ facility: 4, callsign: "ZSPD_TWR" })).toBe(true);
    expect(allowsExtending({ facility: 6, callsign: "ZSHA_CTR" })).toBe(true);
    expect(allowsExtending({ facility: 5, callsign: "ZSPD_APP" })).toBe(true);
  });
});
