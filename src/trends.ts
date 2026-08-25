import { readFinances } from "./finances";

type Row = Record<string, unknown>;
type TrendPoint = { date: string; [key: string]: unknown };
type TrendSeries = Record<string, TrendPoint[]>;

const TREND_SCHEMA_VERSION = 1;
const SERIES = ["marketValue", "restingHeartRate", "steps", "sleep", "nutrition", "volume"] as const;

function rows(result: D1Result): Row[] { return result.results as Row[]; }
function pointMap(series: TrendSeries) {
  const map = new Map<string, string>();
  for (const [name, points] of Object.entries(series)) {
    for (const point of points) map.set(`${name}\n${point.date}`, JSON.stringify(point));
  }
  return map;
}

async function readTrendSnapshot(db: D1Database, spaceId: number) {
  const [finances, resting, steps, sleep, nutrition, volume, holdings, preference] = await Promise.all([
    readFinances(db, spaceId, Date.now(), null),
    db.prepare("SELECT recorded_date,beats_per_minute FROM cardio_resting_heart_rates WHERE space_id=? ORDER BY recorded_date").bind(spaceId).all<Row>(),
    db.prepare("SELECT recorded_date,step_count FROM cardio_daily_steps WHERE space_id=? ORDER BY recorded_date").bind(spaceId).all<Row>(),
    db.prepare("SELECT sleep_date,SUM(minutes_asleep) AS minutes_asleep FROM sleep_sessions WHERE space_id=? AND is_nap=0 GROUP BY sleep_date ORDER BY sleep_date").bind(spaceId).all<Row>(),
    db.prepare(`SELECT log_date,
      SUM(calories_snapshot*serving_size/serving_size_snapshot) AS calories,
      SUM(carbs_snapshot*serving_size/serving_size_snapshot) AS carbs,
      SUM(protein_snapshot*serving_size/serving_size_snapshot) AS protein,
      SUM(fats_snapshot*serving_size/serving_size_snapshot) AS fats,
      SUM(fibre_snapshot*serving_size/serving_size_snapshot) AS fibre
      FROM food_log_entries WHERE space_id=? GROUP BY log_date ORDER BY log_date`).bind(spaceId).all<Row>(),
    db.prepare(`SELECT date(session.session_date,printf('-%d days',CAST(strftime('%w',session.session_date) AS INTEGER))) AS week_date,
      COALESCE(allocation.name_snapshot,exercise.muscle_group_snapshot,'Other') AS muscle_name,
      SUM(sets.reps*sets.load*COALESCE(allocation.share,1)) AS volume
      FROM workout_sessions session
      JOIN session_exercises exercise ON exercise.space_id=session.space_id AND exercise.session_id=session.id
      JOIN exercise_sets sets ON sets.space_id=exercise.space_id AND sets.session_exercise_id=exercise.id AND sets.completed=1
      LEFT JOIN session_exercise_allocations allocation ON allocation.space_id=exercise.space_id AND allocation.session_exercise_id=exercise.id
      WHERE session.space_id=?
      GROUP BY week_date,muscle_name ORDER BY week_date,muscle_name`).bind(spaceId).all<Row>(),
    db.prepare("SELECT asset_type,symbol,native_currency,display_name,quantity FROM finance_holdings WHERE space_id=? ORDER BY id").bind(spaceId).all<Row>(),
    db.prepare("SELECT finance_display_currency FROM spaces WHERE id=?").bind(spaceId).first<Row>()
  ]);

  const volumeByWeek = new Map<string, Record<string, number>>();
  const muscleNames = new Map<string, string>();
  for (const row of rows(volume)) {
    const date = String(row.week_date), name = String(row.muscle_name || "Other").trim() || "Other", id = name.toLocaleLowerCase();
    muscleNames.set(id, name);
    const totals = volumeByWeek.get(date) || {};
    totals[id] = (totals[id] || 0) + Number(row.volume || 0);
    volumeByWeek.set(date, totals);
  }

  const series: TrendSeries = {
    marketValue: (finances.marketValueHistory || []).map(point => ({ date: point.date, value: point.value })),
    restingHeartRate: rows(resting).map(row => ({ date: String(row.recorded_date), value: Number(row.beats_per_minute) })),
    steps: rows(steps).map(row => ({ date: String(row.recorded_date), value: Number(row.step_count) })),
    sleep: rows(sleep).map(row => ({ date: String(row.sleep_date), value: Number(row.minutes_asleep) })),
    nutrition: rows(nutrition).map(row => ({ date: String(row.log_date), calories: Number(row.calories), carbs: Number(row.carbs), protein: Number(row.protein), fats: Number(row.fats), fibre: Number(row.fibre) })),
    volume: [...volumeByWeek].map(([date, totals]) => ({ date, totals }))
  };
  const currency = String(preference?.finance_display_currency || finances.currency || "CAD");
  const meta = {
    schemaVersion: TREND_SCHEMA_VERSION,
    currency,
    hasHoldings: rows(holdings).length > 0,
    muscles: [...muscleNames].sort((left, right) => left[1].localeCompare(right[1])).map(([id, name]) => ({ id, name }))
  };
  const fingerprint = JSON.stringify({ schemaVersion: TREND_SCHEMA_VERSION, currency, holdings: rows(holdings) });
  return { series, meta, fingerprint };
}

interface TrendStateRow { cursor: number; reset_cursor: number; fingerprint: string; meta_json: string }

function fullChanges(series: TrendSeries) {
  return Object.fromEntries(SERIES.map(name => [name, series[name] || []]));
}

export async function readTrendDelta(db: D1Database, spaceId: number, requestedCursor: number | null) {
  const snapshot = await readTrendSnapshot(db, spaceId);
  let state = await db.prepare("SELECT cursor,reset_cursor,fingerprint,meta_json FROM trend_sync_state WHERE space_id=?")
    .bind(spaceId).first<TrendStateRow>();
  const current = pointMap(snapshot.series);

  if (!state || state.fingerprint !== snapshot.fingerprint) {
    const cursor = Number(state?.cursor || 0) + 1;
    const statements = [
      db.prepare("DELETE FROM trend_change_log WHERE space_id=?").bind(spaceId),
      db.prepare("DELETE FROM trend_points WHERE space_id=?").bind(spaceId),
      db.prepare(`INSERT INTO trend_sync_state(space_id,cursor,reset_cursor,fingerprint,meta_json) VALUES(?,?,?,?,?)
        ON CONFLICT(space_id) DO UPDATE SET cursor=excluded.cursor,reset_cursor=excluded.reset_cursor,fingerprint=excluded.fingerprint,meta_json=excluded.meta_json`)
        .bind(spaceId, cursor, cursor, snapshot.fingerprint, JSON.stringify(snapshot.meta))
    ];
    for (const [key, value] of current) {
      const [series, date] = key.split("\n");
      statements.push(db.prepare("INSERT INTO trend_points(space_id,series,point_date,value_json,updated_cursor) VALUES(?,?,?,?,?)").bind(spaceId, series, date, value, cursor));
    }
    await db.batch(statements);
    return { cursor, reset: true, changes: fullChanges(snapshot.series), deleted: {}, meta: snapshot.meta };
  }

  const storedResult = await db.prepare("SELECT series,point_date,value_json FROM trend_points WHERE space_id=?").bind(spaceId).all<Row>();
  const stored = new Map(rows(storedResult).map(row => [`${row.series}\n${row.point_date}`, String(row.value_json)]));
  const upserts = [...current].filter(([key, value]) => stored.get(key) !== value);
  const removals = [...stored.keys()].filter(key => !current.has(key));
  if (upserts.length || removals.length) {
    const cursor = Number(state.cursor) + 1;
    const statements = [db.prepare("UPDATE trend_sync_state SET cursor=?,meta_json=? WHERE space_id=?").bind(cursor, JSON.stringify(snapshot.meta), spaceId)];
    for (const [key, value] of upserts) {
      const [series, date] = key.split("\n");
      statements.push(
        db.prepare(`INSERT INTO trend_points(space_id,series,point_date,value_json,updated_cursor) VALUES(?,?,?,?,?)
          ON CONFLICT(space_id,series,point_date) DO UPDATE SET value_json=excluded.value_json,updated_cursor=excluded.updated_cursor`).bind(spaceId, series, date, value, cursor),
        db.prepare("INSERT INTO trend_change_log(space_id,cursor,series,point_date,operation,value_json) VALUES(?,?,?,?,'upsert',?)").bind(spaceId, cursor, series, date, value)
      );
    }
    for (const key of removals) {
      const [series, date] = key.split("\n");
      statements.push(
        db.prepare("DELETE FROM trend_points WHERE space_id=? AND series=? AND point_date=?").bind(spaceId, series, date),
        db.prepare("INSERT INTO trend_change_log(space_id,cursor,series,point_date,operation,value_json) VALUES(?,?,?,?,'delete',NULL)").bind(spaceId, cursor, series, date)
      );
    }
    await db.batch(statements);
    state = { ...state, cursor, meta_json: JSON.stringify(snapshot.meta) };
  } else if (state.meta_json !== JSON.stringify(snapshot.meta)) {
    await db.prepare("UPDATE trend_sync_state SET meta_json=? WHERE space_id=?").bind(JSON.stringify(snapshot.meta), spaceId).run();
  }

  const cursor = Number(state.cursor);
  if (requestedCursor === null || requestedCursor > cursor || requestedCursor < Number(state.reset_cursor)) {
    return { cursor, reset: true, changes: fullChanges(snapshot.series), deleted: {}, meta: snapshot.meta };
  }
  const logResult = await db.prepare("SELECT series,point_date,operation,value_json FROM trend_change_log WHERE space_id=? AND cursor>? ORDER BY cursor,series,point_date")
    .bind(spaceId, requestedCursor).all<Row>();
  const changes: Record<string, TrendPoint[]> = {};
  const deleted: Record<string, string[]> = {};
  for (const row of rows(logResult)) {
    const series = String(row.series), date = String(row.point_date);
    if (row.operation === "delete") {
      if (changes[series]) changes[series] = changes[series].filter(item => item.date !== date);
      const list = deleted[series] ||= [];
      if (!list.includes(date)) list.push(date);
    }
    else {
      const point = JSON.parse(String(row.value_json)) as TrendPoint;
      const list = changes[series] ||= [];
      const previous = list.findIndex(item => item.date === date);
      if (previous >= 0) list.splice(previous, 1);
      list.push(point);
      if (deleted[series]) deleted[series] = deleted[series].filter(item => item !== date);
    }
  }
  return { cursor, reset: false, changes, deleted, meta: snapshot.meta };
}
