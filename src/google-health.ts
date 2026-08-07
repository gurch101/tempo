const HEALTH_API_ROOT = "https://health.googleapis.com/v4/users/me/dataTypes";
export const GOOGLE_HEALTH_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly"
];

type Fetcher = typeof fetch;
type UnknownRecord = Record<string, unknown>;

export interface GoogleHealthConfig {
  clientId: string;
  clientSecret: string;
}

export interface RestingHeartRateImport {
  date: string;
  beatsPerMinute: number;
  calculationMethod: string;
}

export interface DailyStepsImport {
  date: string;
  count: number;
}

export interface HourlyStepsImport {
  startTime: number;
  count: number;
}

export interface DailyZone2Import {
  date: string;
  moderateSeconds: number;
}

export interface HeartRateSampleImport {
  at: number;
  bpm: number;
  motionContext: string;
  sensorLocation: string;
}

export interface CardioSessionImport {
  googleName: string;
  exerciseType: string;
  displayName: string;
  startTime: number;
  endTime: number;
  startUtcOffset: string;
  endUtcOffset: string;
  activeDurationSeconds: number;
  averageHeartRate: number | null;
  minimumHeartRate: number | null;
  maximumHeartRate: number | null;
  caloriesKcal: number | null;
  distanceMeters: number | null;
  steps: number | null;
  lightZoneSeconds: number;
  moderateZoneSeconds: number;
  vigorousZoneSeconds: number;
  peakZoneSeconds: number;
  googleUpdatedAt: number | null;
  samples: HeartRateSampleImport[] | null;
}

export interface SleepStageImport {
  type: string;
  startTime: number;
  endTime: number;
}

export interface SleepSessionImport {
  googleName: string;
  date: string;
  type: string;
  startTime: number;
  endTime: number;
  startUtcOffset: string;
  endUtcOffset: string;
  minutesAsleep: number;
  minutesAwake: number;
  nap: boolean;
  googleUpdatedAt: number | null;
  stages: SleepStageImport[];
}

interface GoogleListResponse {
  dataPoints?: UnknownRecord[];
  nextPageToken?: string;
}

interface GoogleDailyRollupResponse {
  rollupDataPoints?: UnknownRecord[];
  nextPageToken?: string;
}

interface ExistingSessionRow {
  google_data_point_name: string;
  google_updated_at: number | null;
  heart_rate_synced_at: number | null;
  minimum_heart_rate: number | null;
  maximum_heart_rate: number | null;
}

interface ExistingSleepSessionRow {
  google_data_point_name: string;
  google_updated_at: number | null;
}

function syncWindow(now:number,lastSync?:number|null){
  const end=new Date(now);end.setUTCHours(0,0,0,0);end.setUTCDate(end.getUTCDate()+1);
  const earliest=new Date(end);earliest.setUTCDate(earliest.getUTCDate()-367);
  const last=Number(lastSync),start=Number.isFinite(last)&&last>0?new Date(last):earliest;
  start.setUTCHours(0,0,0,0);if(start<earliest)start.setTime(earliest.getTime());if(start>end)start.setTime(end.getTime()-86400000);
  return{startMs:start.getTime(),endMs:end.getTime(),startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),startIso:start.toISOString(),endIso:end.toISOString(),incremental:Number.isFinite(last)&&last>0};
}

export class GoogleHealthApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? Math.round(parsed) : null;
}

export function parseGoogleDuration(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?s$/.test(value)) return 0;
  const parsed = Number(value.slice(0, -1));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function googleDate(value: unknown): string | null {
  const date = record(value);
  const year = finiteNumber(date.year), month = finiteNumber(date.month), day = finiteNumber(date.day);
  if (!year || !month || !day) return null;
  const result = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

export function parseRestingHeartRatePoint(point: unknown): RestingHeartRateImport | null {
  const data = record(record(point).dailyRestingHeartRate);
  const date = googleDate(data.date);
  const beatsPerMinute = positiveInteger(data.beatsPerMinute);
  if (!date || !beatsPerMinute) return null;
  return {
    date,
    beatsPerMinute,
    calculationMethod: String(record(data.dailyRestingHeartRateMetadata).calculationMethod || "CALCULATION_METHOD_UNSPECIFIED")
  };
}

export function parseDailyStepsRollupPoint(point: unknown): DailyStepsImport | null {
  const source = record(point);
  const date = googleDate(record(source.civilStartTime).date);
  const rawCount = finiteNumber(record(source.steps).countSum);
  if (!date || rawCount === null || rawCount < 0) return null;
  return { date, count: Math.round(rawCount) };
}

export function parseHourlyStepsRollupPoint(point: unknown): HourlyStepsImport | null {
  const source = record(point);
  const startTime = Date.parse(String(source.startTime || ""));
  const rawCount = finiteNumber(record(source.steps).countSum);
  if (!Number.isFinite(startTime) || rawCount === null || rawCount < 0) return null;
  return { startTime, count: Math.round(rawCount) };
}

export function parseDailyZone2RollupPoint(point: unknown): DailyZone2Import | null {
  const source = record(point);
  const date = googleDate(record(source.civilStartTime).date);
  if (!date) return null;
  const zones = record(source.timeInHeartRateZone).timeInHeartRateZones;
  const moderate = Array.isArray(zones)
    ? zones.find(zone => String(record(zone).heartRateZone) === "MODERATE")
    : null;
  return { date, moderateSeconds: parseGoogleDuration(record(moderate).duration) };
}

export function isTreadmillExercise(exerciseType: string): boolean {
  return ["TREADMILL", "TREADMILL_WALK", "INCLINE_RUN", "INCLINE_WALK"].includes(exerciseType);
}

export function parseExercisePoint(point: unknown): CardioSessionImport | null {
  const source = record(point);
  const exercise = record(source.exercise);
  const interval = record(exercise.interval);
  const metrics = record(exercise.metricsSummary);
  const zones = record(metrics.heartRateZoneDurations);
  const googleName = String(source.name || "");
  const exerciseType = String(exercise.exerciseType || "EXERCISE_TYPE_UNSPECIFIED");
  const startTime = Date.parse(String(interval.startTime || ""));
  const endTime = Date.parse(String(interval.endTime || ""));
  if (!googleName || !isTreadmillExercise(exerciseType) || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
  return {
    googleName,
    exerciseType,
    displayName: String(exercise.displayName || "Treadmill"),
    startTime,
    endTime,
    startUtcOffset: String(interval.startUtcOffset || "0s"),
    endUtcOffset: String(interval.endUtcOffset || "0s"),
    activeDurationSeconds: parseGoogleDuration(exercise.activeDuration) || Math.max(0, (endTime - startTime) / 1000),
    averageHeartRate: positiveInteger(metrics.averageHeartRateBeatsPerMinute),
    minimumHeartRate: null,
    maximumHeartRate: null,
    caloriesKcal: finiteNumber(metrics.caloriesKcal),
    distanceMeters: finiteNumber(metrics.distanceMillimeters) === null ? null : Math.max(0, finiteNumber(metrics.distanceMillimeters)! / 1000),
    steps: positiveInteger(metrics.steps) ?? (finiteNumber(metrics.steps) === 0 ? 0 : null),
    lightZoneSeconds: parseGoogleDuration(zones.lightTime),
    moderateZoneSeconds: parseGoogleDuration(zones.moderateTime),
    vigorousZoneSeconds: parseGoogleDuration(zones.vigorousTime),
    peakZoneSeconds: parseGoogleDuration(zones.peakTime),
    googleUpdatedAt: Number.isFinite(Date.parse(String(exercise.updateTime || ""))) ? Date.parse(String(exercise.updateTime)) : null,
    samples: null
  };
}

function exerciseCivilStartDate(session: CardioSessionImport): string {
  const match = session.startUtcOffset.match(/^-?\d+(?:\.\d+)?s$/);
  const parsedOffset = match ? Number(session.startUtcOffset.slice(0, -1)) : 0;
  const offsetSeconds = Number.isFinite(parsedOffset) ? parsedOffset : 0;
  return new Date(session.startTime + offsetSeconds * 1000).toISOString().slice(0, 10);
}

export function deduplicateTreadmillSessions(sessions: CardioSessionImport[]): CardioSessionImport[] {
  const candidates = sessions.map((session, index) => ({ session, index, date: exerciseCivilStartDate(session) }))
    .sort((left, right) => right.session.activeDurationSeconds - left.session.activeDurationSeconds
      || (right.session.endTime - right.session.startTime) - (left.session.endTime - left.session.startTime)
      || left.index - right.index);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    const duplicate = selected.some(existing => existing.date === candidate.date
      && Math.abs(existing.session.startTime - candidate.session.startTime) <= 5 * 60_000);
    if (!duplicate) selected.push(candidate);
  }
  return selected.sort((left, right) => left.index - right.index).map(candidate => candidate.session);
}

export function parseHeartRatePoint(point: unknown): HeartRateSampleImport | null {
  const heartRate = record(record(point).heartRate);
  const sampleTime = record(heartRate.sampleTime);
  const metadata = record(heartRate.metadata);
  const at = Date.parse(String(sampleTime.physicalTime || ""));
  const bpm = positiveInteger(heartRate.beatsPerMinute);
  if (!Number.isFinite(at) || !bpm) return null;
  return {
    at,
    bpm,
    motionContext: String(metadata.motionContext || "MOTION_CONTEXT_UNSPECIFIED"),
    sensorLocation: String(metadata.sensorLocation || "SENSOR_LOCATION_UNSPECIFIED")
  };
}

const SLEEP_STAGE_TYPES = new Set(["AWAKE", "LIGHT", "DEEP", "REM", "ASLEEP", "RESTLESS"]);

function civilDateKey(value: unknown): string | null {
  const civil = record(value);
  return googleDate(record(civil.date));
}

export function parseSleepPoint(point: unknown): SleepSessionImport | null {
  const source = record(point);
  const sleep = record(source.sleep);
  const interval = record(sleep.interval);
  const summary = record(sleep.summary);
  const metadata = record(sleep.metadata);
  const googleName = String(source.name || "");
  const startTime = Date.parse(String(interval.startTime || ""));
  const endTime = Date.parse(String(interval.endTime || ""));
  if (!googleName || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return null;
  const stages = (Array.isArray(sleep.stages) ? sleep.stages : []).map(value => {
    const stage = record(value);
    const stageStart = Date.parse(String(stage.startTime || ""));
    const stageEnd = Date.parse(String(stage.endTime || ""));
    const type = String(stage.type || "SLEEP_STAGE_TYPE_UNSPECIFIED");
    return Number.isFinite(stageStart) && Number.isFinite(stageEnd) && stageEnd > stageStart && SLEEP_STAGE_TYPES.has(type)
      ? { type, startTime: Math.max(startTime, stageStart), endTime: Math.min(endTime, stageEnd) }
      : null;
  }).filter((value): value is SleepStageImport => value !== null && value.endTime > value.startTime)
    .sort((left, right) => left.startTime - right.startTime);
  const summaryMinutes = finiteNumber(summary.minutesAsleep);
  const derivedMinutes = stages.reduce((total, stage) => total + (["LIGHT", "DEEP", "REM", "ASLEEP"].includes(stage.type) ? (stage.endTime - stage.startTime) / 60000 : 0), 0);
  const fallbackDate = new Date(endTime).toISOString().slice(0, 10);
  return {
    googleName,
    date: civilDateKey(interval.civilEndTime) || fallbackDate,
    type: String(sleep.type || "SLEEP_TYPE_UNSPECIFIED"),
    startTime,
    endTime,
    startUtcOffset: String(interval.startUtcOffset || "0s"),
    endUtcOffset: String(interval.endUtcOffset || "0s"),
    minutesAsleep: Math.max(0, Math.round(summaryMinutes ?? derivedMinutes)),
    minutesAwake: Math.max(0, Math.round(finiteNumber(summary.minutesAwake) ?? stages.reduce((total, stage) => total + (stage.type === "AWAKE" ? (stage.endTime - stage.startTime) / 60000 : 0), 0))),
    nap: metadata.nap === true,
    googleUpdatedAt: Number.isFinite(Date.parse(String(sleep.updateTime || ""))) ? Date.parse(String(sleep.updateTime)) : null,
    stages
  };
}

async function responseError(response: Response, fallback: string): Promise<GoogleHealthApiError> {
  const payload = await response.json().catch(() => ({})) as UnknownRecord;
  const nested = record(payload.error);
  const message = String(nested.message || payload.error_description || fallback);
  return new GoogleHealthApiError(message, response.status);
}

export async function exchangeAuthorizationCode(config: GoogleHealthConfig, code: string, redirectUri: string, fetcher: Fetcher = fetch): Promise<{ refreshToken: string; scope: string }> {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code" })
  });
  if (!response.ok) throw await responseError(response, "Google authorization could not be completed.");
  const payload = await response.json() as UnknownRecord;
  const refreshToken = String(payload.refresh_token || "");
  if (!refreshToken) throw new GoogleHealthApiError("Google did not return a refresh token. Reconnect and grant access again.");
  return { refreshToken, scope: String(payload.scope || GOOGLE_HEALTH_SCOPES.join(" ")) };
}

export async function refreshGoogleAccessToken(config: GoogleHealthConfig, refreshToken: string, fetcher: Fetcher = fetch): Promise<string> {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" })
  });
  if (!response.ok) throw await responseError(response, "Google Health access could not be refreshed.");
  const payload = await response.json() as UnknownRecord;
  const accessToken = String(payload.access_token || "");
  if (!accessToken) throw new GoogleHealthApiError("Google did not return an access token.");
  return accessToken;
}

export async function listGoogleDataPoints(accessToken: string, dataType: string, filter?: string, fetcher: Fetcher = fetch): Promise<UnknownRecord[]> {
  const points: UnknownRecord[] = [];
  let pageToken = "";
  for (let page = 0; page < 1000; page += 1) {
    const url = new URL(`${HEALTH_API_ROOT}/${dataType}/dataPoints`);
    url.searchParams.set("pageSize", dataType === "exercise" || dataType === "sleep" ? "25" : "10000");
    if (filter) url.searchParams.set("filter", filter);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!response.ok) throw await responseError(response, `Google Health could not return ${dataType} data.`);
    const payload = await response.json() as GoogleListResponse;
    points.push(...(Array.isArray(payload.dataPoints) ? payload.dataPoints : []));
    pageToken = String(payload.nextPageToken || "");
    if (!pageToken) return points;
  }
  throw new GoogleHealthApiError(`Google Health returned too many pages for ${dataType}.`);
}

export async function importGoogleSleepData(db: D1Database, spaceId: number, accessToken: string, now = Date.now(), fetcher: Fetcher = fetch, lastSync?:number|null): Promise<{ sleepSessions: number; sleepStages: number }> {
  const window=syncWindow(now,lastSync);
  const [points, existingResult] = await Promise.all([
    listGoogleDataPoints(accessToken,"sleep",`sleep.interval.end_time >= "${window.startIso}" AND sleep.interval.end_time < "${window.endIso}"`,fetcher),
    (window.incremental
      ?db.prepare("SELECT google_data_point_name,google_updated_at FROM sleep_sessions WHERE space_id=? AND end_time>=? AND end_time<?").bind(spaceId,window.startMs,window.endMs)
      :db.prepare("SELECT google_data_point_name,google_updated_at FROM sleep_sessions WHERE space_id=?").bind(spaceId)).all<ExistingSleepSessionRow>()
  ]);
  const sessions = Array.from(new Map(points.map(parseSleepPoint).filter((value): value is SleepSessionImport => value !== null).map(session => [session.googleName, session])).values());
  const existing = new Map((existingResult.results || []).map(row => [row.google_data_point_name, row]));
  const statements: D1PreparedStatement[] = [];
  for (const session of sessions) {
    const previous = existing.get(session.googleName);
    if (previous && previous.google_updated_at === session.googleUpdatedAt) continue;
    statements.push(previous
      ? db.prepare("UPDATE sleep_sessions SET sleep_date=?,start_time=?,end_time=?,minutes_asleep=?,is_nap=?,google_updated_at=?,synced_at=? WHERE space_id=? AND google_data_point_name=?")
        .bind(session.date, session.startTime, session.endTime, session.minutesAsleep, session.nap ? 1 : 0, session.googleUpdatedAt, now, spaceId, session.googleName)
      : db.prepare("INSERT INTO sleep_sessions (space_id,google_data_point_name,sleep_date,start_time,end_time,minutes_asleep,is_nap,google_updated_at,synced_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(spaceId, session.googleName, session.date, session.startTime, session.endTime, session.minutesAsleep, session.nap ? 1 : 0, session.googleUpdatedAt, now));
    if (previous) statements.push(db.prepare("DELETE FROM sleep_stages WHERE space_id=? AND session_id=(SELECT id FROM sleep_sessions WHERE space_id=? AND google_data_point_name=?)").bind(spaceId, spaceId, session.googleName));
    session.stages.forEach((stage, index) => statements.push(db.prepare(
      "INSERT INTO sleep_stages (space_id,session_id,stage_type,start_time,end_time,sort_order) VALUES (?,(SELECT id FROM sleep_sessions WHERE space_id=? AND google_data_point_name=?),?,?,?,?)"
    ).bind(spaceId, spaceId, session.googleName, stage.type, stage.startTime, stage.endTime, index)));
  }
  const returnedNames = new Set(sessions.map(session => session.googleName));
  for (const googleName of existing.keys()) if (!returnedNames.has(googleName)) {
    statements.push(db.prepare("DELETE FROM sleep_sessions WHERE space_id=? AND google_data_point_name=?").bind(spaceId, googleName));
  }
  for (let index = 0; index < statements.length; index += 100) await db.batch(statements.slice(index, index + 100));
  await db.prepare("UPDATE google_health_connections SET last_sync_at=?,sleep_last_sync_at=?,sync_started_at=NULL,sync_kind=NULL,last_sync_error=NULL,sleep_last_sync_error=NULL WHERE space_id=?").bind(now, now, spaceId).run();
  return { sleepSessions: sessions.length, sleepStages: sessions.reduce((total, session) => total + session.stages.length, 0) };
}

function civilDate(date: Date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export async function listGoogleDailySteps(accessToken: string, now = Date.now(), fetcher: Fetcher = fetch,lastSync?:number|null): Promise<UnknownRecord[]> {
  return listGoogleDailyRollup(accessToken, "steps", now, fetcher, lastSync, 7);
}

export async function listGoogleHourlySteps(accessToken: string, now = Date.now(), fetcher: Fetcher = fetch): Promise<UnknownRecord[]> {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() + 1);
  const start = new Date(end.getTime() - 8 * 86400000);
  const points: UnknownRecord[] = [];
  let pageToken = "";
  for (let page = 0; page < 1000; page += 1) {
    const response = await fetcher(`${HEALTH_API_ROOT}/steps/dataPoints:rollUp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        range: { startTime: start.toISOString(), endTime: end.toISOString() },
        windowSize: "3600s",
        pageSize: 8 * 24,
        ...(pageToken ? { pageToken } : {})
      })
    });
    if (!response.ok) throw await responseError(response, "Google Health could not return hourly steps data.");
    const payload = await response.json() as GoogleDailyRollupResponse;
    points.push(...(Array.isArray(payload.rollupDataPoints) ? payload.rollupDataPoints : []));
    pageToken = String(payload.nextPageToken || "");
    if (!pageToken) return points;
  }
  throw new GoogleHealthApiError("Google Health returned too many pages for hourly steps.");
}

export async function listGoogleDailyZone2(accessToken: string, now = Date.now(), fetcher: Fetcher = fetch,lastSync?:number|null): Promise<UnknownRecord[]> {
  return listGoogleDailyRollup(accessToken, "time-in-heart-rate-zone", now, fetcher, lastSync);
}

async function listGoogleDailyRollup(accessToken: string, dataType: "steps" | "time-in-heart-rate-zone", now = Date.now(), fetcher: Fetcher = fetch,lastSync?:number|null, historyDays?: number): Promise<UnknownRecord[]> {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = historyDays ? new Date(end.getTime() - historyDays * 86400000) : new Date(syncWindow(now,lastSync).startMs);
  const points: UnknownRecord[] = [];
  for (let chunkStart = new Date(start); chunkStart < end;) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 90);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    const chunkDays = Math.ceil((chunkEnd.getTime() - chunkStart.getTime()) / 86400000);
    let pageToken = "";
    for (let page = 0; page < 1000; page += 1) {
      const response = await fetcher(`${HEALTH_API_ROOT}/${dataType}/dataPoints:dailyRollUp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          range: {
            start: { date: civilDate(chunkStart), time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
            end: { date: civilDate(chunkEnd), time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } }
          },
          windowSizeDays: 1,
          pageSize: chunkDays,
          ...(pageToken ? { pageToken } : {})
        })
      });
      if (!response.ok) throw await responseError(response, `Google Health could not return daily ${dataType === "steps" ? "steps" : "heart-rate zone"} data.`);
      const payload = await response.json() as GoogleDailyRollupResponse;
      points.push(...(Array.isArray(payload.rollupDataPoints) ? payload.rollupDataPoints : []));
      pageToken = String(payload.nextPageToken || "");
      if (!pageToken) break;
      if (page === 999) throw new GoogleHealthApiError(`Google Health returned too many pages for daily ${dataType === "steps" ? "steps" : "heart-rate zones"}.`);
    }
    chunkStart = chunkEnd;
  }
  return points;
}

function heartRateFilter(session: CardioSessionImport): string {
  const start = new Date(session.startTime).toISOString();
  const end = new Date(session.endTime + 1).toISOString();
  return `heart_rate.sample_time.physical_time >= "${start}" AND heart_rate.sample_time.physical_time < "${end}"`;
}

function googleFailureMessage(value: PromiseRejectedResult, label: string): string {
  const message = value.reason instanceof Error ? value.reason.message : String(value.reason || "Request failed");
  return `${label}: ${message}`;
}

export async function importGoogleHealthData(db: D1Database, spaceId: number, accessToken: string, now = Date.now(), fetcher: Fetcher = fetch,lastSync?:number|null): Promise<{ restingHeartRates: number; dailySteps: number; hourlySteps: number; dailyZone2: number; sessions: number; heartRateSamples: number; warnings?: string[] }> {
  const window=syncWindow(now,lastSync);
  const [coreResults, existingResult, existingRestingResult, existingStepsResult, existingHourlyStepsResult, existingZone2Result, exclusionResult] = await Promise.all([
    Promise.allSettled([
      listGoogleDataPoints(accessToken,"daily-resting-heart-rate",`daily_resting_heart_rate.date >= "${window.startDate}" AND daily_resting_heart_rate.date < "${window.endDate}"`,fetcher),
      listGoogleDailySteps(accessToken,now,fetcher,lastSync),
      listGoogleHourlySteps(accessToken,now,fetcher),
      listGoogleDailyZone2(accessToken,now,fetcher,lastSync),
      listGoogleDataPoints(accessToken,"exercise",`exercise.interval.civil_start_time >= "${window.startDate}" AND exercise.interval.civil_start_time < "${window.endDate}"`,fetcher)
    ]),
    (window.incremental?db.prepare("SELECT google_data_point_name,google_updated_at,heart_rate_synced_at,minimum_heart_rate,maximum_heart_rate FROM cardio_sessions WHERE space_id=? AND start_time>=? AND start_time<?").bind(spaceId,window.startMs,window.endMs):db.prepare("SELECT google_data_point_name,google_updated_at,heart_rate_synced_at,minimum_heart_rate,maximum_heart_rate FROM cardio_sessions WHERE space_id=?").bind(spaceId)).all<ExistingSessionRow>(),
    (window.incremental?db.prepare("SELECT recorded_date,beats_per_minute FROM cardio_resting_heart_rates WHERE space_id=? AND recorded_date>=? AND recorded_date<?").bind(spaceId,window.startDate,window.endDate):db.prepare("SELECT recorded_date,beats_per_minute FROM cardio_resting_heart_rates WHERE space_id=?").bind(spaceId)).all<{ recorded_date: string; beats_per_minute: number }>(),
    db.prepare("SELECT recorded_date,step_count FROM cardio_daily_steps WHERE space_id=?").bind(spaceId).all<{ recorded_date: string; step_count: number }>(),
    db.prepare("SELECT hour_start,step_count FROM cardio_hourly_steps WHERE space_id=?").bind(spaceId).all<{ hour_start: number; step_count: number }>(),
    (window.incremental?db.prepare("SELECT recorded_date,moderate_seconds FROM cardio_daily_zone2 WHERE space_id=? AND recorded_date>=? AND recorded_date<?").bind(spaceId,window.startDate,window.endDate):db.prepare("SELECT recorded_date,moderate_seconds FROM cardio_daily_zone2 WHERE space_id=?").bind(spaceId)).all<{ recorded_date: string; moderate_seconds: number }>(),
    db.prepare("SELECT google_data_point_name FROM cardio_session_exclusions WHERE space_id=?").bind(spaceId).all<{ google_data_point_name: string }>()
  ]);
  const [restingResult, stepsResult, hourlyStepsResult, zone2Result, exerciseResult] = coreResults;
  const failedCoreRequests = [restingResult, stepsResult, hourlyStepsResult, zone2Result, exerciseResult].filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failedCoreRequests.length === 5) throw new GoogleHealthApiError(`Google Health could not return Cardio data. ${[
    googleFailureMessage(restingResult as PromiseRejectedResult, "Resting heart rate"),
    googleFailureMessage(stepsResult as PromiseRejectedResult, "Daily steps"),
    googleFailureMessage(hourlyStepsResult as PromiseRejectedResult, "Hourly steps"),
    googleFailureMessage(zone2Result as PromiseRejectedResult, "Heart-rate zones"),
    googleFailureMessage(exerciseResult as PromiseRejectedResult, "Treadmill sessions")
  ].join("; ")}`);
  const warnings = [
    ...(restingResult.status === "rejected" ? [googleFailureMessage(restingResult, "Resting heart rate")] : []),
    ...(stepsResult.status === "rejected" ? [googleFailureMessage(stepsResult, "Daily steps")] : []),
    ...(hourlyStepsResult.status === "rejected" ? [googleFailureMessage(hourlyStepsResult, "Hourly steps")] : []),
    ...(zone2Result.status === "rejected" ? [googleFailureMessage(zone2Result, "Heart-rate zones")] : []),
    ...(exerciseResult.status === "rejected" ? [googleFailureMessage(exerciseResult, "Treadmill sessions")] : [])
  ];
  const restingPoints = restingResult.status === "fulfilled" ? restingResult.value : [];
  const stepsPoints = stepsResult.status === "fulfilled" ? stepsResult.value : [];
  const hourlyStepsPoints = hourlyStepsResult.status === "fulfilled" ? hourlyStepsResult.value : [];
  const zone2Points = zone2Result.status === "fulfilled" ? zone2Result.value : [];
  const exercisePoints = exerciseResult.status === "fulfilled" ? exerciseResult.value : [];
  const resting = restingPoints.map(parseRestingHeartRatePoint).filter((value): value is RestingHeartRateImport => value !== null);
  const dailySteps = Array.from(new Map(stepsPoints.map(parseDailyStepsRollupPoint).filter((value): value is DailyStepsImport => value !== null).map(item => [item.date, item])).values());
  const hourlySteps = Array.from(new Map(hourlyStepsPoints.map(parseHourlyStepsRollupPoint).filter((value): value is HourlyStepsImport => value !== null).map(item => [item.startTime, item])).values());
  const dailyZone2 = Array.from(new Map(zone2Points.map(parseDailyZone2RollupPoint).filter((value): value is DailyZone2Import => value !== null).map(item => [item.date, item])).values());
  const excludedSessionNames = new Set((exclusionResult.results || []).map(row => row.google_data_point_name));
  const sessions = deduplicateTreadmillSessions(exercisePoints.map(parseExercisePoint).filter((value): value is CardioSessionImport => value !== null))
    .filter(session => !excludedSessionNames.has(session.googleName));
  const existing = new Map((existingResult.results || []).map(row => [row.google_data_point_name, row]));
  const existingResting = new Map((existingRestingResult.results || []).map(row => [row.recorded_date, Number(row.beats_per_minute)]));
  const existingSteps = new Map((existingStepsResult.results || []).map(row => [row.recorded_date, Number(row.step_count)]));
  const existingHourlySteps = new Map((existingHourlyStepsResult.results || []).map(row => [Number(row.hour_start), Number(row.step_count)]));
  const existingZone2 = new Map((existingZone2Result.results || []).map(row => [row.recorded_date, Number(row.moderate_seconds)]));

  let heartRateSampleCount = 0;
  for (const session of sessions) {
    const previous = existing.get(session.googleName);
    const unchanged = previous?.heart_rate_synced_at != null && previous.google_updated_at === session.googleUpdatedAt;
    if (unchanged) {
      session.minimumHeartRate = previous.minimum_heart_rate;
      session.maximumHeartRate = previous.maximum_heart_rate;
      continue;
    }
    let samples: HeartRateSampleImport[];
    try {
      samples = (await listGoogleDataPoints(accessToken, "heart-rate", heartRateFilter(session), fetcher))
        .map(parseHeartRatePoint)
        .filter((value): value is HeartRateSampleImport => value !== null)
        .filter(sample => sample.at >= session.startTime && sample.at <= session.endTime)
        .sort((left, right) => left.at - right.at);
    } catch (cause) {
      warnings.push(`Heart rate for ${session.displayName}: ${cause instanceof Error ? cause.message : String(cause)}`);
      session.minimumHeartRate = previous?.minimum_heart_rate ?? session.minimumHeartRate;
      session.maximumHeartRate = previous?.maximum_heart_rate ?? session.maximumHeartRate;
      continue;
    }
    session.samples = samples;
    heartRateSampleCount += samples.length;
    if (samples.length) {
      session.minimumHeartRate = Math.min(...samples.map(sample => sample.bpm));
      session.maximumHeartRate = Math.max(...samples.map(sample => sample.bpm));
    }
  }

  const statements: D1PreparedStatement[] = [];
  if (restingResult.status === "fulfilled") {
    for (const item of resting) {
      const previous = existingResting.get(item.date);
      if (previous === item.beatsPerMinute) continue;
      statements.push(previous === undefined
        ? db.prepare("INSERT INTO cardio_resting_heart_rates (space_id,recorded_date,beats_per_minute,synced_at) VALUES (?,?,?,?)").bind(spaceId, item.date, item.beatsPerMinute, now)
        : db.prepare("UPDATE cardio_resting_heart_rates SET beats_per_minute=?,synced_at=? WHERE space_id=? AND recorded_date=?").bind(item.beatsPerMinute, now, spaceId, item.date));
    }
    const returnedDates = new Set(resting.map(item => item.date));
    for (const date of existingResting.keys()) if (!returnedDates.has(date)) statements.push(
      db.prepare("DELETE FROM cardio_resting_heart_rates WHERE space_id=? AND recorded_date=?").bind(spaceId, date)
    );
  }

  if (stepsResult.status === "fulfilled") {
    for (const item of dailySteps) {
      const previous = existingSteps.get(item.date);
      if (previous === item.count) continue;
      statements.push(previous === undefined
        ? db.prepare("INSERT INTO cardio_daily_steps (space_id,recorded_date,step_count,synced_at) VALUES (?,?,?,?)").bind(spaceId, item.date, item.count, now)
        : db.prepare("UPDATE cardio_daily_steps SET step_count=?,synced_at=? WHERE space_id=? AND recorded_date=?").bind(item.count, now, spaceId, item.date));
    }
    const returnedDates = new Set(dailySteps.map(item => item.date));
    for (const date of existingSteps.keys()) if (!returnedDates.has(date)) statements.push(
      db.prepare("DELETE FROM cardio_daily_steps WHERE space_id=? AND recorded_date=?").bind(spaceId, date)
    );
  }

  if (hourlyStepsResult.status === "fulfilled") {
    for (const item of hourlySteps) {
      const previous = existingHourlySteps.get(item.startTime);
      if (previous === item.count) continue;
      statements.push(previous === undefined
        ? db.prepare("INSERT INTO cardio_hourly_steps (space_id,hour_start,step_count,synced_at) VALUES (?,?,?,?)").bind(spaceId, item.startTime, item.count, now)
        : db.prepare("UPDATE cardio_hourly_steps SET step_count=?,synced_at=? WHERE space_id=? AND hour_start=?").bind(item.count, now, spaceId, item.startTime));
    }
    const returnedHours = new Set(hourlySteps.map(item => item.startTime));
    for (const hourStart of existingHourlySteps.keys()) if (!returnedHours.has(hourStart)) statements.push(
      db.prepare("DELETE FROM cardio_hourly_steps WHERE space_id=? AND hour_start=?").bind(spaceId, hourStart)
    );
  }

  if (zone2Result.status === "fulfilled") {
    for (const item of dailyZone2) {
      const previous = existingZone2.get(item.date);
      if (previous === item.moderateSeconds) continue;
      statements.push(previous === undefined
        ? db.prepare("INSERT INTO cardio_daily_zone2 (space_id,recorded_date,moderate_seconds,synced_at) VALUES (?,?,?,?)").bind(spaceId, item.date, item.moderateSeconds, now)
        : db.prepare("UPDATE cardio_daily_zone2 SET moderate_seconds=?,synced_at=? WHERE space_id=? AND recorded_date=?").bind(item.moderateSeconds, now, spaceId, item.date));
    }
    const returnedDates = new Set(dailyZone2.map(item => item.date));
    for (const date of existingZone2.keys()) if (!returnedDates.has(date)) statements.push(
      db.prepare("DELETE FROM cardio_daily_zone2 WHERE space_id=? AND recorded_date=?").bind(spaceId, date)
    );
  }

  for (const session of sessions) {
    const previous = existing.get(session.googleName);
    if (!previous) statements.push(db.prepare(
      "INSERT INTO cardio_sessions (space_id,google_data_point_name,display_name,start_time,end_time,active_duration_seconds,average_heart_rate,minimum_heart_rate,maximum_heart_rate,calories_kcal,distance_meters,steps,light_zone_seconds,moderate_zone_seconds,vigorous_zone_seconds,peak_zone_seconds,google_updated_at,heart_rate_synced_at,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(spaceId, session.googleName, session.displayName, session.startTime, session.endTime, session.activeDurationSeconds, session.averageHeartRate, session.minimumHeartRate, session.maximumHeartRate, session.caloriesKcal, session.distanceMeters, session.steps, session.lightZoneSeconds, session.moderateZoneSeconds, session.vigorousZoneSeconds, session.peakZoneSeconds, session.googleUpdatedAt, session.samples ? now : null, now));
    else if (previous.google_updated_at !== session.googleUpdatedAt || session.samples) statements.push(db.prepare(
      "UPDATE cardio_sessions SET display_name=?,start_time=?,end_time=?,active_duration_seconds=?,average_heart_rate=?,minimum_heart_rate=?,maximum_heart_rate=?,calories_kcal=?,distance_meters=?,steps=?,light_zone_seconds=?,moderate_zone_seconds=?,vigorous_zone_seconds=?,peak_zone_seconds=?,google_updated_at=?,heart_rate_synced_at=COALESCE(?,heart_rate_synced_at),synced_at=? WHERE space_id=? AND google_data_point_name=?"
    ).bind(session.displayName, session.startTime, session.endTime, session.activeDurationSeconds, session.averageHeartRate, session.minimumHeartRate, session.maximumHeartRate, session.caloriesKcal, session.distanceMeters, session.steps, session.lightZoneSeconds, session.moderateZoneSeconds, session.vigorousZoneSeconds, session.peakZoneSeconds, session.googleUpdatedAt, session.samples ? now : null, now, spaceId, session.googleName));
    if (session.samples) {
      statements.push(db.prepare("DELETE FROM cardio_heart_rate_chunks WHERE space_id=? AND session_id=(SELECT id FROM cardio_sessions WHERE space_id=? AND google_data_point_name=?)").bind(spaceId, spaceId, session.googleName));
      for (let index = 0; index < session.samples.length; index += 500) {
        const samples = session.samples.slice(index, index + 500);
        statements.push(db.prepare(
          "INSERT INTO cardio_heart_rate_chunks (space_id,session_id,chunk_index,samples_json) VALUES (?,(SELECT id FROM cardio_sessions WHERE space_id=? AND google_data_point_name=?),?,?)"
        ).bind(spaceId, spaceId, session.googleName, index / 500, JSON.stringify(samples)));
      }
    }
  }
  statements.push(warnings.length
    ? db.prepare("UPDATE google_health_connections SET sync_started_at=NULL,sync_kind=NULL,last_sync_error=NULL,cardio_last_sync_error=NULL WHERE space_id=?").bind(spaceId)
    : db.prepare("UPDATE google_health_connections SET last_sync_at=?,cardio_last_sync_at=?,sync_started_at=NULL,sync_kind=NULL,last_sync_error=NULL,cardio_last_sync_error=NULL WHERE space_id=?").bind(now, now, spaceId));
  for (let index = 0; index < statements.length; index += 100) await db.batch(statements.slice(index, index + 100));
  return { restingHeartRates: resting.length, dailySteps: dailySteps.length, hourlySteps: hourlySteps.length, dailyZone2: dailyZone2.length, sessions: sessions.length, heartRateSamples: heartRateSampleCount, ...(warnings.length ? { warnings } : {}) };
}
