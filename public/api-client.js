import { PRIVATE_PATH_PATTERN, shouldReplaceMissingSpace } from "./private-space.js";

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
  let latestSnapshot = null;
  const pendingSections = new Set();
  let saveLoop = null;
  let mutationLoop = Promise.resolve();
  let offline = false;

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
  const loadAppState = async () => {
    const paths = ["timers", "habits", "habit-logs", "foods", "meals", "food-logs", "nutrition-goal", "strength"];
    const payloads = await Promise.all(paths.map(path => request(`/api/${path}`)));
    revision = Math.max(...payloads.map(payload => Number(payload.revision) || 0));
    const [timers, widgets, logs, foods, meals, foodLogData, nutritionGoal, strength] = payloads.map(payload => payload.data);
    return { schemaVersion: 14, timers, widgets, logs, foods, meals, foodLogs: foodLogData.foodLogs, recentFoodIds: foodLogData.recentFoodIds, recentMealIds: foodLogData.recentMealIds, nutritionGoal, strength, legacyDefaultsRemoved: true };
  };
  const loadBootstrap = async () => {
    const payload = await request("/api/bootstrap");
    revision = payload.revision;
    const state = await loadAppState();
    setOffline(false);
    return { ...payload.data, state };
  };

  const sectionOrder = ["timers", "habits", "habitLogs", "foods", "meals", "foodLogs", "nutritionGoal", "strength"];
  const sectionRequest = {
    timers: snapshot => ["/api/timers", snapshot.timers],
    habits: snapshot => ["/api/habits", snapshot.widgets],
    habitLogs: snapshot => ["/api/habit-logs", snapshot.logs],
    foods: snapshot => ["/api/foods", snapshot.foods],
    meals: snapshot => ["/api/meals", snapshot.meals],
    foodLogs: snapshot => ["/api/food-logs", { foodLogs: snapshot.foodLogs, recentFoodIds: snapshot.recentFoodIds, recentMealIds: snapshot.recentMealIds }],
    nutritionGoal: snapshot => ["/api/nutrition-goal", snapshot.nutritionGoal],
    strength: snapshot => ["/api/strength", snapshot.strength]
  };
  const mergeSection = (snapshot, section, data) => {
    if (section === "habits") snapshot.widgets = data;
    else if (section === "habitLogs") snapshot.logs = data;
    else if (section === "foodLogs") Object.assign(snapshot, data);
    else snapshot[section] = data;
  };
  const replaceIdEverywhere = (value, oldId, newId) => {
    if (Array.isArray(value)) return value.map(item => replaceIdEverywhere(item, oldId, newId));
    if (!value || typeof value !== "object") return String(value) === String(oldId) ? newId : value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.endsWith(`:${oldId}`) ? `${key.slice(0, key.length - String(oldId).length)}${newId}` : key, replaceIdEverywhere(item, oldId, newId)]));
  };
  const reconcileIds = (target, before, after) => {
    if (!target || !before || !after || typeof before !== "object" || typeof after !== "object") return target;
    if (before.id != null && after.id != null && String(before.id) !== String(after.id)) target = replaceIdEverywhere(target, before.id, after.id);
    if (Array.isArray(before) && Array.isArray(after)) before.forEach((item, index) => { target = reconcileIds(target, item, after[index]); });
    else if (!Array.isArray(before) && !Array.isArray(after)) Object.keys(before).forEach(key => { target = reconcileIds(target, before[key], after[key]); });
    return target;
  };
  const flush = async () => {
    let succeeded = true;
    let confirmedState = null;
    while (latestSnapshot) {
      let snapshot = latestSnapshot; latestSnapshot = null;
      const sections = sectionOrder.filter(section => pendingSections.delete(section));
      let confirmed = structuredClone(snapshot);
      try {
        for (const section of sections) {
          const [path, body] = sectionRequest[section](snapshot);
          const payload = await request(path, { method: "PUT", headers: { "If-Match": `"${revision}"` }, body: JSON.stringify(body) });
          revision = payload.revision;
          snapshot = reconcileIds(snapshot, body, payload.data);
          confirmed = reconcileIds(confirmed, body, payload.data);
          if (latestSnapshot) latestSnapshot = reconcileIds(latestSnapshot, body, payload.data);
          if (!latestSnapshot || !pendingSections.has(section)) mergeSection(confirmed, section, payload.data);
        }
        confirmedState = confirmed; setOffline(false);
      } catch (requestError) {
        succeeded = false;
        setOffline(true);
        if (requestError.status === 412) {
          const authoritative = await loadBootstrap(); latestSnapshot = null;
          window.dispatchEvent(new CustomEvent("tempo:conflict", { detail: authoritative.state }));
        }
        window.dispatchEvent(new CustomEvent("tempo:save-error", { detail: { message: requestError.message, conflict: requestError.status === 412 } }));
        break;
      }
    }
    saveLoop = null;
    if (succeeded) {
      if (confirmedState) window.dispatchEvent(new CustomEvent("tempo:saved-state", { detail: confirmedState }));
      window.dispatchEvent(new CustomEvent("tempo:saved", { detail: { revision } }));
    }
  };
  const saveState = (state, sections) => {
    if (offline) {
      window.dispatchEvent(new CustomEvent("tempo:save-error", { detail: { message: "Tempo is offline. Reload after reconnecting before making more changes." } }));
      return Promise.resolve(false);
    }
    latestSnapshot = structuredClone(state);
    for (const section of Array.isArray(sections) ? sections : [sections]) if (sectionRequest[section]) pendingSections.add(section);
    saveLoop ||= flush();
    return saveLoop.then(() => !offline);
  };
  window.tempoServer = {
    saveState,
    async getCardio() { return (await request("/api/cardio")).data; },
    async getCardioSession(id) { return (await request(`/api/cardio/sessions/${encodeURIComponent(id)}`)).data; },
    async deleteCardioSession(id) { return (await request(`/api/cardio/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })).data; },
    async setCardioZone2Goal(minutes) { return (await request("/api/cardio/zone-2-goal", { method: "PUT", body: JSON.stringify({ minutes }) })).data; },
    async setCardioStepsGoal(steps) { return (await request("/api/cardio/steps-goal", { method: "PUT", body: JSON.stringify({ steps }) })).data; },
    async getSleep() { return (await request("/api/sleep")).data; },
    async setSleepGoal(minutes, startTime) { return (await request("/api/sleep/goal", { method: "PUT", body: JSON.stringify({ minutes, startTime }) })).data; },
    async updateHabitLog(date,habitId,record) { return mutationRequest(`/api/habit-logs/${encodeURIComponent(date)}/${encodeURIComponent(habitId)}`, "PUT", record); },
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
    localStorage.setItem(LAST_PATH_KEY, privatePath);
    window.__TEMPO_BOOTSTRAP__ = bootstrap;
    window.__TEMPO_PRIVATE_PATH__ = privatePath;
    await import("./app.js?v=131");
    document.documentElement.classList.remove("is-booting");
  } catch (error) {
    if (shouldReplaceMissingSpace(error.status, privatePath, rememberedPath)) {
      localStorage.removeItem(LAST_PATH_KEY);
      createSpace().catch(createError => fatal(createError.message));
    } else fatal(error.message);
  }
}
