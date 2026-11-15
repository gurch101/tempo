import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { createD1Admin } from "d1-admin";
import type { Bindings, SpaceRow, TempoState } from "./types";
import { validateState } from "./state";
import { generateAccessKey, sha256 } from "./crypto";
import { reconcileTimers } from "./timers";
import { localDateInfo, validTimeZone } from "./time";
import { readFoodLogs, readFoods, readHabitLogs, readHabits, readMeals, readNutritionGoal, readState, readStrength, readTimers, replaceState as writeState } from "./repository";
import { createExerciseSet, removeExerciseSet, updateExerciseSet, writeFoodLogs, writeFoods, writeHabitLog, writeHabitLogs, writeHabits, writeMeals, writeNutritionGoal, writeStrength, writeTimers } from "./section-writes";
import { readCardio, readCardioSession } from "./cardio";
import { readSleep } from "./sleep";
import { FINANCE_ALLOCATION_COLORS, MarketDataError, normalizeCurrency, normalizeTicker, readCurrentFinances, refreshFinances } from "./finances";
import { decryptSecret, encryptSecret } from "./secrets";
import { exchangeAuthorizationCode, GOOGLE_HEALTH_SCOPES, GoogleHealthApiError, importGoogleHealthData, importGoogleSleepData, refreshGoogleAccessToken } from "./google-health";
import { readTrendDelta } from "./trends";
import { readHabitStreaks } from "./habit-streaks";

type AppContext = Context<{ Bindings: Bindings }>;
const app = new Hono<{ Bindings: Bindings }>();
const SYNC_FRESHNESS_MS = 5 * 60_000;
const isRecentlySynced = (timestamp: unknown, now = Date.now()) => {
  const value = Number(timestamp);
  return Number.isFinite(value) && now - value < SYNC_FRESHNESS_MS;
};
const admin = createD1Admin<Bindings>({
  database: env => env.DB,
  name: "Tempo",
  basePath: "/admin",
  access: env => ({
    teamDomain: String(env.CF_ACCESS_TEAM_DOMAIN || ""),
    audience: String(env.CF_ACCESS_AUD || ""),
    devBypass: env.D1_ADMIN_DEV === "true"
  }),
  tables: {
    google_health_connections: { columns: { refresh_token_ciphertext: { sensitive: true }, refresh_token_iv: { sensitive: true } } },
    google_health_oauth_states: { columns: { capability_ciphertext: { sensitive: true }, capability_iv: { sensitive: true }, state_hash: { sensitive: true } } },
    spaces: { columns: { access_key_hash: { sensitive: true }, write_token: { sensitive: true } } }
  }
});

const redactedSensitiveFormatter = {
  original: "function formatted(value,column){if(value===null)return '<span class=\"muted\">—</span>';if(value&&value.__blob)return '<span class=\"badge\">BLOB · '+value.size+' bytes</span>';if(column.sensitive||formatKind(column)==='masked')return '••••••';",
  patched: "function formatted(value,column){if(column.sensitive||formatKind(column)==='masked')return '••••••';if(value===null)return '<span class=\"muted\">—</span>';if(value&&value.__blob)return '<span class=\"badge\">BLOB · '+value.size+' bytes</span>';"
};

const foreignRecordTableAssignment = /(async function \w+\(\w+,\w+\)\{let \w+=\w+\.__foreignKeys\?\.\[\w+\];if\(!\w+\)return;let \w+=\w+\.schema\.tables\.find\(\w+=>\w+\.name===\w+\.targetTable\);if\(\w+\)try\{)(\w+)\.table=(\w+),/;

async function fetchAdmin(c: AppContext) {
  const response = await admin.fetch(c.req.raw, c.env, c.executionCtx);
  if (!c.req.path.endsWith("/assets/admin.js")) return response;
  const source = await response.text();
  return new Response(source
    .replace(redactedSensitiveFormatter.original, redactedSensitiveFormatter.patched)
    .replace(foreignRecordTableAssignment, (_match, prefix, stateName, targetName) =>
      `${prefix}${stateName}.table=${targetName};${stateName}.activeViewId=null;${stateName}.offset=0;${stateName}.filters=[];const foreignDefaultSort=${targetName}.primaryKey[0]||${targetName}.columns[0]?.name;${stateName}.sorts=foreignDefaultSort?[{column:foreignDefaultSort,direction:"asc"}]:[];/* reset foreign table list state */`
    ), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
const creationWindows = new Map<string, number[]>();

const privateHeaders = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff"
};

function error(c: AppContext, status: 400 | 401 | 404 | 409 | 412 | 422 | 429 | 500 | 502 | 503, code: string, message: string, fieldErrors?: Record<string, string>) {
  return c.json({ error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } }, status);
}

function etag(revision: number) { return `"${revision}"`; }
function googleHealthConfig(env: Bindings) {
  const clientId = String(env.GOOGLE_HEALTH_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_HEALTH_CLIENT_SECRET || "").trim();
  const tokenKey = String(env.GOOGLE_HEALTH_TOKEN_KEY || "").trim();
  return clientId && clientSecret && tokenKey ? { clientId, clientSecret, tokenKey } : null;
}
function requestedRevision(c: AppContext): number | null {
  const raw = c.req.header("If-Match")?.replaceAll('"', "");
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

async function replaceState(c: AppContext, state: TempoState, expected: number) {
  const revision = await writeState(c.env.DB, c.var.space, state, expected);
  if (revision === null) return null;
  const refreshed = await c.env.DB.prepare(
    "SELECT id, access_key_hash, revision, write_token, write_token_at, timezone, strength_unit, active_mesocycle_id, nutrition_calories, nutrition_carbs, nutrition_protein, nutrition_fats, nutrition_fibre, finance_display_currency, walkthrough_status FROM spaces WHERE id = ?"
  ).bind(c.var.space.id).first<SpaceRow>();
  if (!refreshed) throw new Error("Space disappeared while saving state");
  c.set("space", refreshed);
  return revision;
}

async function refreshSpace(c: AppContext) {
  const refreshed = await c.env.DB.prepare(
    "SELECT id, access_key_hash, revision, write_token, write_token_at, timezone, strength_unit, active_mesocycle_id, nutrition_calories, nutrition_carbs, nutrition_protein, nutrition_fats, nutrition_fibre, finance_display_currency, walkthrough_status FROM spaces WHERE id = ?"
  ).bind(c.var.space.id).first<SpaceRow>();
  if (!refreshed) throw new Error("Space disappeared while saving state");
  c.set("space", refreshed);
  return refreshed;
}

async function sectionRevision(c: AppContext, write: (expected: number) => Promise<number | null>) {
  const expected=requestedRevision(c);
  if(expected===null||expected!==c.var.space.revision)return null;
  const revision=await write(expected);if(revision===null)return null;
  await refreshSpace(c);return revision;
}

const requestLifecycle: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);
  Object.entries(privateHeaders).forEach(([name, value]) => c.header(name, value));
  try {
    await next();
    Object.entries(privateHeaders).forEach(([name, value]) => c.header(name, value));
  }
  finally {
    const path = c.req.path.startsWith("/p/") ? "/p/:capability" : c.req.path;
    console.log(JSON.stringify({ requestId, method: c.req.method, route: path, status: c.res.status, durationMs: Date.now() - started }));
  }
};
app.use("*", requestLifecycle);

app.all("/admin", fetchAdmin);
app.all("/admin/*", fetchAdmin);

app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) return error(c, 401, "origin_rejected", "Cross-origin requests are not allowed.");
  }
  await next();
});

app.post("/api/spaces", async c => {
  const ip = c.req.header("CF-Connecting-IP") || "local";
  const now = Date.now();
  const recent = (creationWindows.get(ip) || []).filter(value => now - value < 60_000);
  if (recent.length >= 5) return error(c, 429, "rate_limited", "Too many private areas were created. Try again in a minute.");
  recent.push(now); creationWindows.set(ip, recent);
  const body: { timezone?: string } = await c.req.json<{ timezone?: string }>().catch(() => ({}));
  const timezone = String(body.timezone || "UTC");
  if (!validTimeZone(timezone)) return error(c, 422, "validation_failed", "The timezone is invalid.", { timezone: "Use an IANA timezone such as America/Vancouver." });
  const accessKey = generateAccessKey();
  const hash = await sha256(accessKey);
  await c.env.DB.prepare(
    "INSERT INTO spaces (access_key_hash, revision, timezone, walkthrough_status) VALUES (?, 0, ?, 'pending')"
  ).bind(hash, timezone).run();
  return c.json({ data: { path: `/p/${accessKey}` }, revision: 0 }, 201, { "Cache-Control": "no-store" });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/spaces" || c.req.path === "/api/google-health/callback") return next();
  const header = c.req.header("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return error(c, 401, "unauthorized", "A valid private-area capability is required.");
  const hash = await sha256(match[1]);
  const row = await c.env.DB.prepare(
    "SELECT id, access_key_hash, revision, write_token, write_token_at, timezone, strength_unit, active_mesocycle_id, nutrition_calories, nutrition_carbs, nutrition_protein, nutrition_fats, nutrition_fibre, finance_display_currency, walkthrough_status FROM spaces WHERE access_key_hash = ?"
  ).bind(hash).first<SpaceRow>();
  if (!row) return error(c, 401, "unauthorized", "This private-area capability is not valid.");
  c.set("space", row);
  c.set("capability", match[1]);
  await next();
});

app.post("/api/google-health/connect", async c => {
  const config = googleHealthConfig(c.env);
  if (!config) return error(c, 503, "google_health_not_configured", "Google Health has not been configured on this Tempo deployment.");
  const now = Date.now();
  const state = generateAccessKey();
  const stateHash = await sha256(state);
  const encryptedCapability = await encryptSecret(c.var.capability, config.tokenKey, `google-health-oauth:${c.var.space.id}:${stateHash}`);
  const origin = new URL(c.req.url).origin;
  const body: { returnTo?: string } = await c.req.json<{ returnTo?: string }>().catch(() => ({}));
  const returnHash = body.returnTo === "sleep" ? "sleep" : "cardio";
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM google_health_oauth_states WHERE expires_at<?").bind(now),
    c.env.DB.prepare("INSERT INTO google_health_oauth_states (space_id,state_hash,capability_ciphertext,capability_iv,redirect_origin,expires_at,return_hash) VALUES (?,?,?,?,?,?,?)")
      .bind(c.var.space.id, stateHash, encryptedCapability.ciphertext, encryptedCapability.iv, origin, now + 10 * 60_000, returnHash)
  ]);
  const redirectUri = `${origin}/api/google-health/callback`;
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_HEALTH_SCOPES.join(" "),
    state
  }).toString();
  return c.json({ data: { url: authorizationUrl.toString() }, revision: c.var.space.revision });
});

interface OAuthStateRow {
  space_id: number;
  state_hash: string;
  capability_ciphertext: string;
  capability_iv: string;
  redirect_origin: string;
  expires_at: number;
  return_hash: string;
}

app.get("/api/google-health/callback", async c => {
  const config = googleHealthConfig(c.env);
  if (!config) return error(c, 503, "google_health_not_configured", "Google Health has not been configured on this Tempo deployment.");
  const state = c.req.query("state") || "";
  if (!state) return error(c, 400, "invalid_oauth_state", "Google authorization state is missing.");
  const stateHash = await sha256(state);
  const oauthState = await c.env.DB.prepare("SELECT space_id,state_hash,capability_ciphertext,capability_iv,redirect_origin,expires_at,return_hash FROM google_health_oauth_states WHERE state_hash=?")
    .bind(stateHash).first<OAuthStateRow>();
  if (!oauthState || oauthState.expires_at < Date.now()) {
    if (oauthState) await c.env.DB.prepare("DELETE FROM google_health_oauth_states WHERE state_hash=?").bind(oauthState.state_hash).run();
    return error(c, 400, "invalid_oauth_state", "Google authorization expired. Return to Tempo and connect again.");
  }
  await c.env.DB.prepare("DELETE FROM google_health_oauth_states WHERE state_hash=?").bind(oauthState.state_hash).run();
  const capability = await decryptSecret(
    { ciphertext: oauthState.capability_ciphertext, iv: oauthState.capability_iv },
    config.tokenKey,
    `google-health-oauth:${oauthState.space_id}:${oauthState.state_hash}`
  );
  const destination = new URL(`/p/${capability}/${oauthState.return_hash === "sleep" ? "sleep" : "cardio"}`, oauthState.redirect_origin);
  const oauthError = c.req.query("error");
  if (oauthError) {
    destination.searchParams.set("google_health", oauthError === "access_denied" ? "denied" : "error");
    return c.redirect(destination.toString());
  }
  const code = c.req.query("code") || "";
  if (!code) {
    destination.searchParams.set("google_health", "error");
    return c.redirect(destination.toString());
  }
  try {
    const redirectUri = `${oauthState.redirect_origin}/api/google-health/callback`;
    const tokens = await exchangeAuthorizationCode(config, code, redirectUri);
    const encryptedRefreshToken = await encryptSecret(tokens.refreshToken, config.tokenKey, `google-health-refresh:${oauthState.space_id}`);
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO google_health_connections (space_id,refresh_token_ciphertext,refresh_token_iv,granted_scopes,connected_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(space_id) DO UPDATE SET refresh_token_ciphertext=excluded.refresh_token_ciphertext,refresh_token_iv=excluded.refresh_token_iv,granted_scopes=excluded.granted_scopes,connected_at=excluded.connected_at,last_sync_error=NULL`
    ).bind(oauthState.space_id, encryptedRefreshToken.ciphertext, encryptedRefreshToken.iv, tokens.scope, now).run();
    destination.searchParams.set("google_health", "connected");
  } catch (cause) {
    console.error(JSON.stringify({ requestId: c.var.requestId, error: cause instanceof Error ? cause.message : "Google OAuth failed" }));
    destination.searchParams.set("google_health", "error");
  }
  return c.redirect(destination.toString());
});

app.get("/api/cardio", async c => {
  const data = await readCardio(c.env.DB, c.var.space.id, Boolean(googleHealthConfig(c.env)));
  return c.json({ data, revision: c.var.space.revision });
});

app.put("/api/cardio/zone-2-goal", async c => {
  const body = await c.req.json<{ minutes?: unknown }>().catch(() => null);
  const minutes = Number(body?.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
    return error(c, 422, "validation_failed", "Zone 2 goal must be between 1 and 10,080 whole minutes.", { minutes: "Enter a positive whole number of minutes." });
  }
  await c.env.DB.prepare("UPDATE spaces SET cardio_zone2_goal_minutes=? WHERE id=? AND cardio_zone2_goal_minutes IS NOT ?").bind(minutes, c.var.space.id,minutes).run();
  return c.json({ data: await readCardio(c.env.DB, c.var.space.id, Boolean(googleHealthConfig(c.env))), revision: c.var.space.revision });
});

app.put("/api/cardio/steps-goal", async c => {
  const body = await c.req.json<{ steps?: unknown }>().catch(() => null);
  const steps = Number(body?.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > 1000000) {
    return error(c, 422, "validation_failed", "Daily steps goal must be between 1 and 1,000,000 whole steps.", { steps: "Enter a positive whole number of steps." });
  }
  await c.env.DB.prepare("UPDATE spaces SET cardio_daily_steps_goal=? WHERE id=? AND cardio_daily_steps_goal IS NOT ?").bind(steps,c.var.space.id,steps).run();
  return c.json({ data: await readCardio(c.env.DB, c.var.space.id, Boolean(googleHealthConfig(c.env))), revision: c.var.space.revision });
});

app.get("/api/sleep", async c => {
  const data = await readSleep(c.env.DB, c.var.space.id, Boolean(googleHealthConfig(c.env)));
  return c.json({ data, revision: c.var.space.revision });
});

app.put("/api/sleep/goal", async c => {
  const body = await c.req.json<{ minutes?: unknown; startTime?: unknown }>().catch(() => null);
  const minutes = Number(body?.minutes);
  const startTime = String(body?.startTime || "");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return error(c, 422, "validation_failed", "Sleep goal must be between 1 minute and 24 hours.", { minutes: "Enter a valid sleep duration." });
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    return error(c, 422, "validation_failed", "Sleep start time must be a valid time.", { startTime: "Choose a valid sleep start time." });
  }
  await c.env.DB.prepare("UPDATE spaces SET sleep_goal_minutes=?,sleep_goal_start_time=? WHERE id=? AND (sleep_goal_minutes IS NOT ? OR sleep_goal_start_time IS NOT ?)").bind(minutes,startTime,c.var.space.id,minutes,startTime).run();
  return c.json({ data: await readSleep(c.env.DB, c.var.space.id, Boolean(googleHealthConfig(c.env))), revision: c.var.space.revision });
});

app.get("/api/cardio/sessions/:id", async c => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return error(c, 404, "not_found", "Cardio session not found.");
  const data = await readCardioSession(c.env.DB, c.var.space.id, id);
  return data ? c.json({ data, revision: c.var.space.revision }) : error(c, 404, "not_found", "Cardio session not found.");
});

app.delete("/api/cardio/sessions/:id", async c => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return error(c, 404, "not_found", "Cardio session not found.");
  const session = await c.env.DB.prepare("SELECT google_data_point_name FROM cardio_sessions WHERE id=? AND space_id=?")
    .bind(id, c.var.space.id).first<{ google_data_point_name: string }>();
  if (!session) return error(c, 404, "not_found", "Cardio session not found.");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO cardio_session_exclusions(space_id,google_data_point_name,deleted_at) VALUES(?,?,?) ON CONFLICT(space_id,google_data_point_name) DO UPDATE SET deleted_at=excluded.deleted_at")
      .bind(c.var.space.id, session.google_data_point_name, Date.now()),
    c.env.DB.prepare("DELETE FROM cardio_sessions WHERE id=? AND space_id=?").bind(id, c.var.space.id)
  ]);
  return c.json({ data: await readCardio(c.env.DB, c.var.space.id, Boolean(googleHealthConfig(c.env))), revision: c.var.space.revision });
});

interface GoogleConnectionRow {
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  cardio_last_sync_at?: number | null;
  sleep_last_sync_at?: number | null;
}

app.post("/api/cardio/sync", async c => {
  const config = googleHealthConfig(c.env);
  if (!config) return error(c, 503, "google_health_not_configured", "Google Health has not been configured on this Tempo deployment.");
  const connection = await c.env.DB.prepare("SELECT refresh_token_ciphertext,refresh_token_iv,cardio_last_sync_at FROM google_health_connections WHERE space_id=?")
    .bind(c.var.space.id).first<GoogleConnectionRow>();
  if (!connection) return error(c, 409, "google_health_not_connected", "Connect Google Health before syncing.");
  const now = Date.now();
  const force = c.req.query("force") === "1";
  if (!force && isRecentlySynced(connection.cardio_last_sync_at, now)) {
    return c.json({ data: { ...(await readCardio(c.env.DB, c.var.space.id, true)), sync: { skipped: true } }, revision: c.var.space.revision });
  }
  const claimed = await c.env.DB.prepare("UPDATE google_health_connections SET sync_started_at=?,sync_kind='cardio',last_sync_error=NULL,cardio_last_sync_error=NULL WHERE space_id=? AND (sync_started_at IS NULL OR sync_started_at<?)")
    .bind(now, c.var.space.id, now - 15 * 60_000).run();
  if (!claimed.meta.changes) return error(c, 409, "sync_in_progress", "A Google Health sync is already running.");
  try {
    const refreshToken = await decryptSecret(
      { ciphertext: connection.refresh_token_ciphertext, iv: connection.refresh_token_iv },
      config.tokenKey,
      `google-health-refresh:${c.var.space.id}`
    );
    const accessToken = await refreshGoogleAccessToken(config, refreshToken);
    const counts = await importGoogleHealthData(c.env.DB,c.var.space.id,accessToken,now,undefined,connection.cardio_last_sync_at);
    return c.json({ data: { ...(await readCardio(c.env.DB, c.var.space.id, true)), sync: counts }, revision: c.var.space.revision });
  } catch (cause) {
    const message = cause instanceof GoogleHealthApiError ? cause.message : "Tempo could not synchronize Google Health data.";
    await c.env.DB.prepare("UPDATE google_health_connections SET sync_started_at=NULL,sync_kind=NULL,last_sync_error=?,cardio_last_sync_error=? WHERE space_id=?")
      .bind(message, message, c.var.space.id).run().catch(() => undefined);
    return error(c, 502, "google_health_sync_failed", message);
  }
});

app.post("/api/sleep/sync", async c => {
  const config = googleHealthConfig(c.env);
  if (!config) return error(c, 503, "google_health_not_configured", "Google Health has not been configured on this Tempo deployment.");
  const connection = await c.env.DB.prepare("SELECT refresh_token_ciphertext,refresh_token_iv,granted_scopes,sleep_last_sync_at FROM google_health_connections WHERE space_id=?")
    .bind(c.var.space.id).first<GoogleConnectionRow & { granted_scopes: string }>();
  if (!connection) return error(c, 409, "google_health_not_connected", "Connect Google Health before syncing.");
  if (!connection.granted_scopes.split(/\s+/).some(scope => scope.endsWith("/auth/googlehealth.sleep.readonly")))
    return error(c, 409, "google_health_sleep_not_authorized", "Reconnect Google Health and grant sleep access before syncing.");
  const now = Date.now();
  if (isRecentlySynced(connection.sleep_last_sync_at, now)) {
    return c.json({ data: { ...(await readSleep(c.env.DB, c.var.space.id, true)), sync: { skipped: true } }, revision: c.var.space.revision });
  }
  const claimed = await c.env.DB.prepare("UPDATE google_health_connections SET sync_started_at=?,sync_kind='sleep',last_sync_error=NULL,sleep_last_sync_error=NULL WHERE space_id=? AND (sync_started_at IS NULL OR sync_started_at<?)")
    .bind(now, c.var.space.id, now - 15 * 60_000).run();
  if (!claimed.meta.changes) return error(c, 409, "sync_in_progress", "A Google Health sync is already running.");
  try {
    const refreshToken = await decryptSecret(
      { ciphertext: connection.refresh_token_ciphertext, iv: connection.refresh_token_iv }, config.tokenKey, `google-health-refresh:${c.var.space.id}`
    );
    const accessToken = await refreshGoogleAccessToken(config, refreshToken);
    const counts = await importGoogleSleepData(c.env.DB,c.var.space.id,accessToken,now,undefined,connection.sleep_last_sync_at);
    return c.json({ data: { ...(await readSleep(c.env.DB, c.var.space.id, true)), sync: counts }, revision: c.var.space.revision });
  } catch (cause) {
    const message = cause instanceof GoogleHealthApiError ? cause.message : "Tempo could not synchronize Google Health sleep data.";
    await c.env.DB.prepare("UPDATE google_health_connections SET sync_started_at=NULL,sync_kind=NULL,last_sync_error=?,sleep_last_sync_error=? WHERE space_id=?")
      .bind(message, message, c.var.space.id).run().catch(() => undefined);
    return error(c, 502, "google_health_sync_failed", message);
  }
});

app.get("/api/finances", async c => {
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.get("/api/trends", async c => {
  const rawCursor = c.req.query("cursor");
  if (rawCursor !== undefined && !/^\d+$/.test(rawCursor)) return error(c, 422, "validation_failed", "The trend cursor must be a non-negative integer.", { cursor: "Use the cursor returned by the previous trend response." });
  const data = await readTrendDelta(c.env.DB, c.var.space.id, rawCursor === undefined ? null : Number(rawCursor));
  return c.json({ data, revision: c.var.space.revision });
});

app.post("/api/finances/allocation-categories", async c => {
  const body = await c.req.json<{ name?: unknown; color?: unknown; targetPercentage?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const color = String(body?.color || "").toLowerCase();
  const targetPercentage = typeof body?.targetPercentage === "number" ? body.targetPercentage : Number.NaN;
  if (!name || name.length > 40) return error(c, 422, "validation_failed", "Category names must be between 1 and 40 characters.", { name: "Enter a name up to 40 characters." });
  if (!FINANCE_ALLOCATION_COLORS.includes(color as typeof FINANCE_ALLOCATION_COLORS[number])) return error(c, 422, "validation_failed", "Choose a color from the allocation palette.", { color: "Choose one of the available colors." });
  if (!Number.isFinite(targetPercentage) || targetPercentage < 0 || targetPercentage > 100) return error(c, 422, "validation_failed", "Target percentage must be between 0 and 100.", { targetPercentage: "Enter a percentage from 0 to 100." });
  const existing = await c.env.DB.prepare("SELECT id FROM finance_allocation_categories WHERE space_id=? AND name=? COLLATE NOCASE").bind(c.var.space.id, name).first();
  if (existing) return error(c, 409, "allocation_category_exists", "That allocation category already exists.");
  await c.env.DB.prepare("INSERT INTO finance_allocation_categories(space_id,name,color,target_percentage,sort_order) VALUES(?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM finance_allocation_categories WHERE space_id=?))").bind(c.var.space.id, name, color, targetPercentage, c.var.space.id).run();
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision }, 201);
});

app.put("/api/finances/allocation-categories/order", async c => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids || ids.some(id => !Number.isInteger(id) || Number(id) <= 0) || new Set(ids).size !== ids.length)
    return error(c, 422, "validation_failed", "Provide each allocation category exactly once in the desired order.");
  const stored = await c.env.DB.prepare("SELECT id FROM finance_allocation_categories WHERE space_id=? ORDER BY id").bind(c.var.space.id).all<{ id: number }>();
  const storedIds = (stored.results || []).map(row => Number(row.id)).sort((left, right) => left - right);
  const requestedIds = ids.map(Number);
  if (storedIds.length !== requestedIds.length || [...requestedIds].sort((left, right) => left - right).some((id, index) => id !== storedIds[index]))
    return error(c, 422, "validation_failed", "Provide each allocation category exactly once in the desired order.");
  if (requestedIds.length) await c.env.DB.batch(requestedIds.map((id, index) => c.env.DB.prepare("UPDATE finance_allocation_categories SET sort_order=? WHERE id=? AND space_id=?").bind(index, id, c.var.space.id)));
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.put("/api/finances/allocation-categories/:id", async c => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return error(c, 404, "not_found", "Allocation category not found.");
  const body = await c.req.json<{ name?: unknown; color?: unknown; targetPercentage?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const color = String(body?.color || "").toLowerCase();
  const targetPercentage = typeof body?.targetPercentage === "number" ? body.targetPercentage : Number.NaN;
  if (!name || name.length > 40) return error(c, 422, "validation_failed", "Category names must be between 1 and 40 characters.", { name: "Enter a name up to 40 characters." });
  if (!FINANCE_ALLOCATION_COLORS.includes(color as typeof FINANCE_ALLOCATION_COLORS[number])) return error(c, 422, "validation_failed", "Choose a color from the allocation palette.", { color: "Choose one of the available colors." });
  if (!Number.isFinite(targetPercentage) || targetPercentage < 0 || targetPercentage > 100) return error(c, 422, "validation_failed", "Target percentage must be between 0 and 100.", { targetPercentage: "Enter a percentage from 0 to 100." });
  const existing = await c.env.DB.prepare("SELECT id FROM finance_allocation_categories WHERE space_id=? AND name=? COLLATE NOCASE AND id<>?").bind(c.var.space.id, name, id).first();
  if (existing) return error(c, 409, "allocation_category_exists", "That allocation category already exists.");
  const updated = await c.env.DB.prepare("UPDATE finance_allocation_categories SET name=?,color=?,target_percentage=? WHERE id=? AND space_id=?").bind(name, color, targetPercentage, id, c.var.space.id).run();
  if (!updated.meta.changes) return error(c, 404, "not_found", "Allocation category not found.");
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.delete("/api/finances/allocation-categories/:id", async c => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return error(c, 404, "not_found", "Allocation category not found.");
  const deleted = await c.env.DB.prepare("DELETE FROM finance_allocation_categories WHERE id=? AND space_id=?").bind(id, c.var.space.id).run();
  if (!deleted.meta.changes) return error(c, 404, "not_found", "Allocation category not found.");
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.post("/api/finances/holdings", async c => {
  const body = await c.req.json<{ type?: unknown; symbol?: unknown; currency?: unknown; name?: unknown; quantity?: unknown; allocationCategoryId?: unknown }>().catch(() => null);
  if (!body) return error(c, 422, "validation_failed", "Enter a valid holding.");
  const type = String(body.type || "").toUpperCase();
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return error(c, 422, "validation_failed", "Quantity must be greater than zero.", { quantity: "Enter a positive number." });
  const allocationCategoryId = body.allocationCategoryId == null || body.allocationCategoryId === "" ? null : Number(body.allocationCategoryId);
  if (allocationCategoryId !== null) {
    if (!Number.isInteger(allocationCategoryId) || allocationCategoryId <= 0) return error(c, 422, "validation_failed", "Choose a valid allocation category.");
    const category = await c.env.DB.prepare("SELECT id FROM finance_allocation_categories WHERE id=? AND space_id=?").bind(allocationCategoryId, c.var.space.id).first();
    if (!category) return error(c, 422, "validation_failed", "Choose an allocation category from this portfolio.");
  }
  let symbol: string | null = null, currency: string | null = null, displayName: string | null = null;
  if (type === "STOCK") {
    symbol = normalizeTicker(body.symbol);
    if (!symbol) return error(c, 422, "validation_failed", "Enter a valid Yahoo Finance ticker.", { symbol: "Use a ticker such as AAPL or SHOP.TO." });
  } else if (type === "CASH") {
    currency = normalizeCurrency(body.currency);
    if (!currency) return error(c, 422, "validation_failed", "Choose a supported cash currency.", { currency: "Choose a supported currency." });
    const requestedName = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (requestedName.length > 60) return error(c, 422, "validation_failed", "Display name must be 60 characters or fewer.", { name: "Use 60 characters or fewer." });
    displayName = requestedName || `${currency} cash`;
  } else return error(c, 422, "validation_failed", "Holding type must be stock or cash.");
  if (type === "STOCK") {
    const existing = await c.env.DB.prepare("SELECT id FROM finance_holdings WHERE space_id=? AND asset_type='STOCK' AND symbol=?").bind(c.var.space.id, symbol).first<{ id: number }>();
    if (existing) return error(c, 409, "holding_exists", "That holding is already in the portfolio. Edit its quantity instead.");
  }
  await c.env.DB.prepare("INSERT INTO finance_holdings(space_id,asset_type,symbol,native_currency,display_name,quantity,allocation_category_id) VALUES(?,?,?,?,?,?,?)")
    .bind(c.var.space.id, type, symbol, currency, type === "CASH" ? displayName : symbol, quantity, allocationCategoryId).run();
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision }, 201);
});

app.put("/api/finances/holdings/:id", async c => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return error(c, 404, "not_found", "Holding not found.");
  const body = await c.req.json<{ type?: unknown; symbol?: unknown; currency?: unknown; name?: unknown; quantity?: unknown; allocationCategoryId?: unknown }>().catch(() => null);
  if (!body) return error(c, 422, "validation_failed", "Enter valid holding details.");
  const type = String(body.type || "").toUpperCase();
  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return error(c, 422, "validation_failed", "Quantity must be greater than zero.", { quantity: "Enter a positive number." });
  const allocationCategoryId = body.allocationCategoryId == null || body.allocationCategoryId === "" ? null : Number(body.allocationCategoryId);
  if (allocationCategoryId !== null) {
    if (!Number.isInteger(allocationCategoryId) || allocationCategoryId <= 0) return error(c, 422, "validation_failed", "Choose a valid allocation category.");
    const category = await c.env.DB.prepare("SELECT id FROM finance_allocation_categories WHERE id=? AND space_id=?").bind(allocationCategoryId, c.var.space.id).first();
    if (!category) return error(c, 422, "validation_failed", "Choose an allocation category from this portfolio.");
  }
  const current = await c.env.DB.prepare("SELECT asset_type,symbol,native_currency,display_name FROM finance_holdings WHERE id=? AND space_id=?")
    .bind(id, c.var.space.id).first<{ asset_type: string; symbol: string | null; native_currency: string | null; display_name: string | null }>();
  if (!current) return error(c, 404, "not_found", "Holding not found.");
  let symbol: string | null = null, currency: string | null = null, displayName: string | null = null;
  if (type === "STOCK") {
    symbol = normalizeTicker(body.symbol);
    if (!symbol) return error(c, 422, "validation_failed", "Enter a valid Yahoo Finance ticker.", { symbol: "Use a ticker such as AAPL or SHOP.TO." });
    const existing = await c.env.DB.prepare("SELECT id FROM finance_holdings WHERE space_id=? AND asset_type='STOCK' AND symbol=? AND id<>?").bind(c.var.space.id, symbol, id).first<{ id: number }>();
    if (existing) return error(c, 409, "holding_exists", "That holding is already in the portfolio.");
    const tickerUnchanged = current.asset_type === "STOCK" && current.symbol === symbol;
    currency = tickerUnchanged ? current.native_currency : null;
    displayName = tickerUnchanged ? current.display_name || symbol : symbol;
  } else if (type === "CASH") {
    currency = normalizeCurrency(body.currency);
    if (!currency) return error(c, 422, "validation_failed", "Choose a supported cash currency.", { currency: "Choose a supported currency." });
    const requestedName = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
    if (requestedName.length > 60) return error(c, 422, "validation_failed", "Display name must be 60 characters or fewer.", { name: "Use 60 characters or fewer." });
    displayName = requestedName || `${currency} cash`;
  } else return error(c, 422, "validation_failed", "Holding type must be stock or cash.");
  const updated = await c.env.DB.prepare("UPDATE finance_holdings SET asset_type=?,symbol=?,native_currency=?,display_name=?,quantity=?,allocation_category_id=? WHERE id=? AND space_id=?")
    .bind(type, symbol, currency, displayName, quantity, allocationCategoryId, id, c.var.space.id).run();
  if (!updated.meta.changes) return error(c, 404, "not_found", "Holding not found.");
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.delete("/api/finances/holdings/:id", async c => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return error(c, 404, "not_found", "Holding not found.");
  const deleted = await c.env.DB.prepare("DELETE FROM finance_holdings WHERE id=? AND space_id=?").bind(id, c.var.space.id).run();
  if (!deleted.meta.changes) return error(c, 404, "not_found", "Holding not found.");
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.put("/api/finances/currency", async c => {
  const body = await c.req.json<{ currency?: unknown }>().catch(() => null);
  const currency = normalizeCurrency(body?.currency);
  if (!currency) return error(c, 422, "validation_failed", "Choose a supported display currency.", { currency: "Choose a supported currency." });
  await c.env.DB.prepare("UPDATE spaces SET finance_display_currency=? WHERE id=? AND finance_display_currency IS NOT ?")
    .bind(currency,c.var.space.id,currency).run();
  return c.json({ data: await readCurrentFinances(c.env.DB, c.var.space.id), revision: c.var.space.revision });
});

app.post("/api/finances/refresh", async c => {
  try {
    const current = await readCurrentFinances(c.env.DB, c.var.space.id);
    if (c.req.query("force") !== "true" && isRecentlySynced(current.lastRefreshedAt)) {
      return c.json({ data: { ...current, sync: { skipped: true } }, revision: c.var.space.revision });
    }
    const sync = await refreshFinances(c.env.DB, c.var.space.id);
    return c.json({ data: { ...(await readCurrentFinances(c.env.DB, c.var.space.id)), sync }, revision: c.var.space.revision });
  } catch (cause) {
    const message = cause instanceof MarketDataError ? cause.message : "Tempo could not refresh Yahoo Finance market data.";
    return error(c, 502, "market_data_refresh_failed", message);
  }
});

app.get("/api/bootstrap", async c => {
  const space = c.var.space;
  const [timers, content, walkthroughPages] = await Promise.all([
    readTimers(c.env.DB, space.id),
    c.env.DB.prepare(`SELECT
      EXISTS(SELECT 1 FROM timers WHERE space_id=? AND deleted_at IS NULL) OR
      EXISTS(SELECT 1 FROM habits WHERE space_id=? AND deleted_at IS NULL) OR
      EXISTS(SELECT 1 FROM habit_daily_logs WHERE space_id=?) OR
      EXISTS(SELECT 1 FROM foods WHERE space_id=? AND deleted_at IS NULL) OR
      EXISTS(SELECT 1 FROM meals WHERE space_id=? AND deleted_at IS NULL) OR
      EXISTS(SELECT 1 FROM food_log_entries WHERE space_id=?) OR
      EXISTS(SELECT 1 FROM workouts WHERE space_id=? AND deleted_at IS NULL) OR
      EXISTS(SELECT 1 FROM mesocycles WHERE space_id=? AND deleted_at IS NULL)
      AS has_data`).bind(...Array(8).fill(space.id)).first<{has_data:number}>(),
    c.env.DB.prepare("SELECT page,status FROM space_walkthrough_pages WHERE space_id=?").bind(space.id).all<{ page: string; status: string }>()
  ]);
  if (reconcileTimers({ timers } as TempoState, Date.now(), space.timezone)) {
    const revision = await writeTimers(c.env.DB, space, timers, space.revision);
    if (revision === null) return error(c, 412, "revision_conflict", "State changed while timers were being reconciled. Reload and try again.");
    await refreshSpace(c);
  }
  const revision = c.var.space.revision;
  c.header("ETag", etag(revision));
  return c.json({
    data: {
      serverTime: Date.now(), timezone: space.timezone, empty: !content?.has_data,
      walkthrough: { status: space.walkthrough_status, pages: Object.fromEntries(walkthroughPages.results.map(row => [row.page, row.status])) }
    },
    revision
  });
});

app.put("/api/walkthrough", async c => {
  const body: { status?: string } = await c.req.json<{ status?: string }>().catch(() => ({}));
  if (body.status !== "completed" && body.status !== "dismissed") {
    return error(c, 422, "validation_failed", "Choose a valid walkthrough status.", { status: "Use completed or dismissed." });
  }
  await c.env.DB.prepare("UPDATE spaces SET walkthrough_status=? WHERE id=? AND walkthrough_status IS NOT ?")
    .bind(body.status,c.var.space.id,body.status).run();
  c.var.space.walkthrough_status = body.status;
  return c.json({ data: { status: body.status }, revision: c.var.space.revision });
});

app.post("/api/walkthrough/reset", async c => {
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE spaces SET walkthrough_status='pending' WHERE id=? AND walkthrough_status IS NOT 'pending'").bind(c.var.space.id),
    c.env.DB.prepare("DELETE FROM space_walkthrough_pages WHERE space_id=?").bind(c.var.space.id)
  ]);
  c.var.space.walkthrough_status = "pending";
  return c.json({ data: { status: "pending", pages: {} }, revision: c.var.space.revision });
});

const walkthroughPageNames = new Set(["nutrition", "strength", "cardio", "sleep", "finances", "settings"]);
app.put("/api/walkthrough/pages/:page", async c => {
  const page = c.req.param("page");
  if (!walkthroughPageNames.has(page)) return error(c, 404, "not_found", "Walkthrough page not found.");
  const body: { status?: string } = await c.req.json<{ status?: string }>().catch(() => ({}));
  if (body.status !== "completed" && body.status !== "dismissed") {
    return error(c, 422, "validation_failed", "Choose a valid walkthrough status.", { status: "Use completed or dismissed." });
  }
  const finishedAt = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO space_walkthrough_pages (space_id,page,status,finished_at) VALUES (?,?,?,?)
     ON CONFLICT(space_id,page) DO UPDATE SET status=excluded.status,finished_at=excluded.finished_at WHERE space_walkthrough_pages.status IS NOT excluded.status`
  ).bind(c.var.space.id, page, body.status, finishedAt).run();
  return c.json({ data: { page, status: body.status }, revision: c.var.space.revision });
});

app.get("/api/state", async c => {
  c.header("ETag", etag(c.var.space.revision));
  return c.json({ data: await readState(c.env.DB, c.var.space), revision: c.var.space.revision });
});

app.put("/api/state", async c => {
  const expected = requestedRevision(c);
  if (expected === null) return error(c, 412, "revision_required", "Send the current revision in If-Match.");
  if (expected !== c.var.space.revision) return error(c, 412, "revision_conflict", "This private area changed elsewhere. Reload before editing again.");
  const body: unknown = await c.req.json().catch(() => null);
  const validated = validateState(body);
  if (!validated.state) return error(c, 422, "validation_failed", "The state is invalid.", validated.errors);
  const revision = await replaceState(c, validated.state, expected);
  if (revision === null) return error(c, 412, "revision_conflict", "This private area changed elsewhere. Reload before editing again.");
  c.header("ETag", etag(revision));
  return c.json({ data: await readState(c.env.DB, c.var.space), revision });
});

async function saveSection<T>(c: AppContext, input: T, writer: (db:D1Database,space:SpaceRow,input:T,expected:number)=>Promise<number|null>, reader:()=>Promise<unknown>) {
  const revision=await sectionRevision(c,expected=>writer(c.env.DB,c.var.space,input,expected));
  if(revision===null)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");
  return c.json({data:await reader(),revision});
}

const sections={
  timers:{read:(c:AppContext)=>readTimers(c.env.DB,c.var.space.id),write:writeTimers},
  habits:{read:(c:AppContext)=>readHabits(c.env.DB,c.var.space.id),write:writeHabits},
  foods:{read:(c:AppContext)=>readFoods(c.env.DB,c.var.space.id),write:writeFoods},
  meals:{read:(c:AppContext)=>readMeals(c.env.DB,c.var.space.id),write:writeMeals}
};
for(const [route,section]of Object.entries(sections)){
  app.get(`/api/${route}`,async c=>c.json({data:await section.read(c),revision:c.var.space.revision}));
  app.put(`/api/${route}`,async c=>{const body=await c.req.json<TempoState["timers"]>();if(!Array.isArray(body))throw new Error("Collection must be an array");return saveSection(c,body,section.write,()=>section.read(c));});
  app.put(`/api/${route}/:id`,async c=>{const items=await section.read(c),id=c.req.param("id"),body=await c.req.json<Record<string,unknown>>();if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Invalid entity");const entity={...body,id},index=items.findIndex(item=>String(item.id)===id);if(index>=0)items[index]=entity;else items.push(entity);return saveSection(c,items,section.write,()=>section.read(c));});
  app.delete(`/api/${route}/:id`,async c=>{const items=await section.read(c),id=c.req.param("id"),filtered=items.filter(item=>String(item.id)!==id);return saveSection(c,filtered,section.write,()=>section.read(c));});
}

const validDateQuery=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const parsed=Date.parse(`${value}T00:00:00Z`);return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value;};
function dateRangeQuery(c:AppContext){const from=c.req.query("from"),to=c.req.query("to");if((from&&!validDateQuery(from))||(to&&!validDateQuery(to))||(from&&to&&from>to))return null;return{from,to};}
app.get("/api/habit-streaks", async c => {
  const today = localDateInfo(Date.now(), c.var.space.timezone).date;
  const date = c.req.query("date") || today;
  if (!validDateQuery(date) || date > today) return error(c, 422, "validation_failed", "Use a valid date on or before today.");
  return c.json({ data: await readHabitStreaks(c.env.DB, c.var.space.id, date), revision: c.var.space.revision });
});
app.get("/api/habit-logs", async c => {const range=dateRangeQuery(c);if(!range)return error(c,422,"validation_failed","Use a valid chronological date range.",{date:"Use YYYY-MM-DD dates with from on or before to."});return c.json({ data: await readHabitLogs(c.env.DB,c.var.space.id,range.from,range.to), revision: c.var.space.revision });});
app.put("/api/habit-logs", async c => {const body=await c.req.json<TempoState["logs"]>(),dates=Object.keys(body).sort();return saveSection(c,body,writeHabitLogs,()=>dates.length?readHabitLogs(c.env.DB,c.var.space.id,dates[0],dates.at(-1)):Promise.resolve({}));});

app.get("/api/strength", async c => c.json({ data: await readStrength(c.env.DB,c.var.space), revision: c.var.space.revision }));
app.put("/api/strength", async c => {const body=await c.req.json<TempoState["strength"]>();return saveSection(c,body,writeStrength,()=>readStrength(c.env.DB,c.var.space));});

app.post("/api/strength/session-exercises/:id/sets",async c=>{
  const sessionExerciseId=Number(c.req.param("id"));if(!Number.isInteger(sessionExerciseId)||sessionExerciseId<1)return error(c,404,"not_found","Exercise not found.");
  const body=await c.req.json<Record<string,unknown>>(),expected=requestedRevision(c);if(expected===null||expected!==c.var.space.revision)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");
  const result=await createExerciseSet(c.env.DB,c.var.space,sessionExerciseId,body,expected);if(result===undefined)return error(c,404,"not_found","Exercise not found.");if(result===null)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");await refreshSpace(c);return c.json({data:{id:result.id,reps:Math.max(0,Number(body.reps)||0),load:Math.max(0,Number(body.load)||0),completed:body.completed===true},revision:result.revision},201);
});
app.put("/api/strength/sets/:id",async c=>{
  const setId=Number(c.req.param("id"));if(!Number.isInteger(setId)||setId<1)return error(c,404,"not_found","Set not found.");const body=await c.req.json<Record<string,unknown>>(),expected=requestedRevision(c);if(expected===null||expected!==c.var.space.revision)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");
  const result=await updateExerciseSet(c.env.DB,c.var.space,setId,body,expected);if(result===undefined)return error(c,404,"not_found","Set not found.");if(result===null)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");await refreshSpace(c);return c.json({data:{id:setId,reps:Math.max(0,Number(body.reps)||0),load:Math.max(0,Number(body.load)||0),completed:body.completed===true},revision:result.revision});
});
app.delete("/api/strength/sets/:id",async c=>{
  const setId=Number(c.req.param("id")),expected=requestedRevision(c);if(!Number.isInteger(setId)||setId<1)return error(c,404,"not_found","Set not found.");if(expected===null||expected!==c.var.space.revision)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");
  const result=await removeExerciseSet(c.env.DB,c.var.space,setId,expected);if(result===undefined)return error(c,404,"not_found","Set not found.");if(result===null)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");await refreshSpace(c);return c.json({data:{id:setId},revision:result.revision});
});

for (const [route, stateKey] of [["workouts", "workouts"], ["mesocycles", "mesocycles"]] as const) {
  app.get(`/api/${route}`, async c => c.json({ data: (await readStrength(c.env.DB,c.var.space))[stateKey], revision: c.var.space.revision }));
  app.put(`/api/${route}/:id`, async c => {
    const strength=await readStrength(c.env.DB,c.var.space);
    const id = c.req.param("id"); const body = await c.req.json<Record<string, unknown>>();
    const items = strength[stateKey] as Array<Record<string, unknown>>;
    const entity = { ...body, id }; const index = items.findIndex(item => String(item.id) === id);
    if (index >= 0) items[index] = entity; else items.push(entity);
    return saveSection(c,strength,writeStrength,()=>readStrength(c.env.DB,c.var.space));
  });
  app.delete(`/api/${route}/:id`, async c => {
    const strength=await readStrength(c.env.DB,c.var.space),id = c.req.param("id"),items = strength[stateKey] as Array<Record<string, unknown>>;
    const index = items.findIndex(item => String(item.id) === id); if (index < 0) return error(c,404,"not_found",`${route === "workouts" ? "Workout" : "Mesocycle"} not found.`);
    items.splice(index, 1);return saveSection(c,strength,writeStrength,()=>readStrength(c.env.DB,c.var.space));
  });
}

app.get("/api/workout-sessions", async c => {
  const sessions = ((await readStrength(c.env.DB,c.var.space)).mesocycles as Array<{ sessions?: unknown[] }>).flatMap(mesocycle => mesocycle.sessions || []);
  return c.json({ data: sessions, revision: c.var.space.revision });
});
app.put("/api/workout-sessions/:id", async c => {
  const strength=await readStrength(c.env.DB,c.var.space);
  const id = c.req.param("id"); const body = await c.req.json<Record<string, unknown> & { mesocycleId?: string }>();
  const mesocycles = strength.mesocycles as Array<Record<string, unknown> & { sessions?: Array<Record<string, unknown>> }>;
  const mesocycle = mesocycles.find(item => String(item.id) === String(body.mesocycleId)) || mesocycles.find(item => item.sessions?.some(session => String(session.id) === id));
  if (!mesocycle) throw new Error("Mesocycle not found");
  mesocycle.sessions ||= []; const session = { ...body, id }; const index = mesocycle.sessions.findIndex(item => String(item.id) === id);
  if (index >= 0) mesocycle.sessions[index] = session; else mesocycle.sessions.push(session);
  return saveSection(c,strength,writeStrength,()=>readStrength(c.env.DB,c.var.space));
});
app.delete("/api/workout-sessions/:id", async c => {
  const strength=await readStrength(c.env.DB,c.var.space);
  const id = c.req.param("id");
  for (const mesocycle of strength.mesocycles as Array<{ sessions?: Array<Record<string, unknown>> }>) {
    const index = mesocycle.sessions?.findIndex(item => String(item.id) === id) ?? -1;
    if (index >= 0) {mesocycle.sessions!.splice(index, 1);return saveSection(c,strength,writeStrength,()=>readStrength(c.env.DB,c.var.space));}
  }
  return error(c,404,"not_found","Workout session not found.");
});

app.get("/api/food-logs", async c => {const range=dateRangeQuery(c);if(!range)return error(c,422,"validation_failed","Use a valid chronological date range.",{date:"Use YYYY-MM-DD dates with from on or before to."});return c.json({data:await readFoodLogs(c.env.DB,c.var.space.id,range.from,range.to),revision:c.var.space.revision});});
app.put("/api/food-logs", async c => {const body=await c.req.json<{foodLogs:TempoState["foodLogs"]}>(),dates=Object.keys(body.foodLogs).sort();return saveSection(c,body.foodLogs,writeFoodLogs,()=>readFoodLogs(c.env.DB,c.var.space.id,dates.length?dates[0]:"9999-12-31",dates.length?dates.at(-1):"9999-12-31"));});
app.post("/api/foods/batch", async c => {
  const foods = await c.req.json<Array<Record<string, unknown>>>();
  if (!Array.isArray(foods)) throw new Error("Foods must be an array");
  const current=await readFoods(c.env.DB,c.var.space.id);
  for (const food of foods) {
    const id = String(food.id || crypto.randomUUID()); const entity = { ...food, id };
    const index = current.findIndex(item => String(item.id) === id); if (index >= 0) current[index] = entity; else current.push(entity);
  }
  return saveSection(c,current,writeFoods,()=>readFoods(c.env.DB,c.var.space.id));
});

app.post("/api/:collection/reorder", async c => {
  const section=sections[c.req.param("collection") as keyof typeof sections];
  if(!section)throw new Error("Unsupported collection");
  const order = await c.req.json<string[]>(); if (!Array.isArray(order)) throw new Error("Order must be an array");
  const items=await section.read(c);
  const rank = new Map(order.map((id, index) => [String(id), index]));
  items.sort((a, b) => (rank.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER));
  return saveSection(c,items,section.write,()=>section.read(c));
});

app.post("/api/timers/:id/:action", async c => {
  const timers=await readTimers(c.env.DB,c.var.space.id),timer=timers.find(item => String(item.id) === c.req.param("id"));
  if (!timer) return error(c,404,"not_found","Timer not found.");
  const action = c.req.param("action");
  const now = Date.now();
  if (action === "start") {
    if (Number(timer.remaining) <= 0) { timer.phase = "work"; timer.remaining = Math.max(1, Number(timer.duration) || 1); }
    timer.running = true; timer.lastTick = now;
  } else if (action === "pause") { timer.running = false; timer.lastTick = null; }
  else if (action === "reset") { timer.phase = "work"; timer.running = false; timer.lastTick = null; timer.remaining = Math.max(1, Number(timer.duration) || 1); }
  else if (action === "complete") {
    if (timer.pomodoro === true && timer.phase !== "rest") {
      timer.phase = "rest"; timer.remaining = Math.max(1, Number(timer.restDuration) || 300); timer.running = true; timer.lastTick = now;
    } else {
      const alreadyComplete = timer.running !== true && Number(timer.remaining) <= 0;
      timer.remaining = 0; timer.running = false; timer.lastTick = null;
      const today = localDateInfo(now, c.var.space.timezone).date;
      if (timer.completionDate !== today) { timer.completedToday = 0; timer.completionDate = today; }
      if (!alreadyComplete && timer.trackCompletions === true) timer.completedToday = Math.max(0, Number(timer.completedToday) || 0) + 1;
    }
  } else throw new Error("Unknown timer action");
  return saveSection(c,timers,writeTimers,()=>readTimers(c.env.DB,c.var.space.id));
});

app.put("/api/habit-logs/:date/:habitId", async c => {
  const { date, habitId } = c.req.param();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");
  const id=Number(habitId),body=await c.req.json<Record<string,unknown>>(),expected=requestedRevision(c);if(!Number.isInteger(id)||id<1)return error(c,404,"not_found","Habit not found.");if(expected===null||expected!==c.var.space.revision)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");
  const result=await writeHabitLog(c.env.DB,c.var.space,date,id,body,expected);if(result===undefined)return error(c,404,"not_found","Habit not found.");if(result===null)return error(c,412,"revision_conflict","This private area changed elsewhere. Reload before editing again.");await refreshSpace(c);return c.json({data:body,revision:result.revision});
});

app.put("/api/nutrition-goal", async c => {const body=await c.req.json<TempoState["nutritionGoal"]>();return saveSection(c,body,writeNutritionGoal,async()=>readNutritionGoal(c.var.space));});
app.get("/api/nutrition-goal", async c => c.json({ data: readNutritionGoal(c.var.space), revision: c.var.space.revision }));

app.onError((cause, c) => {
  console.error(JSON.stringify({ requestId: c.var.requestId, error: cause instanceof Error ? cause.message : "unknown" }));
  return error(c, 500, "internal_error", "Tempo could not complete this request.");
});

const privateManifest = (capability: string) => {
  const privatePath = `/p/${capability}`;
  return {
    name: "tempo",
    short_name: "tempo",
    description: "Plan focused time and manage habits, health, nutrition, training, and finances in one private daily dashboard.",
    id: privatePath,
    start_url: privatePath,
    scope: "/",
    display: "standalone",
    background_color: "#f4f2ea",
    theme_color: "#f4f2ea",
    icons: [
      { src: "/icons/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icons/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ]
  };
};

app.get("/p/:capability/manifest.webmanifest", async c => {
  const capability = String(c.req.param("capability") || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return c.notFound();
  const space = await c.env.DB.prepare("SELECT id FROM spaces WHERE access_key_hash = ?").bind(await sha256(capability)).first<{ id: number }>();
  if (!space) return c.notFound();
  return c.body(JSON.stringify(privateManifest(capability)), 200, {
    "Content-Type": "application/manifest+json; charset=UTF-8",
    "Cache-Control": "no-store, private"
  });
});

const privateAppShell = async (c: AppContext) => {
  const capability = String(c.req.param("capability") || "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return c.env.ASSETS.fetch(c.req.raw);
  const assetUrl = new URL("/", c.req.url);
  const assetResponse = await c.env.ASSETS.fetch(new Request(assetUrl, c.req.raw));
  let html = (await assetResponse.text()).replace(
    'href="/manifest.webmanifest"',
    `href="/p/${capability}/manifest.webmanifest"`
  );
  for (const [hash, route] of Object.entries({ home: "", nutrition: "/nutrition", strength: "/strength", cardio: "/cardio", sleep: "/sleep", finances: "/finances", settings: "/settings" }))
    html = html.replaceAll(`href="#${hash}"`, `href="/p/${capability}${route}"`);
  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.set("Content-Type", "text/html; charset=UTF-8");
  return new Response(html, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
};

app.get("/", c => c.env.ASSETS.fetch(c.req.raw));
app.get("/p/:capability", privateAppShell);
app.get("/p/:capability/", privateAppShell);
app.get("/p/:capability/*", privateAppShell);
app.get("/p/*", c => c.env.ASSETS.fetch(c.req.raw));
app.all("*", c => c.env.ASSETS.fetch(c.req.raw));

export default app;
