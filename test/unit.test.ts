import { describe, expect, it } from "vitest";
import { generateAccessKey, sha256 } from "../src/crypto";
import { deduplicateTreadmillSessions, isTreadmillExercise, parseDailyStepsRollupPoint, parseDailyZone2RollupPoint, parseExercisePoint, parseGoogleDuration, parseHeartRatePoint, parseRestingHeartRatePoint } from "../src/google-health";
import { decryptSecret, encryptSecret } from "../src/secrets";
import { emptyState, importSummary, isStateEmpty, validateState } from "../src/state";
import { localDateInfo, nextLocalDateBoundary, validTimeZone } from "../src/time";
import { reconcileTimers } from "../src/timers";
import { liveStepsPace } from "../public/cardio-metrics.js";

describe("capability credentials", () => {
  it("creates unguessable base64url keys and stable hashes", async () => {
    const first = generateAccessKey(); const second = generateAccessKey();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(await sha256("tempo")).toBe("8d6546721a1d106cf8d27f7326ebae7e83c1592aeb7479b8f7ec9d8d700d464f");
  });
});

describe("Google Health conversion and token protection", () => {
  it("encrypts refresh tokens with the deployment key and context-bound AES-GCM", async () => {
    const tokenKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted = await encryptSecret("refresh-token", tokenKey, "google-health-refresh:7");
    expect(encrypted.ciphertext).not.toContain("refresh-token");
    expect(await decryptSecret(encrypted, tokenKey, "google-health-refresh:7")).toBe("refresh-token");
    await expect(decryptSecret(encrypted, tokenKey, "google-health-refresh:8")).rejects.toThrow();
  });

  it("parses only treadmill workouts and heart measurements", () => {
    expect(parseGoogleDuration("123.5s")).toBe(123.5);
    expect(isTreadmillExercise("TREADMILL")).toBe(true);
    expect(isTreadmillExercise("RUNNING")).toBe(false);
    expect(parseRestingHeartRatePoint({ dailyRestingHeartRate: { date: { year: 2026, month: 8, day: 8 }, beatsPerMinute: 54, dailyRestingHeartRateMetadata: { calculationMethod: "SLEEP" } } })).toEqual({ date: "2026-08-08", beatsPerMinute: 54, calculationMethod: "SLEEP" });
    expect(parseDailyStepsRollupPoint({ civilStartTime: { date: { year: 2026, month: 8, day: 8 } }, steps: { countSum: "9123" } })).toEqual({ date: "2026-08-08", count: 9123 });
    expect(parseDailyZone2RollupPoint({ civilStartTime: { date: { year: 2026, month: 8, day: 8 } }, timeInHeartRateZone: { timeInHeartRateZones: [{ heartRateZone: "LIGHT", duration: "600s" }, { heartRateZone: "MODERATE", duration: "1234.5s" }] } })).toEqual({ date: "2026-08-08", moderateSeconds: 1234.5 });
    expect(parseHeartRatePoint({ heartRate: { sampleTime: { physicalTime: "2026-08-08T17:01:00Z" }, beatsPerMinute: 141, metadata: { motionContext: "ACTIVE", sensorLocation: "WRIST" } } })).toEqual({ at: Date.parse("2026-08-08T17:01:00Z"), bpm: 141, motionContext: "ACTIVE", sensorLocation: "WRIST" });
    expect(parseExercisePoint({ name: "walk", exercise: { exerciseType: "WALKING", interval: { startTime: "2026-08-08T17:00:00Z", endTime: "2026-08-08T17:30:00Z" } } })).toBeNull();
    expect(parseExercisePoint({ name: "treadmill-1", exercise: { exerciseType: "TREADMILL", displayName: "Incline treadmill", interval: { startTime: "2026-08-08T17:00:00Z", endTime: "2026-08-08T17:30:00Z" }, activeDuration: "1500s", updateTime: "2026-08-08T18:00:00Z", metricsSummary: { averageHeartRateBeatsPerMinute: 136, distanceMillimeters: 3200000, steps: 4100 } } })).toMatchObject({ googleName: "treadmill-1", displayName: "Incline treadmill", activeDurationSeconds: 1500, averageHeartRate: 136, distanceMeters: 3200, steps: 4100 });
  });

  it("keeps only the longer treadmill session when local-day starts are within five minutes", () => {
    const session = (name: string, startTime: string, duration: number, utcOffset = "-25200s") => parseExercisePoint({
      name,
      exercise: {
        exerciseType: "TREADMILL",
        interval: { startTime, startUtcOffset: utcOffset, endTime: new Date(Date.parse(startTime) + duration * 1000).toISOString() },
        activeDuration: `${duration}s`
      }
    })!;
    const shorter = session("shorter", "2026-08-13T00:48:12Z", 2704);
    const longer = session("longer", "2026-08-13T00:47:00Z", 2760);
    const separate = session("separate", "2026-08-13T01:00:00Z", 1800);
    const nextLocalDay = session("next-local-day", "2026-08-13T07:02:00Z", 1200);

    expect(deduplicateTreadmillSessions([shorter, longer, separate, nextLocalDay]).map(item => item.googleName))
      .toEqual(["longer", "separate", "next-local-day"]);
  });
});

describe("live steps pace", () => {
  it("uses today's latest non-nap wake time and remaining steps", () => {
    const wake = Date.parse("2026-08-19T14:00:00Z");
    const pace = liveStepsPace({
      goal: 10000,
      todaySteps: 4000,
      walkingMinutes: 600,
      today: "2026-08-19",
      now: wake + 4 * 3600000,
      sessions: [
        { date: "2026-08-19", endTime: wake, nap: false },
        { date: "2026-08-19", endTime: wake + 2 * 3600000, nap: true },
        { date: "2026-08-18", endTime: wake + 3 * 3600000, nap: false }
      ]
    });
    expect(pace).toMatchObject({ wakeTime: wake, remainingSteps: 6000, remainingMinutes: 360, hourlySteps: 1000 });
  });

  it("returns zero after the goal and no achievable pace after the window", () => {
    const wake = Date.parse("2026-08-19T14:00:00Z"), sessions = [{ date: "2026-08-19", endTime: wake, nap: false }];
    expect(liveStepsPace({ goal: 10000, todaySteps: 11000, walkingMinutes: 60, today: "2026-08-19", now: wake + 2 * 3600000, sessions })?.hourlySteps).toBe(0);
    expect(liveStepsPace({ goal: 10000, todaySteps: 5000, walkingMinutes: 60, today: "2026-08-19", now: wake + 2 * 3600000, sessions })?.hourlySteps).toBeNull();
  });
});

describe("timezone boundaries", () => {
  it("uses the space timezone and handles spring DST", () => {
    expect(validTimeZone("America/Vancouver")).toBe(true);
    expect(validTimeZone("Mars/Olympus_Mons")).toBe(false);
    const before = Date.parse("2026-03-08T07:59:00Z");
    expect(localDateInfo(before, "America/Vancouver").date).toBe("2026-03-07");
    const boundary = nextLocalDateBoundary(before, "America/Vancouver");
    expect(new Date(boundary).toISOString()).toBe("2026-03-08T08:00:00.000Z");
  });
});

describe("timer reconciliation", () => {
  it("updates a running countdown without creating history", () => {
    const state = emptyState(new Date("2026-01-01T00:00:00Z"));
    state.timers.push({ id: "timer-1", name: "Focus", color: "#000", duration: 600, remaining: 600, running: true, lastTick: Date.parse("2026-01-02T07:58:00Z") });
    reconcileTimers(state, Date.parse("2026-01-02T08:02:00Z"), "America/Vancouver");
    expect(state.timers[0].remaining).toBe(360);
    expect(state.logs).toEqual({});
  });

  it("continues across day boundaries and stops at zero", () => {
    const state = emptyState();
    state.timers.push({ id: "timer-1", name: "Focus", color: "#000", duration: 60, remaining: 60, running: true, lastTick: Date.parse("2026-01-03T23:59:30Z") });
    reconcileTimers(state, Date.parse("2026-01-04T00:01:00Z"), "UTC");
    expect(state.timers[0].running).toBe(false);
    expect(state.timers[0].remaining).toBe(0);
  });

  it("stops recurring timers and counts completions for the current day only", () => {
    const state = emptyState();
    state.timers.push({ id: "timer-1", name: "Intervals", color: "#000", duration: 60, remaining: 20, running: true, trackCompletions: true, dailyTarget: 4, completedToday: 1, completionDate: "2026-01-04", lastTick: Date.parse("2026-01-04T00:01:00Z") });
    reconcileTimers(state, Date.parse("2026-01-04T00:01:30Z"), "UTC");
    expect(state.timers[0]).toMatchObject({ running: false, remaining: 0, dailyTarget: 4, completedToday: 2, completionDate: "2026-01-04" });
    expect(state.logs).toEqual({});
  });

  it("resets completion counts on the next local day", () => {
    const state = emptyState();
    state.timers.push({ id: "timer-1", name: "Intervals", color: "#000", duration: 60, remaining: 60, running: false, trackCompletions: true, dailyTarget: 4, completedToday: 3, completionDate: "2026-01-03", lastTick: null });
    expect(reconcileTimers(state, Date.parse("2026-01-04T12:00:00Z"), "UTC")).toBe(true);
    expect(state.timers[0]).toMatchObject({ completedToday: 0, completionDate: "2026-01-04" });
  });

  it("moves a Pomodoro timer from work into rest without completing the session", () => {
    const state = emptyState();
    state.timers.push({ id: "timer-1", name: "Pomodoro", color: "#000", duration: 25 * 60, restDuration: 5 * 60, remaining: 10, pomodoro: true, phase: "work", running: true, trackCompletions: true, completedToday: 0, completionDate: "2026-01-04", lastTick: Date.parse("2026-01-04T12:00:00Z") });
    reconcileTimers(state, Date.parse("2026-01-04T12:00:15Z"), "UTC");
    expect(state.timers[0]).toMatchObject({ running: true, phase: "rest", remaining: 295, completedToday: 0, lastTick: Date.parse("2026-01-04T12:00:15Z") });
  });

  it("stops and counts a Pomodoro only after its rest portion", () => {
    const state = emptyState();
    state.timers.push({ id: "timer-1", name: "Pomodoro", color: "#000", duration: 60, restDuration: 30, remaining: 10, pomodoro: true, phase: "work", running: true, trackCompletions: true, dailyTarget: 2, completedToday: 0, completionDate: "2026-01-04", lastTick: Date.parse("2026-01-04T12:00:00Z") });
    reconcileTimers(state, Date.parse("2026-01-04T12:00:45Z"), "UTC");
    expect(state.timers[0]).toMatchObject({ running: false, phase: "rest", remaining: 0, completedToday: 1 });
    expect(state.logs).toEqual({});
  });

  it("reconciles a timer after a long mobile background suspension", () => {
    const state = emptyState();
    state.timers.push({ id: "timer-1", name: "Pomodoro", color: "#000", duration: 25 * 60, restDuration: 5 * 60, remaining: 20 * 60, pomodoro: true, phase: "work", running: true, trackCompletions: true, completedToday: 0, completionDate: "2026-01-04", lastTick: Date.parse("2026-01-04T12:00:00Z") });
    reconcileTimers(state, Date.parse("2026-01-04T12:26:00Z"), "UTC");
    expect(state.timers[0]).toMatchObject({ running: false, phase: "rest", remaining: 0, completedToday: 1, lastTick: null });
  });
});

describe("v14 state contract", () => {
  it("validates and summarizes a complete state", () => {
    const state = emptyState();
    expect(isStateEmpty(state)).toBe(true);
    state.timers.push({ id: "one" });
    expect(validateState(state).state?.schemaVersion).toBe(14);
    expect(importSummary(state).timers).toBe(1);
    expect(validateState({ timers: [] }).errors?.logs).toBeTruthy();
  });
});
