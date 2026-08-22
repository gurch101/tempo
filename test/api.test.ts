import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, SELF } from "cloudflare:test";
import { importGoogleHealthData, importGoogleSleepData } from "../src/google-health";
import { readSleep } from "../src/sleep";
import { readFinances, refreshFinances } from "../src/finances";
import { sha256 } from "../src/crypto";

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

async function createArea() {
  const response = await SELF.fetch("https://tempo.test/api/spaces", {
    method: "POST", headers: { "content-type": "application/json", Origin: "https://tempo.test", "CF-Connecting-IP": crypto.randomUUID() },
    body: JSON.stringify({ timezone: "America/Vancouver" })
  });
  const payload = await response.json() as { data: { path: string }; revision: number };
  return { response, path: payload.data.path, key: payload.data.path.split("/").at(-1)! };
}

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
const getState = async (key: string) => (await (await SELF.fetch("https://tempo.test/api/state", { headers: auth(key) })).json() as { data: any; revision: number });

describe("private areas", () => {
  it("installs each private area with its own launch URL", async () => {
    const area = await createArea();
    try {
      const manifestResponse = await SELF.fetch(`https://tempo.test${area.path}/manifest.webmanifest`);
      expect(manifestResponse.status).toBe(200);
      expect(manifestResponse.headers.get("content-type")).toContain("application/manifest+json");
      expect(manifestResponse.headers.get("cache-control")).toContain("no-store");
      expect(await manifestResponse.json()).toMatchObject({
        id: area.path,
        start_url: area.path,
        scope: "/",
        display: "standalone",
        description: "Plan focused time and manage habits, health, nutrition, training, and finances in one private daily dashboard."
      });

      const privatePage = await SELF.fetch(`https://tempo.test${area.path}`);
      expect(privatePage.status).toBe(200);
      const privateHtml = await privatePage.text();
      expect(privateHtml).toContain(`href="${area.path}/manifest.webmanifest"`);
      expect(privateHtml).not.toContain('href="/manifest.webmanifest"');
      expect(privateHtml).toContain(`href="${area.path}/nutrition"`);
      expect(privateHtml).toContain(`href="${area.path}/settings"`);
      expect(privateHtml).not.toContain('href="#nutrition"');
      const nutritionPage = await SELF.fetch(`https://tempo.test${area.path}/nutrition`);
      expect(nutritionPage.status).toBe(200);
      expect(await nutritionPage.text()).toContain('id="foodLogView"');
      const cardioSessionPage = await SELF.fetch(`https://tempo.test${area.path}/cardio/session/123`);
      expect(cardioSessionPage.status).toBe(200);
      expect(await cardioSessionPage.text()).toContain('id="cardioSessionView"');

      const invalidKey = `${area.key.slice(0, -1)}${area.key.endsWith("x") ? "y" : "x"}`;
      expect((await SELF.fetch(`https://tempo.test/p/${invalidKey}/manifest.webmanifest`)).status).toBe(404);
    } finally {
      await env.DB.prepare("DELETE FROM spaces WHERE access_key_hash = ?").bind(await sha256(area.key)).run();
    }
  });

  it("uses entity and composite primary keys and has no state JSON column", async () => {
    const schema = await env.DB.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").all<{ name: string; sql: string }>();
    expect(schema.results.length).toBeGreaterThan(15);
    const entityTables = ["spaces","timers","habits","foods","meals","food_log_entries","workouts","workout_exercises","mesocycles","workout_sessions","session_exercises","exercise_sets","cardio_sessions","sleep_sessions","finance_holdings","finance_allocation_categories","finance_quotes","finance_daily_prices","finance_fx_quotes","finance_daily_fx_rates"];
    for (const name of entityTables) expect(schema.results.find(table => table.name === name)!.sql, name).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
    const compositeTables = ["habit_schedule_days","habit_daily_logs","meal_items","mesocycle_workouts","mesocycle_weeks","session_exercise_allocations","cardio_resting_heart_rates","cardio_daily_steps","cardio_hourly_steps","cardio_daily_zone2","cardio_heart_rate_chunks","cardio_session_exclusions","sleep_stages","space_walkthrough_pages"];
    for (const name of compositeTables) expect(schema.results.find(table => table.name === name)!.sql, name).toContain("PRIMARY KEY (");
    expect(schema.results.some(table => table.name === "timer_schedule_days")).toBe(false);
    expect(schema.results.some(table => table.name === "timer_daily_logs")).toBe(false);
    expect(schema.results.find(table => table.name === "timers")!.sql).not.toContain("daily_goal_seconds");
    for (const column of ["pomodoro", "rest_duration_seconds", "phase", "countdown_beeps", "track_completions", "daily_target", "completed_today", "completion_date"]) expect(schema.results.find(table => table.name === "timers")!.sql).toContain(column);
    const spaces = schema.results.find(table => table.name === "spaces")!;
    expect(spaces.sql).not.toContain("state_json");
    expect(schema.results.some(table => table.name === "space_imports")).toBe(false);
    expect(schema.results.some(table => table.name === "nutrition_goals")).toBe(false);
    for (const table of schema.results) expect(table.sql, table.name).not.toContain("public_id");
    expect(spaces.sql).not.toContain("legacy_import_status");
    expect(spaces.sql).not.toContain("timer_state_day");
    expect(spaces.sql).not.toContain("nutrition_goal_updated_at");
    expect(spaces.sql).not.toContain("walkthrough_finished_at");
    expect(spaces.sql).not.toContain("created_at");
    expect(spaces.sql).toContain("nutrition_calories REAL");
    expect(spaces.sql).toContain("finance_display_currency TEXT");
    expect(spaces.sql).toContain("walkthrough_status TEXT");
    expect(schema.results.some(table => table.name === "finance_preferences")).toBe(false);
    expect(schema.results.find(table => table.name === "finance_holdings")!.sql).not.toContain("asset_key");
    for (const name of ["finance_quotes", "finance_daily_prices", "finance_fx_quotes", "finance_daily_fx_rates"]) {
      const sql=schema.results.find(table => table.name === name)!.sql;
      expect(sql,name).not.toContain("space_id");
      expect(sql,name).toContain("id INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(sql,name).toContain("UNIQUE (");
    }
    expect(schema.results.find(table => table.name === "cardio_heart_rate_chunks")!.sql).not.toContain("sample_count");
    expect(schema.results.find(table => table.name === "sleep_sessions")!.sql).not.toContain("minutes_awake");
    expect(schema.results.find(table => table.name === "food_log_entries")!.sql).not.toContain("batch_id");
    const foodLogForeignKeys = await env.DB.prepare("PRAGMA foreign_key_list(food_log_entries)").all<{ id: number; seq: number; table: string; from: string; to: string }>();
    const foodRelationship = foodLogForeignKeys.results.filter(key => key.table === "foods").sort((a,b) => a.seq-b.seq);
    const mealRelationship = foodLogForeignKeys.results.filter(key => key.table === "meals").sort((a,b) => a.seq-b.seq);
    expect(foodRelationship.map(key => [key.from,key.to])).toEqual([["space_id","space_id"],["food_id","id"]]);
    expect(mealRelationship.map(key => [key.from,key.to])).toEqual([["space_id","space_id"],["meal_id","id"]]);
    const foodLogIndexes = await env.DB.prepare("PRAGMA index_list(food_log_entries)").all<{name:string}>();
    expect(foodLogIndexes.results.map(index=>index.name)).toEqual(expect.arrayContaining(["idx_food_logs_recent_food","idx_food_logs_recent_meal"]));
    const recentFoodPlan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT food_id FROM food_log_entries WHERE space_id=? AND meal_id IS NULL AND food_id IS NOT NULL GROUP BY food_id ORDER BY MAX(logged_at) DESC LIMIT 6").bind(1).all<{detail:string}>();
    const recentMealPlan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT meal_id FROM food_log_entries WHERE space_id=? AND meal_id IS NOT NULL GROUP BY meal_id ORDER BY MAX(logged_at) DESC LIMIT 6").bind(1).all<{detail:string}>();
    expect(recentFoodPlan.results.map(row=>row.detail).join(" ")).toContain("idx_food_logs_recent_food");
    expect(recentMealPlan.results.map(row=>row.detail).join(" ")).toContain("idx_food_logs_recent_meal");
    expect(schema.results.some(table => table.name === "muscle_groups")).toBe(false);
    expect(schema.results.find(table => table.name === "session_exercise_allocations")!.sql).not.toContain("muscle_id");
    expect(schema.results.find(table => table.name === "mesocycles")!.sql).not.toContain("archived");
    for (const name of ["timers", "habits"]) expect(schema.results.find(table => table.name === name)!.sql).not.toContain("created_at");
  });

  it("isolates state by capability and stores only the key hash", async () => {
    const first = await createArea(); const second = await createArea();
    expect(first.response.status).toBe(201);
    expect(first.path).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
    const firstBootstrap = await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(first.key) });
    expect(firstBootstrap.status).toBe(200);
    const denied = await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(`${first.key.slice(0, -1)}x`) });
    expect(denied.status).toBe(401);
    const rows = await env.DB.prepare("SELECT access_key_hash FROM spaces").all<{ access_key_hash: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.some(row => row.access_key_hash === first.key || row.access_key_hash === second.key)).toBe(false);
  });

  it("tracks walkthrough completion independently for each new space", async () => {
    const first = await createArea(); const second = await createArea();
    const firstBootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(first.key) })).json() as { data: { walkthrough: { status: string; pages: Record<string, string> } }; revision: number };
    expect(firstBootstrap.data.walkthrough.status).toBe("pending");
    expect(firstBootstrap.data.walkthrough.pages).toEqual({});

    const invalid = await SELF.fetch("https://tempo.test/api/walkthrough", {
      method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ status: "pending" })
    });
    expect(invalid.status).toBe(422);

    const completed = await SELF.fetch("https://tempo.test/api/walkthrough", {
      method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ status: "completed" })
    });
    expect(completed.status).toBe(200);
    const completedPayload = await completed.json() as { data: { status: string }; revision: number };
    expect(completedPayload).toMatchObject({ data: { status: "completed" }, revision: firstBootstrap.revision });

    const [firstReload, secondReload] = await Promise.all([
      SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(first.key) }),
      SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(second.key) })
    ]);
    expect(((await firstReload.json()) as any).data.walkthrough.status).toBe("completed");
    expect(((await secondReload.json()) as any).data.walkthrough.status).toBe("pending");
    expect(await env.DB.prepare("SELECT walkthrough_status FROM spaces WHERE access_key_hash=?").bind(await sha256(first.key)).first()).toMatchObject({ walkthrough_status: "completed" });

    const dismissed = await SELF.fetch("https://tempo.test/api/walkthrough", {
      method: "PUT", headers: { ...auth(second.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ status: "dismissed" })
    });
    expect(dismissed.status).toBe(200);
    expect(((await dismissed.json()) as any).data.status).toBe("dismissed");
    expect((await SELF.fetch("https://tempo.test/api/walkthrough", { method: "PUT", headers: { "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ status: "completed" }) })).status).toBe(401);

    const nutrition = await SELF.fetch("https://tempo.test/api/walkthrough/pages/nutrition", {
      method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ status: "completed" })
    });
    expect(nutrition.status).toBe(200);
    expect(await nutrition.json()).toMatchObject({ data: { page: "nutrition", status: "completed" }, revision: firstBootstrap.revision });
    const invalidPage = await SELF.fetch("https://tempo.test/api/walkthrough/pages/home", {
      method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ status: "completed" })
    });
    expect(invalidPage.status).toBe(404);
    const pageBootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(first.key) })).json() as any;
    expect(pageBootstrap.data.walkthrough.pages).toEqual({ nutrition: "completed" });
    const otherBootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(second.key) })).json() as any;
    expect(otherBootstrap.data.walkthrough.pages).toEqual({});

    const reset = await SELF.fetch("https://tempo.test/api/walkthrough/reset", {
      method: "POST", headers: { ...auth(first.key), Origin: "https://tempo.test" }
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ data: { status: "pending", pages: {} }, revision: firstBootstrap.revision });
    const resetBootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(first.key) })).json() as any;
    expect(resetBootstrap.data.walkthrough).toEqual({ status: "pending", pages: {} });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM space_walkthrough_pages WHERE space_id=(SELECT id FROM spaces WHERE access_key_hash=?)").bind(await sha256(first.key)).first()).toMatchObject({ count: 0 });
  });

  it("imports Google Health only on explicit sync and serves Cardio from isolated D1 rows", async () => {
    const first = await createArea(); const second = await createArea();
    const firstSpaceId = (await env.DB.prepare("SELECT id FROM spaces WHERE access_key_hash=?").bind(await sha256(first.key)).first<{ id: number }>())!.id;
    const now = Date.parse("2026-08-08T18:00:00Z");
    const connectPayload = await (await SELF.fetch("https://tempo.test/api/google-health/connect", { method: "POST", headers: { ...auth(first.key), Origin: "https://tempo.test" } })).json() as { data: { url: string } };
    expect(new URL(connectPayload.data.url).searchParams.get("client_id")).toBe("test-client-id");
    expect((await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='google_health_connections'").first<{ sql: string }>())?.sql).not.toMatch(/client_id|client_secret/);
    await env.DB.prepare("INSERT INTO google_health_connections (space_id,refresh_token_ciphertext,refresh_token_iv,granted_scopes,connected_at) VALUES (?,'encrypted','iv','read',?)")
      .bind(firstSpaceId, now).run();
    const googleRequests: string[] = [];
    const googleFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); googleRequests.push(url.toString());
      const dataType = url.pathname.split("/").at(-2);
      if (dataType === "daily-resting-heart-rate") return Response.json({ dataPoints: [
        { dailyRestingHeartRate: { date: { year: 2026, month: 8, day: 7 }, beatsPerMinute: 56, dailyRestingHeartRateMetadata: { calculationMethod: "SLEEP" } } },
        { dailyRestingHeartRate: { date: { year: 2026, month: 8, day: 8 }, beatsPerMinute: 54 } }
      ] });
      if (dataType === "steps") {
        const body = JSON.parse(String(init?.body));
        if (body.windowSize === "3600s") return Response.json({ rollupDataPoints: [
          { startTime: "2026-08-07T16:00:00Z", steps: { countSum: "500" } },
          { startTime: "2026-08-07T17:00:00Z", steps: { countSum: "800" } },
          { startTime: "2026-08-08T16:00:00Z", steps: { countSum: "650" } },
          { startTime: "2026-08-08T17:00:00Z", steps: { countSum: "900" } }
        ] });
        expect(body).toMatchObject({ windowSizeDays: 1, pageSize: 7 });
        return Response.json({ rollupDataPoints: [
          { civilStartTime: { date: { year: 2026, month: 8, day: 7 } }, steps: { countSum: "8500" } },
          { civilStartTime: { date: { year: 2026, month: 8, day: 8 } }, steps: { countSum: "10200" } }
        ] });
      }
      if (dataType === "time-in-heart-rate-zone") return Response.json({ rollupDataPoints: [
        { civilStartTime: { date: { year: 2026, month: 8, day: 7 } }, timeInHeartRateZone: { timeInHeartRateZones: [{ heartRateZone: "MODERATE", duration: "1200s" }] } },
        { civilStartTime: { date: { year: 2026, month: 8, day: 8 } }, timeInHeartRateZone: { timeInHeartRateZones: [{ heartRateZone: "MODERATE", duration: "1800s" }] } }
      ] });
      if (dataType === "exercise") {
        expect(url.searchParams.get("filter")).toBe('exercise.interval.civil_start_time >= "2025-08-07" AND exercise.interval.civil_start_time < "2026-08-09"');
        return Response.json({ dataPoints: [
        { name: "treadmill-1", exercise: { exerciseType: "TREADMILL", displayName: "Morning treadmill", interval: { startTime: "2026-08-08T17:00:00Z", endTime: "2026-08-08T17:30:00Z" }, activeDuration: "1500s", updateTime: "2026-08-08T17:45:00Z", metricsSummary: { averageHeartRateBeatsPerMinute: 135, distanceMillimeters: 3000000, steps: 4000, heartRateZoneDurations: { moderateTime: "900s", vigorousTime: "600s" } } } },
        { name: "outdoor-walk", exercise: { exerciseType: "WALKING", interval: { startTime: "2026-08-08T12:00:00Z", endTime: "2026-08-08T12:30:00Z" } } }
        ] });
      }
      if (dataType === "heart-rate") {
        expect(url.searchParams.get("filter")).toBe('heart_rate.sample_time.physical_time >= "2026-08-08T17:00:00.000Z" AND heart_rate.sample_time.physical_time < "2026-08-08T17:30:00.001Z"');
        return Response.json({ dataPoints: [
          { heartRate: { sampleTime: { physicalTime: "2026-08-08T17:05:00Z" }, beatsPerMinute: 120 } },
          { heartRate: { sampleTime: { physicalTime: "2026-08-08T17:20:00Z" }, beatsPerMinute: 150 } }
        ] });
      }
      return Response.json({ error: { message: "unexpected request" } }, { status: 500 });
    }) as typeof fetch;

    const imported = await importGoogleHealthData(env.DB, firstSpaceId, "access-token", now, googleFetch);
    expect(imported).toEqual({ restingHeartRates: 2, dailySteps: 2, hourlySteps: 4, dailyZone2: 2, sessions: 1, heartRateSamples: 2 });
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM cardio_resting_heart_rates WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>())?.count).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM cardio_daily_steps WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>())?.count).toBe(2);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM cardio_hourly_steps WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>())?.count).toBe(4);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM cardio_daily_zone2 WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>())?.count).toBe(2);
    expect(googleRequests).toHaveLength(10);
    expect(await importGoogleHealthData(env.DB, firstSpaceId, "access-token", now + 60_000, googleFetch)).toMatchObject({ restingHeartRates: 2, dailySteps: 2, dailyZone2: 2, sessions: 1, heartRateSamples: 0 });
    expect(await env.DB.prepare("SELECT synced_at FROM cardio_resting_heart_rates WHERE space_id=? LIMIT 1").bind(firstSpaceId).first()).toMatchObject({ synced_at: now });
    expect(await env.DB.prepare("SELECT synced_at FROM cardio_daily_steps WHERE space_id=? LIMIT 1").bind(firstSpaceId).first()).toMatchObject({ synced_at: now });
    expect(await env.DB.prepare("SELECT synced_at FROM cardio_sessions WHERE space_id=? LIMIT 1").bind(firstSpaceId).first()).toMatchObject({ synced_at: now });
    expect(googleRequests).toHaveLength(19);

    const firstCardio = await SELF.fetch("https://tempo.test/api/cardio", { headers: auth(first.key) });
    expect(firstCardio.status).toBe(200);
    const firstPayload = await firstCardio.json() as { data: { zone2GoalMinutes: number | null; dailyStepsGoal: number | null; restingHeartRates: unknown[]; dailySteps: Array<{ date: string; count: number }>; hourlySteps: Array<{ startTime: number; count: number }>; dailyZone2: Array<{ date: string; moderateSeconds: number }>; sessions: Array<{ id: number; minimumHeartRate: number; maximumHeartRate: number; zones: { moderate: number } }> } };
    const recentSync = Date.now();
    await env.DB.prepare("UPDATE google_health_connections SET cardio_last_sync_at=? WHERE space_id=?").bind(recentSync, firstSpaceId).run();
    const skippedCardioSync = await SELF.fetch("https://tempo.test/api/cardio/sync", { method: "POST", headers: { ...auth(first.key), Origin: "https://tempo.test" } });
    expect(skippedCardioSync.status).toBe(200);
    expect(await skippedCardioSync.json()).toMatchObject({ data: { sync: { skipped: true } } });
    expect(firstPayload.data.zone2GoalMinutes).toBeNull();
    expect(firstPayload.data.dailyStepsGoal).toBeNull();
    expect(firstPayload.data.restingHeartRates).toHaveLength(2);
    expect(firstPayload.data.dailySteps).toEqual([{ date: "2026-08-07", count: 8500 }, { date: "2026-08-08", count: 10200 }]);
    expect(firstPayload.data.hourlySteps).toEqual([
      { startTime: Date.parse("2026-08-07T16:00:00Z"), count: 500 },
      { startTime: Date.parse("2026-08-07T17:00:00Z"), count: 800 },
      { startTime: Date.parse("2026-08-08T16:00:00Z"), count: 650 },
      { startTime: Date.parse("2026-08-08T17:00:00Z"), count: 900 }
    ]);
    expect(firstPayload.data.dailyZone2).toEqual([{ date: "2026-08-07", moderateSeconds: 1200 }, { date: "2026-08-08", moderateSeconds: 1800 }]);
    expect(firstPayload.data.sessions[0]).toMatchObject({ minimumHeartRate: 120, maximumHeartRate: 150, zones: { moderate: 900 } });
    const invalidZone2Goal = await SELF.fetch("https://tempo.test/api/cardio/zone-2-goal", { method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ minutes: 0 }) });
    expect(invalidZone2Goal.status).toBe(422);
    const savedZone2Goal = await SELF.fetch("https://tempo.test/api/cardio/zone-2-goal", { method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ minutes: 150 }) });
    expect(savedZone2Goal.status).toBe(200);
    expect(await savedZone2Goal.json()).toMatchObject({ data: { zone2GoalMinutes: 150 } });
    expect(await env.DB.prepare("SELECT cardio_zone2_goal_minutes FROM spaces WHERE id=?").bind(firstSpaceId).first()).toMatchObject({ cardio_zone2_goal_minutes: 150 });
    const invalidStepsGoal = await SELF.fetch("https://tempo.test/api/cardio/steps-goal", { method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ steps: 0 }) });
    expect(invalidStepsGoal.status).toBe(422);
    const savedStepsGoal = await SELF.fetch("https://tempo.test/api/cardio/steps-goal", { method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ steps: 10000 }) });
    expect(savedStepsGoal.status).toBe(200);
    expect(await savedStepsGoal.json()).toMatchObject({ data: { dailyStepsGoal: 10000 } });
    expect(await env.DB.prepare("SELECT cardio_daily_steps_goal FROM spaces WHERE id=?").bind(firstSpaceId).first()).toMatchObject({ cardio_daily_steps_goal: 10000 });
    expect(googleRequests).toHaveLength(19);
    const detail = await (await SELF.fetch(`https://tempo.test/api/cardio/sessions/${firstPayload.data.sessions[0].id}`, { headers: auth(first.key) })).json() as { data: { samples: unknown[] } };
    expect(detail.data.samples).toHaveLength(2);
    expect(googleRequests).toHaveLength(19);

    const partialFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); const dataType = url.pathname.split("/").at(-2);
      if (dataType === "daily-resting-heart-rate") return Response.json({ dataPoints: [] });
      if (dataType === "steps") return Response.json({ rollupDataPoints: [] });
      if (dataType === "time-in-heart-rate-zone") return Response.json({ rollupDataPoints: [] });
      if (dataType === "exercise") return Response.json({ dataPoints: [{ name: "treadmill-1", exercise: { exerciseType: "TREADMILL", displayName: "Morning treadmill", interval: { startTime: "2026-08-08T17:00:00Z", endTime: "2026-08-08T17:30:00Z" }, updateTime: "2026-08-09T17:45:00Z" } }] });
      if (dataType === "heart-rate") return Response.json({ error: { message: "Invalid argument in request." } }, { status: 400 });
      return Response.json({ error: { message: "unexpected request" } }, { status: 500 });
    }) as typeof fetch;
    const partial = await importGoogleHealthData(env.DB, firstSpaceId, "access-token", now + 86400000, partialFetch);
    expect(partial).toMatchObject({ sessions: 1, heartRateSamples: 0, warnings: ["Heart rate for Morning treadmill: Invalid argument in request."] });
    expect(await env.DB.prepare("SELECT cardio_last_sync_at FROM google_health_connections WHERE space_id=?").bind(firstSpaceId).first()).toMatchObject({ cardio_last_sync_at: recentSync });
    const preserved = await (await SELF.fetch(`https://tempo.test/api/cardio/sessions/${firstPayload.data.sessions[0].id}`, { headers: auth(first.key) })).json() as { data: { samples: unknown[]; minimumHeartRate: number; maximumHeartRate: number } };
    expect(preserved.data).toMatchObject({ minimumHeartRate: 120, maximumHeartRate: 150 });
    expect(preserved.data.samples).toHaveLength(2);

    const treadmillFailureFetch = (async (input: RequestInfo | URL) => {
      const dataType = new URL(String(input)).pathname.split("/").at(-2);
      if (dataType === "daily-resting-heart-rate") return Response.json({ dataPoints: [] });
      if (dataType === "steps") return Response.json({ rollupDataPoints: [] });
      if (dataType === "time-in-heart-rate-zone") return Response.json({ rollupDataPoints: [] });
      if (dataType === "exercise") return Response.json({ error: { message: "Invalid argument in request." } }, { status: 400 });
      return Response.json({ error: { message: "unexpected request" } }, { status: 500 });
    }) as typeof fetch;
    const withoutTreadmills = await importGoogleHealthData(env.DB, firstSpaceId, "access-token", now + 2 * 86400000, treadmillFailureFetch);
    expect(withoutTreadmills).toMatchObject({ sessions: 0, warnings: ["Treadmill sessions: Invalid argument in request."] });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_sessions WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>()).toMatchObject({ count: 1 });

    const emptyExerciseFetch = (async (input: RequestInfo | URL) => {
      const dataType = new URL(String(input)).pathname.split("/").at(-2);
      if (dataType === "daily-resting-heart-rate" || dataType === "exercise") return Response.json({ dataPoints: [] });
      if (dataType === "steps") return Response.json({ rollupDataPoints: [] });
      if (dataType === "time-in-heart-rate-zone") return Response.json({ rollupDataPoints: [] });
      return Response.json({ error: { message: "unexpected request" } }, { status: 500 });
    }) as typeof fetch;
    const withoutReturnedSessions = await importGoogleHealthData(env.DB, firstSpaceId, "access-token", now + 3 * 86400000, emptyExerciseFetch);
    expect(withoutReturnedSessions).toMatchObject({ sessions: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_sessions WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_heart_rate_chunks WHERE space_id=?").bind(firstSpaceId).first<{ count: number }>()).toMatchObject({ count: 1 });

    const deletedCardio = await SELF.fetch(`https://tempo.test/api/cardio/sessions/${firstPayload.data.sessions[0].id}`, { method: "DELETE", headers: { ...auth(first.key), Origin: "https://tempo.test" } });
    expect(deletedCardio.status).toBe(200);
    expect(await deletedCardio.json()).toMatchObject({ data: { sessions: [] } });
    expect(await env.DB.prepare("SELECT google_data_point_name FROM cardio_session_exclusions WHERE space_id=?").bind(firstSpaceId).first()).toMatchObject({ google_data_point_name: "treadmill-1" });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_heart_rate_chunks WHERE space_id=?").bind(firstSpaceId).first()).toMatchObject({ count: 0 });
    expect((await SELF.fetch(`https://tempo.test/api/cardio/sessions/${firstPayload.data.sessions[0].id}`, { headers: auth(first.key) })).status).toBe(404);
    expect(await importGoogleHealthData(env.DB, firstSpaceId, "access-token", now + 4 * 86400000, partialFetch)).toMatchObject({ sessions: 0, heartRateSamples: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_sessions WHERE space_id=?").bind(firstSpaceId).first()).toMatchObject({ count: 0 });

    const secondCardio = await (await SELF.fetch("https://tempo.test/api/cardio", { headers: auth(second.key) })).json() as { data: { zone2GoalMinutes: number | null; restingHeartRates: unknown[]; sessions: unknown[] } };
    expect(secondCardio.data).toMatchObject({ zone2GoalMinutes: null, restingHeartRates: [], dailySteps: [], hourlySteps: [], dailyZone2: [], sessions: [] });
    expect((await SELF.fetch(`https://tempo.test/api/cardio/sessions/${firstPayload.data.sessions[0].id}`, { headers: auth(second.key) })).status).toBe(404);
  });

  it("stores parsed Google sleep sessions and stages in space-scoped D1 rows", async () => {
    const first = await createArea(); const second = await createArea();
    const firstSpaceId = (await env.DB.prepare("SELECT id FROM spaces WHERE access_key_hash=?").bind(await sha256(first.key)).first<{ id: number }>())!.id;
    await env.DB.prepare("INSERT INTO google_health_connections (space_id,refresh_token_ciphertext,refresh_token_iv,granted_scopes,connected_at) VALUES (?,'encrypted','iv',?,?)")
      .bind(firstSpaceId, "https://www.googleapis.com/auth/googlehealth.sleep.readonly", Date.now()).run();
    const googleFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain("/dataTypes/sleep/dataPoints");
      expect(url.searchParams.get("filter")).toContain("sleep.interval.end_time >=");
      return Response.json({ dataPoints: [{
        name: "sleep-1",
        sleep: {
          type: "STAGES",
          interval: {
            startTime: "2026-08-08T06:00:00Z", endTime: "2026-08-08T14:00:00Z",
            startUtcOffset: "-25200s", endUtcOffset: "-25200s",
            civilEndTime: { date: { year: 2026, month: 8, day: 8 }, time: { hours: 7 } }
          },
          summary: { minutesAsleep: "435", minutesAwake: "45" },
          metadata: { nap: false }, updateTime: "2026-08-08T14:05:00Z",
          stages: [
            { type: "LIGHT", startTime: "2026-08-08T06:00:00Z", endTime: "2026-08-08T09:00:00Z" },
            { type: "DEEP", startTime: "2026-08-08T09:00:00Z", endTime: "2026-08-08T11:00:00Z" },
            { type: "REM", startTime: "2026-08-08T11:00:00Z", endTime: "2026-08-08T13:15:00Z" },
            { type: "AWAKE", startTime: "2026-08-08T13:15:00Z", endTime: "2026-08-08T14:00:00Z" }
          ]
        }
      }] });
    }) as typeof fetch;
    expect(await importGoogleSleepData(env.DB, firstSpaceId, "access-token", Date.parse("2026-08-09T00:00:00Z"), googleFetch)).toEqual({ sleepSessions: 1, sleepStages: 4 });
    expect(await importGoogleSleepData(env.DB, firstSpaceId, "access-token", Date.parse("2026-08-09T00:01:00Z"), googleFetch)).toEqual({ sleepSessions: 1, sleepStages: 4 });
    expect(await env.DB.prepare("SELECT synced_at FROM sleep_sessions WHERE space_id=?").bind(firstSpaceId).first()).toMatchObject({ synced_at: Date.parse("2026-08-09T00:00:00Z") });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM sleep_stages WHERE space_id=?").bind(firstSpaceId).first()).toMatchObject({ count: 4 });
    expect((await readSleep(env.DB, firstSpaceId, true, Date.parse("2026-08-14T12:00:00Z"))).sessions[0].stages).toHaveLength(4);
    expect((await readSleep(env.DB, firstSpaceId, true, Date.parse("2026-08-15T12:00:00Z"))).sessions[0].stages).toHaveLength(0);

    const firstSleep = await (await SELF.fetch("https://tempo.test/api/sleep", { headers: auth(first.key) })).json() as { data: { goal: null | { minutes: number; startTime: string }; sessions: Array<{ date: string; minutesAsleep: number; stages: unknown[] }> } };
    expect(firstSleep.data.goal).toBeNull();
    expect(firstSleep.data.sessions[0]).toMatchObject({ date: "2026-08-08", minutesAsleep: 435 });
    await env.DB.prepare("UPDATE google_health_connections SET sleep_last_sync_at=? WHERE space_id=?").bind(Date.now(), firstSpaceId).run();
    const skippedSleepSync = await SELF.fetch("https://tempo.test/api/sleep/sync", { method: "POST", headers: { ...auth(first.key), Origin: "https://tempo.test" } });
    expect(skippedSleepSync.status).toBe(200);
    expect(await skippedSleepSync.json()).toMatchObject({ data: { sync: { skipped: true } } });
    const invalidSleepGoal = await SELF.fetch("https://tempo.test/api/sleep/goal", { method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ minutes: 0, startTime: "22:30" }) });
    expect(invalidSleepGoal.status).toBe(422);
    const savedSleepGoalResponse = await SELF.fetch("https://tempo.test/api/sleep/goal", { method: "PUT", headers: { ...auth(first.key), "content-type": "application/json", Origin: "https://tempo.test" }, body: JSON.stringify({ minutes: 480, startTime: "22:30" }) });
    expect(savedSleepGoalResponse.status).toBe(200);
    const savedSleepGoal = await savedSleepGoalResponse.json() as { data: { goal: { minutes: number; startTime: string } } };
    expect(savedSleepGoal.data.goal).toEqual({ minutes: 480, startTime: "22:30" });
    expect(await env.DB.prepare("SELECT sleep_goal_minutes,sleep_goal_start_time FROM spaces WHERE id=?").bind(firstSpaceId).first()).toMatchObject({ sleep_goal_minutes: 480, sleep_goal_start_time: "22:30" });
    const secondSleep = await (await SELF.fetch("https://tempo.test/api/sleep", { headers: auth(second.key) })).json() as { data: { goal: null | { minutes: number; startTime: string }; sessions: unknown[] } };
    expect(secondSleep.data.goal).toBeNull();
    expect(secondSleep.data.sessions).toEqual([]);
  });

  it("limits repeat health syncs and retains only the current step display window",async()=>{
    const{key}=await createArea(),spaceId=(await env.DB.prepare("SELECT id FROM spaces WHERE access_key_hash=?").bind(await sha256(key)).first<{id:number}>())!.id;
    const lastSync=Date.parse("2026-08-09T18:00:00Z"),now=Date.parse("2026-08-10T20:00:00Z");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO google_health_connections(space_id,refresh_token_ciphertext,refresh_token_iv,granted_scopes,connected_at,cardio_last_sync_at,sleep_last_sync_at) VALUES(?,'encrypted','iv','read',?,?,?)").bind(spaceId,lastSync,lastSync,lastSync),
      env.DB.prepare("INSERT INTO cardio_resting_heart_rates(space_id,recorded_date,beats_per_minute,synced_at) VALUES(?,'2026-08-01',55,?)").bind(spaceId,lastSync),
      env.DB.prepare("INSERT INTO cardio_daily_steps(space_id,recorded_date,step_count,synced_at) VALUES(?,'2026-08-01',8000,?)").bind(spaceId,lastSync),
      env.DB.prepare("INSERT INTO cardio_hourly_steps(space_id,hour_start,step_count,synced_at) VALUES(?,?,500,?)").bind(spaceId,Date.parse("2026-08-01T12:00:00Z"),lastSync),
      env.DB.prepare("INSERT INTO cardio_daily_zone2(space_id,recorded_date,moderate_seconds,synced_at) VALUES(?,'2026-08-01',1200,?)").bind(spaceId,lastSync),
      env.DB.prepare("INSERT INTO sleep_sessions(space_id,google_data_point_name,sleep_date,start_time,end_time,minutes_asleep,is_nap,google_updated_at,synced_at) VALUES(?,'old-sleep','2026-08-01',?,?,420,0,?,?)").bind(spaceId,Date.parse("2026-08-01T05:00:00Z"),Date.parse("2026-08-01T12:00:00Z"),lastSync,lastSync)
    ]);
    const filters=new Map<string,string>(),stepRanges:{daily?:unknown;hourly?:unknown}={},zoneRanges:unknown[]=[];
    const incrementalFetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=new URL(String(input)),dataType=url.pathname.split("/").at(-2)!;if(dataType==="steps"){const body=JSON.parse(String(init?.body))as any;stepRanges[body.windowSize?"hourly":"daily"]=body.range;return Response.json({rollupDataPoints:[]});}if(dataType==="time-in-heart-rate-zone"){zoneRanges.push((JSON.parse(String(init?.body))as any).range);return Response.json({rollupDataPoints:[]});}filters.set(dataType,url.searchParams.get("filter")||"");return Response.json({dataPoints:[]});})as typeof fetch;
    await importGoogleHealthData(env.DB,spaceId,"access-token",now,incrementalFetch,lastSync);
    await importGoogleSleepData(env.DB,spaceId,"access-token",now,incrementalFetch,lastSync);
    expect(filters.get("daily-resting-heart-rate")).toBe('daily_resting_heart_rate.date >= "2026-08-09" AND daily_resting_heart_rate.date < "2026-08-11"');
    expect(filters.get("exercise")).toBe('exercise.interval.civil_start_time >= "2026-08-09" AND exercise.interval.civil_start_time < "2026-08-11"');
    expect(filters.get("sleep")).toBe('sleep.interval.end_time >= "2026-08-09T00:00:00.000Z" AND sleep.interval.end_time < "2026-08-11T00:00:00.000Z"');
    expect(stepRanges.daily).toMatchObject({start:{date:{year:2026,month:8,day:4}},end:{date:{year:2026,month:8,day:11}}});
    expect(stepRanges.hourly).toEqual({startTime:"2026-08-02T21:00:00.000Z",endTime:"2026-08-10T21:00:00.000Z"});
    expect(zoneRanges[0]).toMatchObject({start:{date:{year:2026,month:8,day:9}},end:{date:{year:2026,month:8,day:11}}});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_resting_heart_rates WHERE space_id=?").bind(spaceId).first()).toMatchObject({count:1});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_daily_steps WHERE space_id=?").bind(spaceId).first()).toMatchObject({count:0});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_hourly_steps WHERE space_id=?").bind(spaceId).first()).toMatchObject({count:0});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM cardio_daily_zone2 WHERE space_id=?").bind(spaceId).first()).toMatchObject({count:1});
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM sleep_sessions WHERE space_id=?").bind(spaceId).first()).toMatchObject({count:1});

    const zoneFailureFetch=(async(input:RequestInfo|URL)=>{const dataType=new URL(String(input)).pathname.split("/").at(-2)!;if(dataType==="time-in-heart-rate-zone")return Response.json({error:{message:"Zone rollup unavailable."}},{status:503});if(dataType==="steps")return Response.json({rollupDataPoints:[]});return Response.json({dataPoints:[]});})as typeof fetch;
    const partial=await importGoogleHealthData(env.DB,spaceId,"access-token",now+86400000,zoneFailureFetch,now);
    expect(partial).toMatchObject({warnings:["Heart-rate zones: Zone rollup unavailable."]});
    expect(await env.DB.prepare("SELECT cardio_last_sync_at FROM google_health_connections WHERE space_id=?").bind(spaceId).first()).toMatchObject({cardio_last_sync_at:now});
  });

  it("stores an isolated portfolio and values stocks and cash with Yahoo FX history", async () => {
    const first = await createArea(); const second = await createArea();
    const firstSpaceId = (await env.DB.prepare("SELECT id FROM spaces WHERE access_key_hash=?").bind(await sha256(first.key)).first<{ id: number }>())!.id;
    const mutate = (path: string, body: unknown) => SELF.fetch(`https://tempo.test${path}`, { method: "POST", headers: { ...auth(first.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify(body) });
    const categoryResponse = await mutate("/api/finances/allocation-categories", { name: "Equities", color: "#ec5f3e", targetPercentage: 60 });
    expect(categoryResponse.status).toBe(201);
    const categoryPayload = await categoryResponse.json() as { data: { allocation: { categories: Array<{ id: number }> } } };
    const equitiesId = categoryPayload.data.allocation.categories[0].id;
    expect((await mutate("/api/finances/allocation-categories", { name: "Invalid target", color: "#f0ad43", targetPercentage: null })).status).toBe(422);
    expect((await SELF.fetch(`https://tempo.test/api/finances/allocation-categories/${equitiesId}`, { method: "PUT", headers: { ...auth(first.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ name: "Equities", color: "#ec5f3e", targetPercentage: "" }) })).status).toBe(422);
    expect((await mutate("/api/finances/holdings", { type: "STOCK", symbol: "aapl", quantity: 2, allocationCategoryId: equitiesId })).status).toBe(201);
    expect((await mutate("/api/finances/holdings", { type: "CASH", currency: "USD", name: "Emergency fund", quantity: 1000 })).status).toBe(201);
    expect((await mutate("/api/finances/holdings", { type: "CASH", currency: "USD", quantity: 250 })).status).toBe(201);
    expect((await mutate("/api/finances/holdings", { type: "CASH", currency: "CAD", quantity: 500 })).status).toBe(201);
    expect((await mutate("/api/finances/holdings", { type: "STOCK", symbol: "AAPL", quantity: 1 })).status).toBe(409);

    const marketData = async (symbol: string) => {
      if (symbol === "AAPL") return { symbol, name: "Apple Inc.", currency: "USD", currentPrice: 100, marketTime: Date.parse("2026-08-09T20:00:00Z"), points: [{ date: "2026-08-01", close: 80 }, { date: "2026-08-06", close: 85 }, { date: "2026-08-07", close: 0 }, { date: "2026-08-08", close: 0 }] };
      if (symbol === "MSFT") return { symbol, name: "Microsoft Corporation", currency: "CAD", currentPrice: 200, marketTime: Date.parse("2026-08-10T20:00:00Z"), points: [{ date: "2026-08-09", close: 190 }] };
      if (symbol === "USDCAD=X") return { symbol, name: symbol, currency: "CAD", currentPrice: 1.4, marketTime: Date.parse("2026-08-09T20:00:00Z"), points: [{ date: "2026-08-01", close: 1.2 }, { date: "2026-08-08", close: 1.3 }] };
      throw new Error("Unknown ticker");
    };
    expect(await refreshFinances(env.DB, firstSpaceId, marketData, Date.parse("2026-08-09T22:00:00Z"))).toMatchObject({ stocks: 1, exchangeRates: 1 });
    await env.DB.batch([
      env.DB.prepare("UPDATE finance_quotes SET synced_at=?").bind(Date.now()),
      env.DB.prepare("UPDATE finance_fx_quotes SET synced_at=?").bind(Date.now())
    ]);
    const skippedFinanceRefresh = await SELF.fetch("https://tempo.test/api/finances/refresh", { method: "POST", headers: { ...auth(first.key), Origin: "https://tempo.test" } });
    expect(skippedFinanceRefresh.status).toBe(200);
    expect(await skippedFinanceRefresh.json()).toMatchObject({ data: { sync: { skipped: true } } });
    const portfolio = await readFinances(env.DB, firstSpaceId, Date.parse("2026-08-09T22:00:00Z"));
    expect(portfolio).toMatchObject({ currency: "CAD", totalValue: 2530 });
    expect(portfolio.allocation).toMatchObject({ targetTotal: 60, categories: [expect.objectContaining({ id: equitiesId, name: "Equities", targetPercentage: 60, currentValue: 280 })] });
    expect(portfolio.allocation.categories[0].currentPercentage).toBeCloseTo(11.07, 2);
    expect(portfolio.changes.yesterday).toMatchObject({ value: 2346, change: 184 });
    expect(portfolio.changes.month).toMatchObject({ value: 2530, change: 0, fallbackLabels: ["AAPL", "Emergency fund", "USD cash"] });
    expect(portfolio.holdings.filter(holding => holding.type === "CASH" && holding.currency === "USD")).toHaveLength(2);
    expect(portfolio.holdings.find(holding => holding.type === "CASH" && holding.quantity === 1000)).toMatchObject({ name: "Emergency fund" });
    const appleHolding = portfolio.holdings.find(holding => holding.symbol === "AAPL")!;
    expect(appleHolding).toMatchObject({ name: "Apple Inc.", currency: "USD", nativePrice: 100, marketValue: 280, previousMarketValue: 221, valueChange: 59 });
    expect(appleHolding.percentChange).toBeCloseTo(26.7, 2);
    const updatedStock = await SELF.fetch(`https://tempo.test/api/finances/holdings/${appleHolding.id}`, { method: "PUT", headers: { ...auth(first.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ type: "STOCK", symbol: "AAPL", quantity: 3 }) });
    expect(updatedStock.status).toBe(200);
    expect(await updatedStock.json()).toMatchObject({ data: { holdings: expect.arrayContaining([expect.objectContaining({ id: appleHolding.id, name: "Apple Inc.", currency: "USD", nativePrice: 100, quantity: 3 })]) } });
    expect(await env.DB.prepare("SELECT native_currency,display_name FROM finance_holdings WHERE id=?").bind(appleHolding.id).first()).toMatchObject({ native_currency: "USD", display_name: "Apple Inc." });
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM finance_daily_prices").first<{ count: number }>())?.count).toBe(4);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM finance_daily_fx_rates").first<{ count: number }>())?.count).toBe(2);
    await env.DB.batch([
      env.DB.prepare("UPDATE finance_daily_prices SET close_price=77 WHERE symbol='AAPL' AND price_date='2026-08-01'"),
      env.DB.prepare("UPDATE finance_daily_fx_rates SET exchange_rate=7.7 WHERE from_currency='USD' AND to_currency='CAD' AND rate_date='2026-08-01'")
    ]);
    const appendedMarketData = async (symbol: string) => {
      const series = await marketData(symbol);
      const newPoint = symbol === "AAPL" ? { date: "2026-08-09", close: 101 } : symbol === "USDCAD=X" ? { date: "2026-08-09", close: 1.41 } : null;
      return { ...series, points: newPoint ? [...series.points, newPoint] : series.points };
    };
    await refreshFinances(env.DB, firstSpaceId, appendedMarketData, Date.parse("2026-08-10T01:00:00Z"));
    expect(await env.DB.prepare("SELECT close_price FROM finance_daily_prices WHERE symbol='AAPL' AND price_date='2026-08-01'").first()).toMatchObject({ close_price: 77 });
    expect(await env.DB.prepare("SELECT exchange_rate FROM finance_daily_fx_rates WHERE from_currency='USD' AND to_currency='CAD' AND rate_date='2026-08-01'").first()).toMatchObject({ exchange_rate: 7.7 });
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM finance_daily_prices").first<{ count: number }>())?.count).toBe(5);
    expect((await env.DB.prepare("SELECT COUNT(*) count FROM finance_daily_fx_rates").first<{ count: number }>())?.count).toBe(3);

    const sharedHolding = await SELF.fetch("https://tempo.test/api/finances/holdings", { method: "POST", headers: { ...auth(second.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ type: "STOCK", symbol: "AAPL", quantity: 1 }) });
    expect(sharedHolding.status).toBe(201);
    expect(await sharedHolding.json()).toMatchObject({ data: { holdings: [expect.objectContaining({ symbol: "AAPL", name: "Apple Inc.", currency: "USD", nativePrice: 100 })] } });

    const changedTicker = await SELF.fetch(`https://tempo.test/api/finances/holdings/${appleHolding.id}`, { method: "PUT", headers: { ...auth(first.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ type: "STOCK", symbol: "MSFT", quantity: 3 }) });
    expect(changedTicker.status).toBe(200);
    expect(await changedTicker.json()).toMatchObject({ data: { lastRefreshedAt: null, holdings: expect.arrayContaining([expect.objectContaining({ id: appleHolding.id, symbol: "MSFT", name: "MSFT", currency: null, nativePrice: null })]) } });
    expect(await refreshFinances(env.DB, firstSpaceId, marketData, Date.parse("2026-08-10T22:00:00Z"))).toMatchObject({ stocks: 1 });
    expect(await readFinances(env.DB, firstSpaceId, Date.parse("2026-08-10T22:00:00Z"))).toMatchObject({ holdings: expect.arrayContaining([expect.objectContaining({ id: appleHolding.id, symbol: "MSFT", name: "Microsoft Corporation", currency: "CAD", nativePrice: 200 })]) });

    const changedCurrency = await SELF.fetch("https://tempo.test/api/finances/currency", { method: "PUT", headers: { ...auth(first.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ currency: "USD" }) });
    expect(changedCurrency.status).toBe(200);
    expect(await env.DB.prepare("SELECT finance_display_currency FROM spaces WHERE id=?").bind(firstSpaceId).first()).toMatchObject({ finance_display_currency: "USD" });

    const emergencyHolding = portfolio.holdings.find(holding => holding.name === "Emergency fund")!;
    const editedHolding = await SELF.fetch(`https://tempo.test/api/finances/holdings/${emergencyHolding.id}`, { method: "PUT", headers: { ...auth(first.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ type: "CASH", currency: "EUR", name: "Travel fund", quantity: 1250, allocationCategoryId: equitiesId }) });
    expect(editedHolding.status).toBe(200);
    expect(await editedHolding.json()).toMatchObject({ data: { holdings: expect.arrayContaining([expect.objectContaining({ id: emergencyHolding.id, type: "CASH", currency: "EUR", name: "Travel fund", quantity: 1250, allocationCategoryId: equitiesId })]) } });
    expect(await env.DB.prepare("SELECT asset_type,symbol,native_currency,display_name,quantity FROM finance_holdings WHERE id=? AND space_id=?").bind(emergencyHolding.id, firstSpaceId).first()).toMatchObject({ asset_type: "CASH", symbol: null, native_currency: "EUR", display_name: "Travel fund", quantity: 1250 });

    const secondPortfolio = await (await SELF.fetch("https://tempo.test/api/finances", { headers: auth(second.key) })).json() as { data: { holdings: unknown[]; currency: string } };
    expect(secondPortfolio.data).toMatchObject({ currency: "CAD", holdings: [expect.objectContaining({ symbol: "AAPL", quantity: 1, name: "Apple Inc.", currency: "USD" })] });
    expect((await SELF.fetch(`https://tempo.test/api/finances/holdings/${emergencyHolding.id}`, { method: "PUT", headers: { ...auth(second.key), Origin: "https://tempo.test", "content-type": "application/json" }, body: JSON.stringify({ type: "CASH", currency: "CAD", name: "Not owned", quantity: 1 }) })).status).toBe(404);
    expect((await SELF.fetch(`https://tempo.test/api/finances/allocation-categories/${equitiesId}`, { method: "DELETE", headers: { ...auth(first.key), Origin: "https://tempo.test" } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT allocation_category_id FROM finance_holdings WHERE id=?").bind(emergencyHolding.id).first()).toMatchObject({ allocation_category_id: null });
  });

  it("rejects child relationships that cross space ownership", async () => {
    await createArea(); await createArea();
    const spaces = await env.DB.prepare("SELECT id FROM spaces ORDER BY id").all<{ id: number }>();
    const [first, second] = spaces.results;
    await env.DB.prepare("INSERT INTO timers (space_id,name,duration_seconds,remaining_seconds,color,sort_order) VALUES (?,'Owned',60,60,'#111',0)").bind(first.id).run();
    const habit = await env.DB.prepare("INSERT INTO habits (space_id,name,kind,goal,color,sort_order) VALUES (?,'Owned','toggle',1,'#111',0)").bind(first.id).run();
    await expect(env.DB.prepare("INSERT INTO habit_schedule_days (space_id,habit_id,weekday) VALUES (?,?,1)").bind(second.id, habit.meta.last_row_id).run()).rejects.toThrow();
    const food = await env.DB.prepare("INSERT INTO foods (space_id,title,serving_size,serving_unit,calories,carbs,protein,fats,fibre,sort_order) VALUES (?,'Owned',1,'g',0,0,0,0,0,0)").bind(first.id).run();
    await expect(env.DB.prepare("INSERT INTO food_log_entries (space_id,log_date,food_id,serving_size,logged_at,title_snapshot,serving_size_snapshot,serving_unit_snapshot,calories_snapshot,carbs_snapshot,protein_snapshot,fats_snapshot,fibre_snapshot) VALUES (?,'2026-08-10',?,1,1,'Owned',1,'g',0,0,0,0,0)").bind(second.id, food.meta.last_row_id).run()).rejects.toThrow();
    const mesocycle = await env.DB.prepare("INSERT INTO mesocycles (space_id,name,progression_rate,sort_order) VALUES (?,'Owned',0.025,0)").bind(first.id).run();
    await expect(env.DB.prepare("UPDATE spaces SET active_mesocycle_id=? WHERE id=?").bind(mesocycle.meta.last_row_id, second.id).run()).rejects.toThrow();
  });

  it("rejects stale revisions and preserves the winning state", async () => {
    const { key } = await createArea();
    const bootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(key) })).json() as { data: Record<string, unknown>; revision: number };
    expect(bootstrap.data).not.toHaveProperty("state");
    const initial = await getState(key);
    const changed = { ...initial.data, timers: [{ id: "focus", name: "Focus" }] };
    const first = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" }, body: JSON.stringify(changed) });
    expect(first.status).toBe(200);
    const stale = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" }, body: JSON.stringify(initial.data) });
    expect(stale.status).toBe(412);
    const finalState = await (await SELF.fetch("https://tempo.test/api/state", { headers: auth(key) })).json() as { data: { timers: unknown[] } };
    expect(finalState.data.timers).toHaveLength(1);
  });

  it("loads and saves focused state sections without returning unrelated app state", async () => {
    const { key } = await createArea();
    const bootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(key) })).json() as { data: Record<string, unknown>; revision: number };
    expect(bootstrap.data).not.toHaveProperty("state");

    const timer = { id: "focus", name: "Focus", duration: 1500, remaining: 1500, color: "#111", running: false, lastTick: null, pomodoro: false, restDuration: 300, phase: "work", countdownBeeps: false, trackCompletions: false, dailyTarget: 1, completedToday: 0, completionDate: "2026-08-12" };
    const savedTimers = await SELF.fetch("https://tempo.test/api/timers", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": `"${bootstrap.revision}"`, Origin: "https://tempo.test" }, body: JSON.stringify([timer]) });
    expect(savedTimers.status, await savedTimers.clone().text()).toBe(200);
    const timerPayload = await savedTimers.json() as { data: Array<{ id: number; name: string }>; revision: number };
    expect(timerPayload.data).toEqual([expect.objectContaining({ id: expect.any(Number), name: "Focus" })]);
    expect(timerPayload).not.toHaveProperty("data.widgets");

    const savedHabits = await SELF.fetch("https://tempo.test/api/habits", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": `"${timerPayload.revision}"`, Origin: "https://tempo.test" }, body: JSON.stringify([{ id: "water", name: "Water", type: "counter", goal: 8, color: "#222", days: [1,2,3,4,5] }]) });
    expect(savedHabits.status, await savedHabits.clone().text()).toBe(200);
    const habitPayload = await savedHabits.json() as { data: Array<{ id: number; name: string }> };
    expect(habitPayload.data).toEqual([expect.objectContaining({ id: expect.any(Number), name: "Water" })]);

    const loadedTimers = await (await SELF.fetch("https://tempo.test/api/timers", { headers: auth(key) })).json() as { data: unknown[] };
    const loadedHabits = await (await SELF.fetch("https://tempo.test/api/habits", { headers: auth(key) })).json() as { data: unknown[] };
    expect(loadedTimers.data).toHaveLength(1);
    expect(loadedHabits.data).toHaveLength(1);
  });

  it("loads recent logs and preserves older history during focused saves", async () => {
    const { key } = await createArea();
    const space = await env.DB.prepare("SELECT id FROM spaces ORDER BY id DESC LIMIT 1").first<{id:number}>();
    const habit = await env.DB.prepare("INSERT INTO habits(space_id,name,kind,goal,color,sort_order) VALUES(?,'Water','counter',8,'#123',0)").bind(space!.id).run();
    const food = await env.DB.prepare("INSERT INTO foods(space_id,title,serving_size,serving_unit,calories,carbs,protein,fats,fibre,sort_order) VALUES(?,'Oats',40,'g',150,27,5,3,4,0)").bind(space!.id).run();
    const habitId = Number(habit.meta.last_row_id), foodId = Number(food.meta.last_row_id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO habit_daily_logs(space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done) VALUES(?,?,'2026-07-01','Water','#123','counter',8,2,0)").bind(space!.id,habitId),
      env.DB.prepare("INSERT INTO habit_daily_logs(space_id,habit_id,log_date,name_snapshot,color_snapshot,kind_snapshot,goal_snapshot,value,done) VALUES(?,?,'2026-08-21','Water','#123','counter',8,3,0)").bind(space!.id,habitId),
      env.DB.prepare("INSERT INTO food_log_entries(space_id,log_date,food_id,serving_size,logged_at,title_snapshot,serving_size_snapshot,serving_unit_snapshot,calories_snapshot,carbs_snapshot,protein_snapshot,fats_snapshot,fibre_snapshot) VALUES(?,'2026-07-01',?,40,1,'Oats',40,'g',150,27,5,3,4)").bind(space!.id,foodId),
      env.DB.prepare("INSERT INTO food_log_entries(space_id,log_date,food_id,serving_size,logged_at,title_snapshot,serving_size_snapshot,serving_unit_snapshot,calories_snapshot,carbs_snapshot,protein_snapshot,fats_snapshot,fibre_snapshot) VALUES(?,'2026-08-21',?,40,2,'Oats',40,'g',150,27,5,3,4)").bind(space!.id,foodId)
    ]);

    const recentHabits = await (await SELF.fetch("https://tempo.test/api/habit-logs?from=2026-08-14&to=2026-08-21", { headers: auth(key) })).json() as {data:any};
    const recentFoods = await (await SELF.fetch("https://tempo.test/api/food-logs?from=2026-08-14&to=2026-08-21", { headers: auth(key) })).json() as {data:any};
    expect(Object.keys(recentHabits.data)).toEqual(["2026-08-21"]);
    expect(Object.keys(recentFoods.data.foodLogs)).toEqual(["2026-08-21"]);

    const habitSave = await SELF.fetch("https://tempo.test/api/habit-logs", { method:"PUT", headers:{...auth(key),"content-type":"application/json","If-Match":'"0"',Origin:"https://tempo.test"}, body:JSON.stringify(recentHabits.data) });
    const habitRevision = (await habitSave.json() as {revision:number}).revision;
    const foodSave = await SELF.fetch("https://tempo.test/api/food-logs", { method:"PUT", headers:{...auth(key),"content-type":"application/json","If-Match":`"${habitRevision}"`,Origin:"https://tempo.test"}, body:JSON.stringify(recentFoods.data) });
    expect(foodSave.status,await foodSave.clone().text()).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM habit_daily_logs WHERE space_id=? AND log_date='2026-07-01'").bind(space!.id).first("count")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM food_log_entries WHERE space_id=? AND log_date='2026-07-01'").bind(space!.id).first("count")).toBe(1);
  });

  it("rejects malformed or reversed log date ranges instead of returning unbounded history", async () => {
    const { key } = await createArea();
    for (const path of [
      "/api/habit-logs?from=not-a-date&to=2026-08-21",
      "/api/habit-logs?from=2026-02-30&to=2026-08-21",
      "/api/food-logs?from=2026-08-22&to=2026-08-21"
    ]) {
      const response = await SELF.fetch(`https://tempo.test${path}`, { headers: auth(key) });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
    }
  });

  it("writes strength sets directly without replacing unrelated state", async () => {
    const { key } = await createArea();
    const bootstrap = await (await SELF.fetch("https://tempo.test/api/bootstrap", { headers: auth(key) })).json() as { revision: number };
    const habitResponse=await SELF.fetch("https://tempo.test/api/habits",{method:"PUT",headers:{...auth(key),"content-type":"application/json","If-Match":`"${bootstrap.revision}"`,Origin:"https://tempo.test"},body:JSON.stringify([{id:"habit",name:"Water",type:"counter",goal:8,color:"#123",days:[0,1,2,3,4,5,6]}])});
    const habitPayload=await habitResponse.json() as {revision:number};
    const strength={unit:"lb",workouts:[{id:"workout",name:"Push",exercises:[{id:"exercise",name:"Press",muscleGroup:"Chest",sets:3,reps:8,load:100}]}],mesocycles:[{id:"mesocycle",name:"Block",progressionRate:.025,workoutIds:["workout"],weeks:[{deload:false,completed:false}],sessions:[{id:"session",templateId:"workout",name:"Push",weekIndex:0,date:"2026-08-12",createdAt:1,status:"in-progress",unit:"lb",exercises:[{id:"session-exercise",exerciseId:"exercise",name:"Press",muscleGroup:"Chest",mode:"external",bodyweightFactor:1,allocations:[{name:"Chest",share:1}],sets:[]}]}]}],activeMesocycleId:"mesocycle"};
    const strengthResponse=await SELF.fetch("https://tempo.test/api/strength",{method:"PUT",headers:{...auth(key),"content-type":"application/json","If-Match":`"${habitPayload.revision}"`,Origin:"https://tempo.test"},body:JSON.stringify(strength)});
    expect(strengthResponse.status,await strengthResponse.clone().text()).toBe(200);
    const strengthPayload=await strengthResponse.json() as {data:any;revision:number};
    const exerciseId=strengthPayload.data.mesocycles[0].sessions[0].exercises[0].id;
    const created=await SELF.fetch(`https://tempo.test/api/strength/session-exercises/${exerciseId}/sets`,{method:"POST",headers:{...auth(key),"content-type":"application/json","If-Match":`"${strengthPayload.revision}"`,Origin:"https://tempo.test"},body:JSON.stringify({reps:8,load:100,completed:false,sortOrder:0})});
    expect(created.status,await created.clone().text()).toBe(201);
    const createdPayload=await created.json() as {data:{id:number};revision:number};
    const updated=await SELF.fetch(`https://tempo.test/api/strength/sets/${createdPayload.data.id}`,{method:"PUT",headers:{...auth(key),"content-type":"application/json","If-Match":`"${createdPayload.revision}"`,Origin:"https://tempo.test"},body:JSON.stringify({reps:10,load:105,completed:true})});
    expect(updated.status).toBe(200);
    const updatedPayload=await updated.json() as {revision:number};
    const loaded=await (await SELF.fetch("https://tempo.test/api/strength",{headers:auth(key)})).json() as {data:any};
    expect(loaded.data.mesocycles[0].sessions[0].exercises[0].sets).toEqual([{id:createdPayload.data.id,reps:10,load:105,completed:true}]);
    expect(((await (await SELF.fetch("https://tempo.test/api/habits",{headers:auth(key)})).json()) as any).data).toHaveLength(1);
    const removed=await SELF.fetch(`https://tempo.test/api/strength/sets/${createdPayload.data.id}`,{method:"DELETE",headers:{...auth(key),"If-Match":`"${updatedPayload.revision}"`,Origin:"https://tempo.test"}});
    expect(removed.status).toBe(200);
  });

  it("recovers a write lock left behind by an interrupted request", async () => {
    const { key } = await createArea();
    const hash = await sha256(key);
    const initial = await getState(key);
    await env.DB.prepare("UPDATE spaces SET write_token='interrupted',write_token_at=0 WHERE access_key_hash=?").bind(hash).run();
    const saved = await SELF.fetch("https://tempo.test/api/state", {
      method: "PUT",
      headers: { ...auth(key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" },
      body: JSON.stringify(initial.data)
    });
    expect(saved.status, await saved.text()).toBe(200);
    expect(await env.DB.prepare("SELECT write_token,write_token_at FROM spaces WHERE access_key_hash=?").bind(hash).first()).toEqual({ write_token: "", write_token_at: null });
  });

  it("does not let a concurrent stale replacement alter the winner", async () => {
    const { key } = await createArea();
    const initial = await getState(key);
    const save = (name: string) => SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" }, body: JSON.stringify({ ...initial.data, timers: [{ id: name, name }] }) });
    const responses = await Promise.all([save("Alpha"), save("Beta")]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 412]);
    const winner = await responses.find(response => response.status === 200)!.json() as { data: { timers: Array<{ name: string }> } };
    const final = await (await SELF.fetch("https://tempo.test/api/state", { headers: auth(key) })).json() as { data: { timers: Array<{ name: string }> } };
    expect(final.data.timers[0].name).toBe(winner.data.timers[0].name);
  });

  it("adds a meal from a persisted food selected through a string-valued form control", async () => {
    const { key } = await createArea();
    const initial = await getState(key);
    const withFood = { ...initial.data, foods: [{ id: "new-food", title: "Oats", servingSize: 40, servingUnit: "g", calories: 150, carbs: 27, protein: 5, fats: 3, fibre: 4 }] };
    const foodSave = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": `"${initial.revision}"`, Origin: "https://tempo.test" }, body: JSON.stringify(withFood) });
    expect(foodSave.status, await foodSave.clone().text()).toBe(200);
    const persisted = await foodSave.json() as { data: any; revision: number };
    const foodId = persisted.data.foods[0].id;
    const withMeal = { ...persisted.data, meals: [{ id: "new-meal", title: "Breakfast", items: [{ foodId: String(foodId), servingSize: 80 }] }] };
    const mealSave = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": `"${persisted.revision}"`, Origin: "https://tempo.test" }, body: JSON.stringify(withMeal) });
    expect(mealSave.status, await mealSave.clone().text()).toBe(200);
    expect(await mealSave.json()).toMatchObject({ data: { meals: [{ title: "Breakfast", items: [{ foodId, servingSize: 80 }] }] } });
  });

  it("remaps an exported space's numeric IDs when importing into another space", async () => {
    const source = await createArea();
    const sourceInitial = await getState(source.key);
    const sourceState = { ...sourceInitial.data,
      timers: [{ id: "timer", name: "Imported timer", duration: 60, remaining: 60, color: "#111", running: false, lastTick: null }],
      foods: [{ id: "food", title: "Imported food", servingSize: 1, servingUnit: "g", calories: 1, carbs: 1, protein: 0, fats: 0, fibre: 0 }],
      meals: [{ id: "meal", title: "Imported meal", items: [{ foodId: "food", servingSize: 2 }] }],
      logs: {}
    };
    const sourceSaved = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(source.key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" }, body: JSON.stringify(sourceState) });
    expect(sourceSaved.status, await sourceSaved.text()).toBe(200);
    const exported = await (await SELF.fetch("https://tempo.test/api/state", { headers: auth(source.key) })).json() as { data: any };
    const target = await createArea();
    const imported = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(target.key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" }, body: JSON.stringify(exported.data) });
    expect(imported.status, await imported.text()).toBe(200);
    const targetState = await (await SELF.fetch("https://tempo.test/api/state", { headers: auth(target.key) })).json() as { data: any };
    expect(targetState.data.timers[0].id).not.toBe(exported.data.timers[0].id);
    expect(targetState.data.foods[0].id).not.toBe(exported.data.foods[0].id);
    expect(targetState.data.meals[0].items[0].foodId).toBe(targetState.data.foods[0].id);
    expect(targetState.data.logs).toEqual({});
  });

  it("round-trips the complete v14 model through normalized rows", async () => {
    const { key } = await createArea();
    const state = {
      schemaVersion: 14,
      timers: [{ id: "timer", name: "Focus", duration: 1500, remaining: 240, color: "#111", running: false, lastTick: null, pomodoro: true, restDuration: 300, phase: "rest", countdownBeeps: true, trackCompletions: true, dailyTarget: 4, completedToday: 2, completionDate: "2026-08-12" }],
      widgets: [{ id: "habit", name: "Water", type: "counter", goal: 8, color: "#222", days: [0, 1, 2, 3, 4, 5, 6] }],
      logs: { "2026-08-07": { habit: { name: "Water", color: "#222", type: "counter", goal: 8, value: 3, done: false } } },
      foods: [{ id: "food", title: "Oats", servingSize: 40, servingUnit: "g", calories: 150, carbs: 27, protein: 5, fats: 3, fibre: 4 }],
      meals: [{ id: "meal", title: "Breakfast", items: [{ foodId: "food", servingSize: 80 }] }],
      foodLogs: { "2026-08-07": [{ id: "entry", foodId: "food", mealId: "meal", servingSize: 40, loggedAt: 123, batchId: "batch", mealTitle: "Breakfast", snapshot: { title: "Oats", servingSize: 40, servingUnit: "g", calories: 150, carbs: 27, protein: 5, fats: 3, fibre: 4 } }] },
      nutritionGoal: { calories: 2200, carbs: 250, protein: 160, fats: 70, fibre: 30 }, recentFoodIds: [], recentMealIds: [],
      strength: { unit: "lb", activeMesocycleId: "meso", workouts: [{ id: "workout", name: "Upper", exercises: [{ id: "template-exercise", name: "Press", muscleGroup: "Chest", sets: 3, reps: 8, load: 100 }] }], mesocycles: [{ id: "meso", name: "Block", progressionRate: .025, archived: false, workoutIds: ["workout"], weeks: [{ deload: false, completed: false }], sessions: [{ id: "session", templateId: "workout", name: "Upper", weekIndex: 0, date: "2026-08-07", createdAt: 123, status: "completed", unit: "lb", exercises: [{ id: "session-exercise", exerciseId: "template-exercise", name: "Press", muscleGroup: "Chest", mode: "external", bodyweightFactor: 1, allocations: [{ muscleId: "chest", name: "Chest", share: 1 }], sets: [{ id: "set", reps: 8, load: 100, completed: true }] }] }] }] },
      legacyDefaultsRemoved: true
    };
    const saved = await SELF.fetch("https://tempo.test/api/state", { method: "PUT", headers: { ...auth(key), "content-type": "application/json", "If-Match": '"0"', Origin: "https://tempo.test" }, body: JSON.stringify(state) });
    expect(saved.status, await saved.text()).toBe(200);
    const loaded = await (await SELF.fetch("https://tempo.test/api/state", { headers: auth(key) })).json() as { data: any };
    const timerId = loaded.data.timers[0].id; const habitId = loaded.data.widgets[0].id;
    const foodId = loaded.data.foods[0].id; const mealId = loaded.data.meals[0].id;
    expect(timerId).toEqual(expect.any(Number));
    expect(loaded.data.timers[0]).toMatchObject({ remaining: 240, pomodoro: true, restDuration: 300, phase: "rest", countdownBeeps: true, trackCompletions: true, dailyTarget: 4, completedToday: 2, completionDate: "2026-08-12" });
    expect(loaded.data.timers[0]).not.toHaveProperty("days");
    expect(loaded.data.logs["2026-08-07"][`habit:${habitId}`]).toMatchObject({ value: 3, goal: 8 });
    expect(loaded.data.meals[0].items[0]).toEqual({ foodId, servingSize: 80 });
    expect(loaded.data.foodLogs["2026-08-07"][0]).toMatchObject({ foodId, mealId });
    expect(loaded.data.recentFoodIds).toEqual([]);
    expect(loaded.data.recentMealIds).toEqual([String(mealId)]);
    const foodLogSection = await (await SELF.fetch("https://tempo.test/api/food-logs", { headers: auth(key) })).json() as { data: any };
    expect(foodLogSection.data.recentFoodIds).toEqual([]);
    expect(foodLogSection.data.recentMealIds).toEqual([String(mealId)]);
    expect(loaded.data.strength.mesocycles[0].sessions[0].exercises[0].allocations[0]).toEqual({ muscleId: "chest", name: "Chest", share: 1 });
    expect(loaded.data.strength.mesocycles[0].sessions[0].exercises[0].sets[0]).toMatchObject({ id: expect.any(Number), completed: true });
  });
});
