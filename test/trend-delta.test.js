import { describe, expect, it } from "vitest";
import { deltaPoints, periodDelta } from "../public/trend-delta.js";

describe("trend period deltas", () => {
  it("calculates absolute and percentage change from the visible endpoints", () => {
    expect(periodDelta([{ value: 80 }, { value: 100 }])).toEqual({ change: 20, percent: 25 });
  });

  it("supports chart-specific value accessors", () => {
    expect(periodDelta([{ count: 12_000 }, { count: 9_000 }], point => point.count)).toEqual({ change: -3_000, percent: -25 });
  });

  it("does not report an invalid percentage for a zero baseline", () => {
    expect(periodDelta([{ value: 0 }, { value: 50 }])).toEqual({ change: 50, percent: null });
  });

  it("returns no delta without valid endpoints", () => {
    expect(periodDelta([])).toBeNull();
    expect(periodDelta([{ value: "missing" }])).toBeNull();
  });

  it("excludes a specified date without changing the chart points", () => {
    const points = [{ date: "2026-08-24" }, { date: "2026-08-25" }, { date: "2026-08-26" }];
    expect(deltaPoints(points, { excludeDate: "2026-08-26" })).toEqual(points.slice(0, 2));
    expect(points).toHaveLength(3);
  });

  it("excludes the latest point for incomplete volume periods", () => {
    const points = [{ date: "2026-08-10" }, { date: "2026-08-17" }, { date: "2026-08-24" }];
    expect(deltaPoints(points, { excludeLatest: true })).toEqual(points.slice(0, 2));
  });
});
