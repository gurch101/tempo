import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, SELF } from "cloudflare:test";
import { readHabitStreaks } from "../src/habit-streaks";
import { generateAccessKey, sha256 } from "../src/crypto";
import { localDateInfo } from "../src/time";

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function area() {
  const key = generateAccessKey();
  const result = await env.DB.prepare("INSERT INTO spaces(access_key_hash,timezone) VALUES(?,'America/Vancouver')").bind(await sha256(key)).run();
  return { id: Number(result.meta.last_row_id), key };
}

async function habit(spaceId: number, kind = "toggle", days?: number[]) {
  const result = await env.DB.prepare("INSERT INTO habits(space_id,name,kind,goal,color,sort_order) VALUES(?,'Test',?,8,'#123',(SELECT COALESCE(MAX(sort_order),-1)+1 FROM habits WHERE space_id=?))").bind(spaceId, kind, spaceId).run();
  const id = Number(result.meta.last_row_id);
  if (days?.length) await env.DB.batch(days.map(day => env.DB.prepare("INSERT INTO habit_schedule_days(space_id,habit_id,weekday) VALUES(?,?,?)").bind(spaceId, id, day)));
  return id;
}

async function log(spaceId: number, id: number, date: string, done = true, value = 0, goal = 8) {
  await env.DB.prepare(`INSERT INTO habit_daily_logs(space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done)
    VALUES(?,?,?,'Test','#123','toggle',?,?,?)`).bind(spaceId, id, date, goal, value, Number(done)).run();
}

describe("server habit streaks", () => {
  it("returns one count per active habit and stops at missing or incomplete scheduled days", async () => {
    const space = await area();
    const id = await habit(space.id);
    const empty = await habit(space.id);
    await log(space.id, id, "2026-03-06");
    await log(space.id, id, "2026-03-07");
    await log(space.id, id, "2026-03-08");
    await log(space.id, id, "2026-03-09", false);
    expect(await readHabitStreaks(env.DB, space.id, "2026-03-09")).toEqual({ date: "2026-03-09", previous: { [id]: 3, [empty]: 0 } });
    expect((await readHabitStreaks(env.DB, space.id, "2026-03-10")).previous[id]).toBe(0);
    expect((await readHabitStreaks(env.DB, space.id, "2026-03-06")).previous[id]).toBe(0);
    await env.DB.prepare("DELETE FROM habit_daily_logs WHERE space_id=? AND log_date='2026-03-07'").bind(space.id).run();
    expect((await readHabitStreaks(env.DB, space.id, "2026-03-09")).previous[id]).toBe(1);
  });

  it("skips off days and uses counter goal snapshots", async () => {
    const space = await area();
    const weekdays = await habit(space.id, "toggle", [1, 2, 3, 4, 5]);
    const weekly = await habit(space.id, "counter", [1]);
    for (const date of ["2026-08-13", "2026-08-14", "2026-08-17"]) await log(space.id, weekdays, date);
    for (const date of ["2026-08-03", "2026-08-10", "2026-08-17"]) await log(space.id, weekly, date, false, 3, 3);
    expect((await readHabitStreaks(env.DB, space.id, "2026-08-18")).previous).toEqual({ [weekdays]: 3, [weekly]: 3 });
    expect((await readHabitStreaks(env.DB, space.id, "2026-08-17")).previous[weekdays]).toBe(2);
    await env.DB.prepare("UPDATE habit_daily_logs SET value=2,done=1 WHERE space_id=? AND habit_id=? AND log_date='2026-08-17'").bind(space.id, weekly).run();
    expect((await readHabitStreaks(env.DB, space.id, "2026-08-18")).previous[weekly]).toBe(0);
  });

  it("handles multi-year streaks without returning old logs and isolates spaces and deleted habits", async () => {
    const space = await area();
    const other = await area();
    const id = await habit(space.id);
    const deleted = await habit(space.id);
    await habit(other.id);
    await env.DB.prepare("UPDATE habits SET deleted_at=1 WHERE id=?").bind(deleted).run();
    await env.DB.prepare(`WITH RECURSIVE dates(day,n) AS (
      SELECT '2020-01-01',1 UNION ALL SELECT date(day,'+1 day'),n+1 FROM dates WHERE n<1500
    ) INSERT INTO habit_daily_logs(space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done)
      SELECT ?,?,day,'Test','#123','toggle',1,0,1 FROM dates`).bind(space.id, id).run();
    const end = new Date(Date.parse("2020-01-01T00:00:00Z") + 1500 * 86400000).toISOString().slice(0, 10);
    expect(await readHabitStreaks(env.DB, space.id, end)).toEqual({ date: end, previous: { [id]: 1500 } });
    const response = await SELF.fetch(`https://tempo.test/api/habit-streaks?date=${end}`, { headers: { Authorization: `Bearer ${space.key}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { date: end, previous: { [id]: 1500 } }, revision: 0 });
  });

  it("authenticates requests, validates dates, and defaults to the area's calendar", async () => {
    const space = await area();
    const headers = { Authorization: `Bearer ${space.key}` };
    expect((await SELF.fetch("https://tempo.test/api/habit-streaks")).status).toBe(401);
    for (const date of ["bad", "2026-02-30", "9999-01-01"]) {
      expect((await SELF.fetch(`https://tempo.test/api/habit-streaks?date=${date}`, { headers })).status).toBe(422);
    }
    const response = await SELF.fetch("https://tempo.test/api/habit-streaks", { headers });
    expect(await response.json()).toEqual({ data: { date: localDateInfo(Date.now(), "America/Vancouver").date, previous: {} }, revision: 0 });
  });
});
