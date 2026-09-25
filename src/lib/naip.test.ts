import { afterEach, describe, expect, test } from "bun:test";
import { aipScope, dbUrl, hideNaip, setHideNaip } from "./naip";

afterEach(() => setHideNaip(false));

describe("dbUrl", () => {
  test("off: path unchanged", () => {
    expect(dbUrl("aip/navaids")).toBe("/api/db/aip/navaids");
    expect(dbUrl("aip/airways?level=high")).toBe(
      "/api/db/aip/airways?level=high",
    );
  });

  test("on: appends unrestricted=1 with the right separator", () => {
    setHideNaip(true);
    expect(dbUrl("aip/navaids")).toBe("/api/db/aip/navaids?unrestricted=1");
    expect(dbUrl("aip/airways?level=high")).toBe(
      "/api/db/aip/airways?level=high&unrestricted=1",
    );
  });
});

describe("state", () => {
  test("setHideNaip survives a storage that throws", () => {
    setHideNaip(true);
    expect(hideNaip.value).toBe(true);
    expect(aipScope()).toBe("public");
    setHideNaip(false);
    expect(aipScope()).toBe("full");
  });
});
