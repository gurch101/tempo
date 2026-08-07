import { localDateInfo } from "./time";

type Row = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function dateOffset(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function readSleep(db: D1Database, spaceId: number, configured: boolean, now = Date.now()) {
  const preferences = await db.prepare("SELECT timezone,sleep_goal_minutes,sleep_goal_start_time FROM spaces WHERE id=?").bind(spaceId).first<Row>();
  const firstHeatmapDate = dateOffset(localDateInfo(now, String(preferences?.timezone || "UTC")).date, -6);
  const [connection, sessionsResult, stagesResult] = await Promise.all([
    db.prepare("SELECT connected_at,sync_started_at,sync_kind,sleep_last_sync_at,sleep_last_sync_error,granted_scopes FROM google_health_connections WHERE space_id=?").bind(spaceId).first<Row>(),
    db.prepare("SELECT id,sleep_date,start_time,end_time,minutes_asleep,is_nap FROM sleep_sessions WHERE space_id=? ORDER BY sleep_date,start_time,id").bind(spaceId).all<Row>(),
    db.prepare(`SELECT stage.session_id,stage.stage_type,stage.start_time,stage.end_time
      FROM sleep_sessions session INDEXED BY idx_sleep_sessions_space_order
      JOIN sleep_stages stage ON stage.space_id=session.space_id AND stage.session_id=session.id
      WHERE session.space_id=? AND session.sleep_date>=?
      ORDER BY stage.session_id,stage.sort_order`).bind(spaceId, firstHeatmapDate).all<Row>()
  ]);
  const stagesBySession = new Map<number, Array<{ type: string; startTime: number; endTime: number }>>();
  for (const row of stagesResult.results || []) {
    const sessionId = Number(row.session_id);
    const stages = stagesBySession.get(sessionId) || [];
    stages.push({ type: String(row.stage_type), startTime: Number(row.start_time), endTime: Number(row.end_time) });
    stagesBySession.set(sessionId, stages);
  }
  const grantedScopes = String(connection?.granted_scopes || "");
  return {
    connection: {
      configured,
      connected: Boolean(connection),
      sleepAuthorized: grantedScopes.split(/\s+/).some(scope => scope.endsWith("/auth/googlehealth.sleep.readonly")),
      connectedAt: numberOrNull(connection?.connected_at),
      lastSyncAt: numberOrNull(connection?.sleep_last_sync_at),
      syncing: connection?.sync_started_at != null && connection?.sync_kind === "sleep",
      busy: connection?.sync_started_at != null,
      lastError: connection?.sleep_last_sync_error == null ? null : String(connection.sleep_last_sync_error)
    },
    goal: preferences?.sleep_goal_minutes == null || preferences?.sleep_goal_start_time == null ? null : {
      minutes: Number(preferences.sleep_goal_minutes),
      startTime: String(preferences.sleep_goal_start_time)
    },
    sessions: (sessionsResult.results || []).map(row => ({
      id: Number(row.id),
      date: String(row.sleep_date),
      startTime: Number(row.start_time),
      endTime: Number(row.end_time),
      minutesAsleep: Number(row.minutes_asleep),
      nap: Boolean(row.is_nap),
      stages: stagesBySession.get(Number(row.id)) || []
    }))
  };
}
