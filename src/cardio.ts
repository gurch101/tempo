type Row = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function sessionFromRow(row: Row) {
  return {
    id: Number(row.id),
    displayName: String(row.display_name),
    startTime: Number(row.start_time),
    endTime: Number(row.end_time),
    activeDurationSeconds: Number(row.active_duration_seconds),
    averageHeartRate: numberOrNull(row.average_heart_rate),
    minimumHeartRate: numberOrNull(row.minimum_heart_rate),
    maximumHeartRate: numberOrNull(row.maximum_heart_rate),
    caloriesKcal: numberOrNull(row.calories_kcal),
    distanceMeters: numberOrNull(row.distance_meters),
    steps: numberOrNull(row.steps),
    zones: {
      light: Number(row.light_zone_seconds) || 0,
      moderate: Number(row.moderate_zone_seconds) || 0,
      vigorous: Number(row.vigorous_zone_seconds) || 0,
      peak: Number(row.peak_zone_seconds) || 0
    }
  };
}

export async function readCardio(db: D1Database, spaceId: number, configured: boolean) {
  const [connection, restingResult, stepsResult, hourlyStepsResult, zone2Result, sessionsResult, preferences] = await Promise.all([
    db.prepare("SELECT connected_at,sync_started_at,sync_kind,cardio_last_sync_at,cardio_last_sync_error FROM google_health_connections WHERE space_id=?").bind(spaceId).first<Row>(),
    db.prepare("SELECT recorded_date,beats_per_minute FROM cardio_resting_heart_rates WHERE space_id=? ORDER BY recorded_date").bind(spaceId).all<Row>(),
    db.prepare("SELECT recorded_date,step_count FROM cardio_daily_steps WHERE space_id=? ORDER BY recorded_date").bind(spaceId).all<Row>(),
    db.prepare("SELECT hour_start,step_count FROM cardio_hourly_steps WHERE space_id=? ORDER BY hour_start").bind(spaceId).all<Row>(),
    db.prepare("SELECT recorded_date,moderate_seconds FROM cardio_daily_zone2 WHERE space_id=? ORDER BY recorded_date").bind(spaceId).all<Row>(),
    db.prepare("SELECT id,display_name,start_time,end_time,active_duration_seconds,average_heart_rate,minimum_heart_rate,maximum_heart_rate,calories_kcal,distance_meters,steps,light_zone_seconds,moderate_zone_seconds,vigorous_zone_seconds,peak_zone_seconds FROM cardio_sessions WHERE space_id=? ORDER BY start_time DESC").bind(spaceId).all<Row>(),
    db.prepare("SELECT cardio_zone2_goal_minutes,cardio_daily_steps_goal FROM spaces WHERE id=?").bind(spaceId).first<Row>()
  ]);
  return {
    connection: {
      configured,
      connected: Boolean(connection),
      connectedAt: numberOrNull(connection?.connected_at),
      lastSyncAt: numberOrNull(connection?.cardio_last_sync_at),
      syncing: connection?.sync_started_at != null && connection?.sync_kind === "cardio",
      busy: connection?.sync_started_at != null,
      lastError: connection?.cardio_last_sync_error == null ? null : String(connection.cardio_last_sync_error)
    },
    restingHeartRates: (restingResult.results || []).map(row => ({
      date: String(row.recorded_date),
      beatsPerMinute: Number(row.beats_per_minute)
    })),
    dailySteps: (stepsResult.results || []).map(row => ({
      date: String(row.recorded_date),
      count: Number(row.step_count)
    })),
    hourlySteps: (hourlyStepsResult.results || []).map(row => ({
      startTime: Number(row.hour_start),
      count: Number(row.step_count)
    })),
    dailyZone2: (zone2Result.results || []).map(row => ({
      date: String(row.recorded_date),
      moderateSeconds: Number(row.moderate_seconds)
    })),
    zone2GoalMinutes: numberOrNull(preferences?.cardio_zone2_goal_minutes),
    dailyStepsGoal: numberOrNull(preferences?.cardio_daily_steps_goal),
    sessions: (sessionsResult.results || []).map(sessionFromRow)
  };
}

export async function readCardioSession(db: D1Database, spaceId: number, sessionId: number) {
  const [session, chunks] = await Promise.all([
    db.prepare("SELECT id,display_name,start_time,end_time,active_duration_seconds,average_heart_rate,minimum_heart_rate,maximum_heart_rate,calories_kcal,distance_meters,steps,light_zone_seconds,moderate_zone_seconds,vigorous_zone_seconds,peak_zone_seconds FROM cardio_sessions WHERE id=? AND space_id=?").bind(sessionId, spaceId).first<Row>(),
    db.prepare("SELECT samples_json FROM cardio_heart_rate_chunks WHERE session_id=? AND space_id=? ORDER BY chunk_index").bind(sessionId, spaceId).all<{ samples_json: string }>()
  ]);
  if (!session) return null;
  const samples = (chunks.results || []).flatMap(chunk => {
    try {
      const parsed = JSON.parse(chunk.samples_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  return { ...sessionFromRow(session), samples };
}
