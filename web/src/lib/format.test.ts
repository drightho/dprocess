import { formatTime } from "./format";

describe("formatTime", () => {
  it("shows UTC date and minutes", () => {
    expect(formatTime("2026-01-02T03:04:05.678Z")).toBe("2026-01-02 03:04 UTC");
    expect(formatTime("2026-12-31T23:59:59Z")).toBe("2026-12-31 23:59 UTC");
  });

  it("converts offsets to UTC", () => {
    expect(formatTime("2026-01-02T03:04:05+02:00")).toBe("2026-01-02 01:04 UTC");
  });

  it("returns text that is not a date unchanged", () => {
    expect(formatTime("")).toBe("");
    expect(formatTime("yesterday")).toBe("yesterday");
  });
});
