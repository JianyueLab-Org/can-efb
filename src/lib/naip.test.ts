import { afterEach, describe, expect, test } from "bun:test";
import { aipScope, dbUrl, hideNaip, setHideNaip } from "./naip";

afterEach(() => setHideNaip(true));

describe("default", () => {
  test("on with no stored value", () => {
    expect(hideNaip.value).toBe(true);
    expect(aipScope()).toBe("public");
    expect(dbUrl("aip/navaids")).toBe("/api/db/aip/navaids?unrestricted=1");
  });
});

describe("dbUrl", () => {
  test("on: appends unrestricted=1 with the right separator", () => {
    expect(dbUrl("aip/navaids")).toBe("/api/db/aip/navaids?unrestricted=1");
    expect(dbUrl("aip/airways?level=high")).toBe(
      "/api/db/aip/airways?level=high&unrestricted=1",
    );
  });

  test("off: path unchanged", () => {
    setHideNaip(false);
    expect(dbUrl("aip/navaids")).toBe("/api/db/aip/navaids");
    expect(dbUrl("aip/airways?level=high")).toBe(
      "/api/db/aip/airways?level=high",
    );
  });
});

describe("state", () => {
  test("setHideNaip survives a storage that throws", () => {
    setHideNaip(false);
    expect(hideNaip.value).toBe(false);
    expect(aipScope()).toBe("full");
    setHideNaip(true);
    expect(aipScope()).toBe("public");
  });
});
