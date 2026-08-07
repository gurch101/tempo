import type { TempoState } from "./types";
import { localDateInfo } from "./time";

type Timer = Record<string, unknown> & {
  duration: number;
  remaining: number;
  running: boolean;
  lastTick: number | null;
  pomodoro?: boolean;
  restDuration?: number;
  phase?: "work" | "rest";
  trackCompletions?: boolean;
  dailyTarget?: number;
  completedToday?: number;
  completionDate?: string | null;
};

function resetDailyCount(timer: Timer, today: string): boolean {
  if (timer.completionDate === today) return false;
  timer.completedToday = 0;
  timer.completionDate = today;
  if (!timer.running && timer.remaining <= 0) {
    timer.phase = "work";
    timer.remaining = Math.max(1, Number(timer.duration) || 1);
    timer.lastTick = null;
  }
  return true;
}

function finishSession(timer: Timer, completedAt: number, today: string, timeZone: string) {
  timer.remaining = 0;
  timer.running = false;
  timer.lastTick = null;
  if (timer.trackCompletions === true && localDateInfo(completedAt, timeZone).date === today)
    timer.completedToday = Math.max(0, Number(timer.completedToday) || 0) + 1;
}

export function reconcileTimer(timer: Timer, now: number, timeZone = "UTC"): boolean {
  const today = localDateInfo(now, timeZone).date;
  const dayChanged = resetDailyCount(timer, today);
  if (!timer.running || !timer.lastTick || now <= timer.lastTick) return dayChanged;

  let elapsed = Math.max(0, Math.floor((now - timer.lastTick) / 1000));
  if (elapsed < 1) return dayChanged;
  let cursor = timer.lastTick;

  while (timer.running && elapsed >= 0) {
    const currentRemaining = Math.max(0, Number(timer.remaining) || 0);
    if (currentRemaining > elapsed) {
      timer.remaining = currentRemaining - elapsed;
      timer.lastTick = cursor + elapsed * 1000;
      break;
    }

    const completedAt = cursor + currentRemaining * 1000;
    elapsed -= currentRemaining;
    if (timer.pomodoro === true && timer.phase !== "rest") {
      timer.phase = "rest";
      timer.remaining = Math.max(1, Number(timer.restDuration) || 300);
      timer.lastTick = completedAt;
      cursor = completedAt;
      if (elapsed < 1) break;
      continue;
    }

    finishSession(timer, completedAt, today, timeZone);
    break;
  }
  return true;
}

export function reconcileTimers(state: TempoState, now: number, timeZone = "UTC"): boolean {
  let changed = false;
  for (const timer of state.timers as Timer[]) changed = reconcileTimer(timer, now, timeZone) || changed;
  return changed;
}
