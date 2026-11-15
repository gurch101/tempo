import { describe, expect, it } from "vitest";
import { habitStreak } from "../public/habit-streak.js";

const toggle = { type: "toggle" };
const date = "2026-11-14";

describe("habit card streaks", () => {
  it("combines the server baseline with the selected day's completion", () => {
    expect(habitStreak(toggle, { done: true }, 30, date, date, true)).toBe(31);
    expect(habitStreak(toggle, { done: false }, 30, date, date, true)).toBe(30);
  });

  it("resets for a missed historical day, but preserves off days", () => {
    expect(habitStreak(toggle, {}, 30, date, "2026-11-15", true)).toBe(0);
    expect(habitStreak(toggle, {}, 30, date, "2026-11-15", false)).toBe(30);
    expect(habitStreak(toggle, { done: true }, 30, date, date, false)).toBe(30);
  });

  it("updates counters immediately when crossing their recorded goal in either direction", () => {
    const counter = { type: "counter", goal: 8 };
    expect(habitStreak(counter, { value: 3, goal: 3 }, 10, date, date, true)).toBe(11);
    expect(habitStreak(counter, { value: 2, goal: 3 }, 10, date, date, true)).toBe(10);
    expect(habitStreak(counter, { value: 8 }, 10, date, date, true)).toBe(11);
  });
});
