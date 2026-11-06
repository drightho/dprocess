import { MAX_STORY_LOC, overLimit, parseEstimate } from "./forms";

describe("parseEstimate", () => {
  it("treats an empty field as no estimate", () => {
    expect(parseEstimate("")).toEqual({ ok: true, value: null });
    expect(parseEstimate("   ")).toEqual({ ok: true, value: null });
  });

  it("reads whole numbers", () => {
    expect(parseEstimate("0")).toEqual({ ok: true, value: 0 });
    expect(parseEstimate(" 120 ")).toEqual({ ok: true, value: 120 });
    expect(parseEstimate("007")).toEqual({ ok: true, value: 7 });
  });

  it("leaves negative numbers to the server", () => {
    expect(parseEstimate("-5")).toEqual({ ok: true, value: -5 });
  });

  it("rejects anything that is not a whole number", () => {
    for (const bad of ["12.5", "1e3", "abc", "12 lines", "+5", "1,000", "--1"]) {
      const r = parseEstimate(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("whole number");
    }
  });

  it("rejects numbers too large to be exact", () => {
    const r = parseEstimate("99999999999999999999");
    expect(r.ok).toBe(false);
  });
});

describe("overLimit", () => {
  it("is true only above the limit", () => {
    expect(MAX_STORY_LOC).toBe(400);
    expect(overLimit("399")).toBe(false);
    expect(overLimit("400")).toBe(false);
    expect(overLimit("401")).toBe(true);
    expect(overLimit("5000")).toBe(true);
  });

  it("is false for an empty or invalid estimate", () => {
    expect(overLimit("")).toBe(false);
    expect(overLimit("abc")).toBe(false);
    expect(overLimit("450.5")).toBe(false);
  });
});
