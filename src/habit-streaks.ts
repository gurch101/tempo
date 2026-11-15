// Walk each habit backwards only to its first missed scheduled day. Each log
// lookup uses the existing (space_id, log_date, habit_id) primary key.
export async function readHabitStreaks(db: D1Database, spaceId: number, date: string) {
  const result = await db.prepare(`
    WITH RECURSIVE active AS (
      SELECT h.id, h.kind,
        COALESCE((SELECT SUM(1 << weekday) FROM habit_schedule_days
          WHERE space_id = h.space_id AND habit_id = h.id), 127) AS days
      FROM habits h WHERE h.space_id = ?1 AND h.deleted_at IS NULL
    ), walk(id, kind, days, day, streak) AS (
      SELECT id, kind, days, date(?2, '-1 day'), 0 FROM active
      UNION ALL
      SELECT w.id, w.kind, w.days, date(w.day, '-1 day'),
        w.streak + CASE WHEN (w.days & (1 << CAST(strftime('%w', w.day) AS INTEGER))) != 0 THEN 1 ELSE 0 END
      FROM walk w
      LEFT JOIN habit_daily_logs l ON l.space_id = ?1 AND l.log_date = w.day AND l.habit_id = w.id
      WHERE (w.days & (1 << CAST(strftime('%w', w.day) AS INTEGER))) = 0
        OR CASE WHEN w.kind = 'counter' THEN l.value >= l.goal_snapshot ELSE l.done = 1 END
    )
    SELECT id, MAX(streak) AS previous FROM walk GROUP BY id
  `).bind(spaceId, date).all<{ id: number; previous: number }>();
  return { date, previous: Object.fromEntries(result.results.map(row => [String(row.id), row.previous])) };
}
