import { PRIVATE_PATH_PATTERN, shouldReplaceMissingSpace } from "./private-space.js";
import { createCalendar } from "./calendar.js";
import { createSectionSaveQueue, loadConsistentSections } from "./browser-persistence.js?v=1";
import { activateTrendNamespace, applyTrendDelta, readTrendCache } from "./trend-cache.js?v=1";

const LAST_PATH_KEY = "tempo-last-private-path";
const privateMatch = /^\/p\/([A-Za-z0-9_-]{43})(?:\/.*)?$/.exec(location.pathname);

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

async function createSpace() {
  const response = await fetch("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timezone: localTimezone() }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Could not create a private area.");
  localStorage.setItem(LAST_PATH_KEY, payload.data.path);
  location.replace(payload.data.path);
}

function fatal(message) {
  document.body.innerHTML = `<main class="bootstrap-error"><div><p class="eyebrow">TEMPO</p><h1>Couldn’t open your private area</h1><p>${String(message)}</p><button id="retryBootstrap" type="button">Try again</button></div></main>`;
  document.querySelector("#retryBootstrap").addEventListener("click", () => location.reload());
}

if (!privateMatch) {
  const remembered = localStorage.getItem(LAST_PATH_KEY);
  if (remembered && PRIVATE_PATH_PATTERN.test(remembered)) location.replace(remembered);
  else createSpace().catch(error => fatal(error.message));
} else {
  const accessKey = privateMatch[1];
  const privatePath = `/p/${accessKey}`;
  const rememberedPath = localStorage.getItem(LAST_PATH_KEY);
  let revision = 0;
  let mutationLoop = Promise.resolve();
  let offline = false;
  const trendNamespacePromise = crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessKey))
    .then(bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join(""));
  let trendNamespaceActivated = false;
  const trendNamespace = async () => {
    const namespace = await trendNamespacePromise;
    if (!trendNamespaceActivated) { await activateTrendNamespace(namespace); trendNamespaceActivated = true; }
    return namespace;
  };

  const request = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${accessKey}`, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const requestError = new Error(payload.error?.message || `Request failed (${response.status}).`);
      requestError.status = response.status; requestError.code = payload.error?.code;
      throw requestError;
    }
    return payload;
  };
  const mutationRequest = (path, method, body) => {
    const perform = async () => {
      const payload = await request(path, { method, headers: { "If-Match": `"${revision}"` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      revision = Number(payload.revision) || revision;
      return payload.data;
    };
    const pending=mutationLoop.then(perform,perform);
    mutationLoop=pending.catch(()=>undefined);
    return pending;
  };

  const setOffline = value => {
    offline = value;
    document.documentElement.classList.toggle("is-offline", value);
    window.dispatchEvent(new CustomEvent("tempo:connectivity", { detail: { offline: value } }));
  };
  const loadAppState = async bootstrap => {
    const calendar = createCalendar(bootstrap.timezone);
    const today = calendar.dayKey(new Date(bootstrap.serverTime));
    const habitFrom = calendar.addCalendarDays(today, -8);
    const nutritionFrom = calendar.addCalendarDays(today, -7);
    const paths = ["timers", "habits", `habit-logs?from=${habitFrom}&to=${today}`, "foods", "meals", `food-logs?from=${nutritionFrom}&to=${today}`, "nutrition-goal", "strength", `habit-streaks?date=${today}`];
    const loaded = await loadConsistentSections(() => Promise.all(paths.map(path => request(`/api/${path}`))));
    const payloads = loaded.payloads;
    revision = loaded.revision;
    const [timers, widgets, logs, foods, meals, foodLogData, nutritionGoal, strength, streaks] = payloads.map(payload => payload.data);
    window.__TEMPO_HABIT_STREAKS__ = streaks;
    return { schemaVersion: 14, timers, widgets, logs, foods, meals, foodLogs: foodLogData.foodLogs, recentFoodIds: foodLogData.recentFoodIds, recentMealIds: foodLogData.recentMealIds, nutritionGoal, strength, legacyDefaultsRemoved: true };
  };
  const loadBootstrap = async () => {
    const payload = await request("/api/bootstrap");
    revision = payload.revision;
    setOffline(false);
    return payload.data;
  };

  const sectionPaths = {
    timers: "/api/timers", habits: "/api/habits", habitLogs: "/api/habit-logs", foods: "/api/foods",
    meals: "/api/meals", foodLogs: "/api/food-logs", nutritionGoal: "/api/nutrition-goal", strength: "/api/strength"
  };
  const sectionQueue = createSectionSaveQueue({
    send: (section, body, expected) => request(sectionPaths[section], { method: "PUT", headers: { "If-Match": `"${expected}"` }, body: JSON.stringify(body) }),
    getRevision: () => revision, setRevision: value => { revision = value; }, isOffline: () => offline, setOffline,
    recoverConflict: async () => {
      const authoritativeBootstrap = await loadBootstrap(); window.__TEMPO_BOOTSTRAP__ = authoritativeBootstrap;
      const authoritativeState = await loadAppState(authoritativeBootstrap);
      window.dispatchEvent(new CustomEvent("tempo:conflict", { detail: authoritativeState }));
    },
    onConfirmed: sections => window.dispatchEvent(new CustomEvent("tempo:saved-state", { detail: sections })),
    onSaved: value => window.dispatchEvent(new CustomEvent("tempo:saved", { detail: { revision: value } })),
    onError: requestError => window.dispatchEvent(new CustomEvent("tempo:save-error", { detail: { message: requestError.message, conflict: requestError.status === 412 } }))
  });
  const saveState = (state, sections) => sectionQueue.save(state, sections);
  window.tempoServer = {
    saveState,
    async getHabitStreaks(date) { return (await request(`/api/habit-streaks?date=${encodeURIComponent(date)}`)).data; },
    async getCardio() { return (await request("/api/cardio")).data; },
    async getCardioSession(id) { return (await request(`/api/cardio/sessions/${encodeURIComponent(id)}`)).data; },
    async deleteCardioSession(id) { return (await request(`/api/cardio/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })).data; },
    async setCardioZone2Goal(minutes) { return (await request("/api/cardio/zone-2-goal", { method: "PUT", body: JSON.stringify({ minutes }) })).data; },
    async setCardioStepsGoal(steps) { return (await request("/api/cardio/steps-goal", { method: "PUT", body: JSON.stringify({ steps }) })).data; },
    async getSleep() { return (await request("/api/sleep")).data; },
    async getCachedTrends() { return readTrendCache(await trendNamespace()).catch(() => null); },
    async getTrendDelta(cursor = null) { return (await request(`/api/trends${cursor == null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`)).data; },
    async applyTrendDelta(delta) { return applyTrendDelta(await trendNamespace(), delta).catch(() => null); },
    async setSleepGoal(minutes, startTime) { return (await request("/api/sleep/goal", { method: "PUT", body: JSON.stringify({ minutes, startTime }) })).data; },
    async updateHabitLog(date,habitId,record) {
      const result = await mutationRequest(`/api/habit-logs/${encodeURIComponent(date)}/${encodeURIComponent(habitId)}`, "PUT", record);
      window.dispatchEvent(new CustomEvent("tempo:habit-log-saved", { detail: { date } }));
      return result;
    },
    async addStrengthSet(sessionExerciseId, set) { return mutationRequest(`/api/strength/session-exercises/${encodeURIComponent(sessionExerciseId)}/sets`, "POST", set); },
    async updateStrengthSet(id, set) { return mutationRequest(`/api/strength/sets/${encodeURIComponent(id)}`, "PUT", set); },
    async deleteStrengthSet(id) { return mutationRequest(`/api/strength/sets/${encodeURIComponent(id)}`, "DELETE"); },
    async connectGoogleHealth(returnTo = "cardio") {
      const payload = await request("/api/google-health/connect", { method: "POST", body: JSON.stringify({ returnTo }) });
      location.assign(payload.data.url);
    },
    async syncCardio(force = false) { return (await request(`/api/cardio/sync${force ? "?force=1" : ""}`, { method: "POST" })).data; },
    async syncSleep() { return (await request("/api/sleep/sync", { method: "POST" })).data; },
    async getFinances() { return (await request("/api/finances")).data; },
    async addFinanceHolding(holding) { return (await request("/api/finances/holdings", { method: "POST", body: JSON.stringify(holding) })).data; },
    async updateFinanceHolding(id, holding) { return (await request(`/api/finances/holdings/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(holding) })).data; },
    async deleteFinanceHolding(id) { return (await request(`/api/finances/holdings/${encodeURIComponent(id)}`, { method: "DELETE" })).data; },
    async addAllocationCategory(category) { return (await request("/api/finances/allocation-categories", { method: "POST", body: JSON.stringify(category) })).data; },
    async updateAllocationCategory(id, category) { return (await request(`/api/finances/allocation-categories/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(category) })).data; },
    async reorderAllocationCategories(ids) { return (await request("/api/finances/allocation-categories/order", { method: "PUT", body: JSON.stringify({ ids }) })).data; },
    async deleteAllocationCategory(id) { return (await request(`/api/finances/allocation-categories/${encodeURIComponent(id)}`, { method: "DELETE" })).data; },
    async setFinanceCurrency(currency) { return (await request("/api/finances/currency", { method: "PUT", body: JSON.stringify({ currency }) })).data; },
    async refreshFinances(force = false) { return (await request(`/api/finances/refresh${force ? "?force=true" : ""}`, { method: "POST" })).data; },
    async resetWalkthroughs() { return (await request("/api/walkthrough/reset", { method: "POST" })).data; },
    async setWalkthroughStatus(status) { return (await request("/api/walkthrough", { method: "PUT", body: JSON.stringify({ status }) })).data; },
    async setPageWalkthroughStatus(page, status) { return (await request(`/api/walkthrough/pages/${encodeURIComponent(page)}`, { method: "PUT", body: JSON.stringify({ status }) })).data; },
    get revision() { return revision; },
    get offline() { return offline; }
  };

  try {
    const bootstrap = await loadBootstrap();
    const initialState = await loadAppState(bootstrap);
    localStorage.setItem(LAST_PATH_KEY, privatePath);
    window.__TEMPO_BOOTSTRAP__ = bootstrap;
    window.__TEMPO_INITIAL_STATE__ = initialState;
    window.__TEMPO_PRIVATE_PATH__ = privatePath;
    await import("./app.js?v=151");
    document.documentElement.classList.remove("is-booting");
  } catch (error) {
    if (shouldReplaceMissingSpace(error.status, privatePath, rememberedPath)) {
      localStorage.removeItem(LAST_PATH_KEY);
      createSpace().catch(createError => fatal(createError.message));
    } else fatal(error.message);
  }
}
