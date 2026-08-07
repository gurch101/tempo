export function liveStepsPace({ goal, todaySteps, walkingMinutes, sessions, today, now = Date.now() }) {
  const target = Math.max(0, Number(goal) || 0);
  const completed = Math.max(0, Number(todaySteps) || 0);
  const windowMinutes = Math.max(0, Number(walkingMinutes) || 0);
  const wakeTime = (Array.isArray(sessions) ? sessions : [])
    .filter(session => !session.nap && session.date === today && Number.isFinite(Number(session.endTime)) && Number(session.endTime) <= now)
    .reduce((latest, session) => Math.max(latest, Number(session.endTime)), 0);
  if (!target || !windowMinutes || !wakeTime) return null;
  const remainingSteps = Math.max(0, target - completed);
  const elapsedMinutes = Math.max(0, (now - wakeTime) / 60000);
  const remainingMinutes = Math.max(0, windowMinutes - elapsedMinutes);
  return {
    wakeTime,
    remainingSteps,
    remainingMinutes,
    hourlySteps: remainingSteps === 0 ? 0 : remainingMinutes > 0 ? Math.ceil(remainingSteps / (remainingMinutes / 60)) : null
  };
}
