import { describe, expect, it } from "vitest";
import { mergeTrendSeries } from "../public/trend-cache.js";

describe("trend cache deltas", () => {
  it("applies updates and deletions by series and date", () => {
    const current = {
      steps: [{ date: "2026-08-22", value: 8000 }, { date: "2026-08-23", value: 9000 }],
      sleep: [{ date: "2026-08-22", value: 420 }]
    };
    const merged = mergeTrendSeries(current, {
      reset: false,
      changes: { steps: [{ date: "2026-08-23", value: 10452 }], sleep: [{ date: "2026-08-23", value: 438 }] },
      deleted: { steps: ["2026-08-22"] }
    });
    expect(merged.steps).toEqual([{ date: "2026-08-23", value: 10452 }]);
    expect(merged.sleep).toEqual([{ date: "2026-08-22", value: 420 }, { date: "2026-08-23", value: 438 }]);
  });

  it("discards an existing snapshot when reset is requested", () => {
    const merged = mergeTrendSeries({ steps: [{ date: "2026-08-22", value: 8000 }] }, {
      reset: true,
      changes: { steps: [{ date: "2026-08-23", value: 10452 }] },
      deleted: {}
    });
    expect(merged.steps).toEqual([{ date: "2026-08-23", value: 10452 }]);
  });
});
