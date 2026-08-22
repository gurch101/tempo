import { describe, expect, it } from "vitest";
import { mergeSection, reconcileIds, sectionValue } from "../public/state-sections.js";

describe("focused browser persistence", () => {
  const state = {
    timers: [{ id: "timer", name: "Focus" }], widgets: [{ id: "habit", name: "Water" }],
    logs: { "2026-08-21": { "habit:habit": { value: 1 } } }, foods: [], meals: [],
    foodLogs: {}, recentFoodIds: [], recentMealIds: [], nutritionGoal: null, strength: { workouts: [] }
  };

  it("captures only the requested section", () => {
    expect(sectionValue(state, "timers")).toEqual(state.timers);
    expect(sectionValue(state, "foodLogs")).toEqual({ foodLogs: {} });
  });

  it("merges a server section without replacing unrelated state", () => {
    const target = structuredClone(state);
    mergeSection(target, "habits", [{ id: 1, name: "Water" }]);
    expect(target.widgets).toEqual([{ id: 1, name: "Water" }]);
    expect(target.timers).toEqual(state.timers);
  });

  it("reconciles temporary ids inside dependent queued sections", () => {
    const queued = { logs: structuredClone(state.logs) };
    expect(reconcileIds(queued, [{ id: "habit" }], [{ id: 42 }])).toEqual({
      logs: { "2026-08-21": { "habit:42": { value: 1 } } }
    });
  });
});
