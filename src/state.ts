import type { TempoState } from "./types";

export const STATE_SCHEMA_VERSION = 14;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export function emptyState(now = new Date()): TempoState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    timers: [], widgets: [], logs: {}, foods: [], meals: [], foodLogs: {},
    nutritionGoal: null, recentFoodIds: [], recentMealIds: [],
    strength: { unit: "lb", workouts: [], mesocycles: [], activeMesocycleId: "" },
    legacyDefaultsRemoved: true
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateState(value: unknown): { state?: TempoState; errors?: Record<string, string> } {
  if (!isObject(value)) return { errors: { state: "State must be a JSON object." } };
  const errors: Record<string, string> = {};
  for (const key of ["timers", "widgets", "foods", "meals"])
    if (!Array.isArray(value[key])) errors[key] = `${key} must be an array.`;
  for (const key of ["logs", "foodLogs", "strength"])
    if (!isObject(value[key])) errors[key] = `${key} must be an object.`;
  if (Object.keys(errors).length) return { errors };
  const state = value as unknown as TempoState;
  state.schemaVersion = STATE_SCHEMA_VERSION;
  for (const timer of state.timers) {
    if (!isObject(timer)) continue;
    delete timer.days;
    delete timer.dailyGoal;
    delete timer.recurring;
    timer.trackCompletions = timer.trackCompletions === true;
    timer.dailyTarget = Math.max(1, Math.round(Number(timer.dailyTarget) || 1));
    timer.completedToday = Math.max(0, Math.round(Number(timer.completedToday) || 0));
    timer.completionDate = typeof timer.completionDate === "string" ? timer.completionDate : null;
    timer.pomodoro = timer.pomodoro === true;
    timer.restDuration = Math.max(1, Math.round(Number(timer.restDuration) || 300));
    timer.phase = timer.pomodoro === true && timer.phase === "rest" ? "rest" : "work";
    timer.countdownBeeps = timer.countdownBeeps === true;
  }
  for (const [date, records] of Object.entries(state.logs)) {
    state.logs[date] = Object.fromEntries(Object.entries(records).filter(([key, record]) => key.startsWith("habit:") || "value" in record || "done" in record || "type" in record));
    if (!Object.keys(state.logs[date]).length) delete state.logs[date];
  }
  state.strength.unit = "lb";
  for (const mesocycle of state.strength.mesocycles) {
    if (!isObject(mesocycle) || !Array.isArray(mesocycle.sessions)) continue;
    for (const session of mesocycle.sessions) {
      if (!isObject(session)) continue;
      session.unit = "lb";
      if (!Array.isArray(session.exercises)) continue;
      for (const exercise of session.exercises) {
        if (!isObject(exercise)) continue;
        exercise.mode = exercise.mode === "bodyweight" ? "bodyweight" : "external";
        exercise.bodyweightFactor = Math.max(0, Number(exercise.bodyweightFactor) || 1);
      }
    }
  }
  state.recentFoodIds = Array.isArray(state.recentFoodIds) ? state.recentFoodIds.map(String).slice(0, 6) : [];
  state.recentMealIds = Array.isArray(state.recentMealIds) ? state.recentMealIds.map(String).slice(0, 6) : [];
  state.legacyDefaultsRemoved = true;
  return { state };
}

export function isStateEmpty(state: TempoState): boolean {
  return !state.timers.length && !state.widgets.length && !state.foods.length && !state.meals.length &&
    !Object.keys(state.logs).length && !Object.keys(state.foodLogs).length &&
    !state.strength.workouts.length && !state.strength.mesocycles.length;
}

export function importSummary(state: TempoState) {
  const mesocycles = state.strength.mesocycles as Array<{ sessions?: unknown[] }>;
  return {
    timers: state.timers.length, habits: state.widgets.length, foods: state.foods.length,
    meals: state.meals.length,
    logs: Object.values(state.logs).reduce((n, day) => n + Object.keys(day).length, 0),
    workouts: state.strength.workouts.length, mesocycles: mesocycles.length,
    sessions: mesocycles.reduce((n, item) => n + (Array.isArray(item.sessions) ? item.sessions.length : 0), 0)
  };
}
