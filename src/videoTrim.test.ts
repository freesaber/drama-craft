import { describe, expect, it } from "vitest";
import {
  clampTrimRange,
  formatTimecode,
  ratioFromTime,
  timeFromRatio,
  trimUnchanged,
} from "./videoTrim";

describe("videoTrim", () => {
  it("keeps a minimum span when dragging handles together", () => {
    expect(clampTrimRange(1.2, 1.21, 5)).toEqual({ start: 1.2, end: 1.3 });
    expect(clampTrimRange(-2, 99, 5)).toEqual({ start: 0, end: 5 });
    expect(clampTrimRange(4.95, 5, 5).end - clampTrimRange(4.95, 5, 5).start).toBeCloseTo(
      0.1,
    );
  });

  it("converts timeline ratios and formats editor clocks", () => {
    expect(timeFromRatio(0.5, 8)).toBe(4);
    expect(ratioFromTime(2, 8)).toBe(0.25);
    expect(formatTimecode(5)).toBe("0:05.00");
    expect(formatTimecode(75.04)).toBe("1:15.04");
    expect(trimUnchanged(0, 5, 5)).toBe(true);
    expect(trimUnchanged(0.4, 4.2, 5)).toBe(false);
  });
});
