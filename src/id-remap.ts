import type { TempoState } from "./types";
import { habitLogKey, parseLogKey } from "./log-keys";

export type EntityKind = "timer" | "habit" | "food" | "meal" | "foodLog" | "workout" | "workoutExercise" | "mesocycle" | "session" | "sessionExercise" | "set";
export type OwnedIds = Record<EntityKind, Set<number>>;

const numericId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function remapForeignStateIds(input: TempoState, owned: OwnedIds): TempoState {
  const state = structuredClone(input);
  const maps = Object.fromEntries(Object.keys(owned).map(kind => [kind, new Map<string, string | number>()])) as Record<EntityKind, Map<string, string | number>>;
  let sequence = 0;
  const register = (kind: EntityKind, entity: Record<string, unknown>) => {
    const old = String(entity.id ?? "");
    const id = numericId(entity.id);
    const replacement = id !== null && !owned[kind].has(id) ? `import:${kind}:${++sequence}` : entity.id as string | number;
    maps[kind].set(old, replacement);
    entity.id = replacement;
  };
  const reference = (kind: EntityKind, value: unknown) => maps[kind].get(String(value)) ?? value;

  for (const timer of state.timers) register("timer", timer);
  for (const habit of state.widgets) register("habit", habit);
  for (const food of state.foods) register("food", food);
  for (const meal of state.meals) register("meal", meal);
  for (const entries of Object.values(state.foodLogs)) for (const entry of entries) register("foodLog", entry);
  for (const workout of state.strength.workouts) {
    register("workout", workout);
    for (const exercise of Array.isArray(workout.exercises) ? workout.exercises as Record<string, unknown>[] : []) register("workoutExercise", exercise);
  }
  for (const mesocycle of state.strength.mesocycles) {
    register("mesocycle", mesocycle);
    for (const session of Array.isArray(mesocycle.sessions) ? mesocycle.sessions as Record<string, unknown>[] : []) {
      register("session", session);
      for (const exercise of Array.isArray(session.exercises) ? session.exercises as Record<string, unknown>[] : []) {
        register("sessionExercise", exercise);
        for (const set of Array.isArray(exercise.sets) ? exercise.sets as Record<string, unknown>[] : []) register("set", set);
      }
    }
  }

  for (const meal of state.meals) for (const item of Array.isArray(meal.items) ? meal.items as Record<string, unknown>[] : []) item.foodId = reference("food", item.foodId);
  for (const entries of Object.values(state.foodLogs)) for (const entry of entries) {
    entry.foodId = reference("food", entry.foodId);
    entry.mealId = reference("meal", entry.mealId);
  }
  for (const mesocycle of state.strength.mesocycles) {
    mesocycle.workoutIds = (Array.isArray(mesocycle.workoutIds) ? mesocycle.workoutIds : []).map(id => reference("workout", id));
    for (const session of Array.isArray(mesocycle.sessions) ? mesocycle.sessions as Record<string, unknown>[] : []) {
      session.templateId = reference("workout", session.templateId);
      for (const exercise of Array.isArray(session.exercises) ? session.exercises as Record<string, unknown>[] : []) exercise.exerciseId = reference("workoutExercise", exercise.exerciseId);
    }
  }
  state.strength.activeMesocycleId = String(reference("mesocycle", state.strength.activeMesocycleId) ?? "");

  for (const [date, records] of Object.entries(state.logs)) {
    const remapped: Record<string, Record<string, unknown>> = {};
    for (const [key, record] of Object.entries(records)) {
      const parsed = parseLogKey(key);
      const kind = parsed?.kind ?? (("value" in record || "done" in record || "type" in record) ? "habit" : null);
      if (!kind) continue;
      const sourceId = parsed?.id ?? key;
      const id = reference(kind, sourceId);
      remapped[habitLogKey(id)] = record;
    }
    state.logs[date] = remapped;
  }
  return state;
}
