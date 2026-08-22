import { createCalendar } from "./calendar.js";
import { liveStepsPace } from "./cardio-metrics.js?v=1";
import { pathForView, routeFromLocation } from "./routes.js";
import { mergeSection } from "./state-sections.js?v=1";

const STATE_SCHEMA_VERSION = 14;
const STORAGE_KEY = "tempo-state-v2";
const LEGACY_STORAGE_KEYS = ["tempo-timers-v1"];
const WORKOUT_COUNTDOWN_PREFERENCE_KEY = "tempo-workout-countdown-v1";
const SYNC_FRESHNESS_MS = 5 * 60_000;
const palette = ["#ec5f3e", "#6558d3", "#16a085", "#d6941f", "#3976b8", "#d94f8a", "#69a82f", "#8b5cf6", "#00a6b2", "#b24b3f", "#6f7d95", "#c15d15"];
const allDays = [0, 1, 2, 3, 4, 5, 6];
const shortDayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const nutrientKeys = ["calories", "carbs", "protein", "fats", "fibre"];
const nutrientLabels = { calories: "Calories", carbs: "Carbs", protein: "Protein", fats: "Fats", fibre: "Fibre" };
const nutrientColors = { calories: "#ec5f3e", carbs: "#d6941f", protein: "#6558d3", fats: "#d94f8a", fibre: "#16a085" };
const servingUnits = ["g", "mL", "cups", "tsp", "tbsp", "count"];
const defaultMuscles = [
  ["chest", "Chest", "#ec5f3e"], ["back", "Back", "#6558d3"], ["front-delts", "Front delts", "#d6941f"],
  ["side-delts", "Side delts", "#3976b8"], ["rear-delts", "Rear delts", "#8b5cf6"], ["biceps", "Biceps", "#d94f8a"],
  ["triceps", "Triceps", "#00a6b2"], ["quads", "Quads", "#16a085"], ["hamstrings", "Hamstrings", "#69a82f"],
  ["glutes", "Glutes", "#b24b3f"], ["calves", "Calves", "#c15d15"], ["core", "Core", "#6f7d95"]
];

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const icon = (name, fallback = "") => `<i data-lucide="${name}" aria-hidden="true">${fallback}</i>`;
let lucideRefreshFrame = null;
function refreshLucideIcons() {
  if (!window.lucide) return;
  window.lucide.createIcons({ attrs: { "stroke-width": 2, "aria-hidden": "true" } });
}
function initializeDialogChrome() {
  $$('dialog').forEach(dialog => {
    const form = $('form', dialog);
    const title = $('h2', form);
    const footer = $('.dialog-actions', form);
    if (!form || !title || !footer) return;

    title.id ||= `${dialog.id}Title`;
    dialog.setAttribute('aria-labelledby', title.id);
    $$('.eyebrow', form).forEach(accent => accent.remove());
    $$('.close-button', form).forEach(button => button.remove());
    $$('button', footer).filter(button => button.type === 'button' && button.textContent.trim() === 'Cancel').forEach(button => button.remove());

    const oldHeader = title.closest('.strength-template-dialog-header');
    const header = document.createElement('div');
    header.className = 'dialog-header';
    (oldHeader || title).before(header);
    header.append(title);
    const closeButton = document.createElement('button');
    closeButton.className = 'close-button';
    closeButton.type = 'button';
    closeButton.dataset.closeDialog = dialog.id;
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.innerHTML = icon('x', '×');
    header.append(closeButton);
    oldHeader?.remove();

    footer.classList.add('dialog-footer');
    const cancelButton = document.createElement('button');
    cancelButton.className = 'dialog-cancel-button';
    cancelButton.type = 'button';
    cancelButton.dataset.closeDialog = dialog.id;
    cancelButton.textContent = 'Cancel';
    footer.prepend(cancelButton);
  });
}
const lucideIconObserver = new MutationObserver(mutations => {
  const hasNewIcons = mutations.some(mutation => [...mutation.addedNodes].some(node => node.nodeType === 1 && (node.matches?.("i[data-lucide]") || node.querySelector?.("i[data-lucide]"))));
  if (!hasNewIcons || lucideRefreshFrame) return;
  lucideRefreshFrame = requestAnimationFrame(() => { lucideRefreshFrame = null; refreshLucideIcons(); });
});
lucideIconObserver.observe(document.body, { childList: true, subtree: true });
initializeDialogChrome();
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const isRecentlySynced = timestamp => Number.isFinite(Number(timestamp)) && Date.now() - Number(timestamp) < SYNC_FRESHNESS_MS;
const entityId = value => (typeof value === "string" && value) || (Number.isInteger(value) && value > 0 ? String(value) : uid());
const habitLogKey = id => `habit:${id}`;
const appTimezone = window.__TEMPO_BOOTSTRAP__?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const privateBasePath = window.__TEMPO_PRIVATE_PATH__ || location.pathname.match(/^\/p\/[A-Za-z0-9_-]{43}/)?.[0] || location.pathname;
const { dayKey, dateFromKey, validDateKey, addCalendarDays, weekdayForKey, weekdayAt, formatCalendarDate, nextDayBoundary: nextTimezoneDayBoundary } = createCalendar(appTimezone);

const initialTimers = [];
const legacyDefaults = [
  ["Deep work", 25 * 60, palette[0]],
  ["Reading", 15 * 60, palette[1]],
  ["Stretch break", 5 * 60, palette[2]]
];

let state = await loadState();
let toastTimer;
let persistencePending = false;
let queuedPersistenceToast = "";
let currentDayKey = dayKey();
let visibleDay = currentDayKey;
let draggedTimerId = null;
let draggedWidgetId = null;
let audioContext = null;
let dailyRingHitAreas = [];
let dailyRingCanvasSize = 240;
let dailyRingItems = [];
let dailyRingViewDate = null;
let hoveredRingItemId = null;
let selectedRingItemId = null;
let progressSummaryTab = "habits";
let momentumFilter = "all";
let foodLogDay = currentDayKey;
let activeView = "timersView";
let cardioData = null;
let cardioLoading = false;
let cardioLoadPromise = null;
let cardioSyncing = false;
let cardioSyncError = "";
let cardioError = "";
let cardioRestingRange = "90";
let selectedCardioStepHourStart = null;
let cardioCalendarMonth = dayKey().slice(0, 7);
let selectedCardioSessionId = null;
let selectedCardioSession = null;
let sleepData = null;
let sleepLoading = false;
let sleepLoadPromise = null;
let sleepSyncing = false;
let sleepSyncError = "";
let sleepError = "";
let financeData = null;
let financeLoading = false;
let financeLoadPromise = null;
let financeRefreshing = false;
let financeRefreshPromise = null;
let financeError = "";
let draggedAllocationCategoryId = null;
let libraryTab = "foods";
let strengthWeek = null;
let activeStrengthSessionId = null;
const workoutCountdowns = new Map();
let pendingDeleteAction = null;
let walkthroughActive = false;
let walkthroughStepIndex = 0;
let walkthroughBusy = false;
let walkthroughLayoutFrame = null;
let walkthroughStepTransition = 0;
let activeWalkthroughSteps = [];
let activeWalkthroughPage = null;
let walkthroughReturnView = "timersView";
let pageWalkthroughReady = false;
let pageWalkthroughTimer = null;
const pendingFoodLogDeletions = new Map();
const pendingTemplateExerciseDeletions = new Map();
let draggedTemplateExerciseId = null;

function defaultStrengthState() {
  return { unit: "lb", workouts: [], mesocycles: [], activeMesocycleId: "" };
}

function emptyState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, timers: [...initialTimers], widgets: [], logs: {}, foods: [], meals: [], foodLogs: {}, nutritionGoal: null, recentFoodIds: [], recentMealIds: [], strength: defaultStrengthState(), legacyDefaultsRemoved: true };
}

function readStoredState(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (_) { return null; }
}

function normalizeServingUnit(value) {
  const unit = String(value || "").trim().toLowerCase();
  if (["g", "gram", "grams"].includes(unit)) return "g";
  if (["ml", "millilitre", "millilitres", "milliliter", "milliliters"].includes(unit)) return "mL";
  if (["cup", "cups"].includes(unit)) return "cups";
  if (["tsp", "teaspoon", "teaspoons"].includes(unit)) return "tsp";
  if (["tbsp", "tablespoon", "tablespoons"].includes(unit)) return "tbsp";
  if (["count", "counts", "item", "items", "piece", "pieces"].includes(unit)) return "count";
  return null;
}

function normalizeDays(days) {
  if (!Array.isArray(days)) return [...allDays];
  const normalized = [...new Set(days.map(Number).filter(day => allDays.includes(day)))];
  return normalized.length ? normalized : [...allDays];
}

function foodLogDateBounds(now = new Date()) {
  const max = dayKey(now);
  return { min: addCalendarDays(max, -7), max };
}

function migrateState(rawState) {
  if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) return emptyState();

  const rawLogs = rawState.logs && typeof rawState.logs === "object" && !Array.isArray(rawState.logs) ? rawState.logs : {};
  const logs = {};
  Object.entries(rawLogs).forEach(([date, records]) => {
    if (!records || typeof records !== "object" || Array.isArray(records)) return;
    logs[date] = {};
    Object.entries(records).forEach(([id, record]) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return;
      const logKey = id.startsWith("habit:") ? id : (("value" in record || "done" in record || "type" in record) ? habitLogKey(id) : null);
      if (!logKey) return;
      logs[date][logKey] = {
        ...record,
        value: Math.max(0, Number(record.value) || 0),
        done: record.done === true
      };
    });
  });

  let timers = (Array.isArray(rawState.timers) ? rawState.timers : []).filter(timer => timer && typeof timer === "object").map((timer, index) => {
    const duration = Math.max(1, Number(timer.duration) || 25 * 60);
    const configuredTarget = Number(timer.dailyTarget);
    const legacyGoal = Number(timer.dailyGoal);
    const dailyTarget = Number.isFinite(configuredTarget) ? Math.max(1, Math.round(configuredTarget)) : Number.isFinite(legacyGoal) && legacyGoal > 0 ? Math.max(1, Math.round(legacyGoal / duration)) : 1;
    const remaining = Number(timer.remaining);
    const lastTick = Number(timer.lastTick);
    const canResume = timer.running === true && Number.isFinite(lastTick) && lastTick > 0;
    const today = dayKey();
    return {
      id: entityId(timer.id),
      name: typeof timer.name === "string" && timer.name.trim() ? timer.name.trim() : `Timer ${index + 1}`,
      duration,
      remaining: Number.isFinite(remaining) ? Math.max(0, remaining) : duration,
      running: canResume,
      lastTick: canResume ? lastTick : null,
      color: typeof timer.color === "string" ? timer.color : palette[index % palette.length],
      pomodoro: timer.pomodoro === true,
      restDuration: Math.max(1, Math.round(Number(timer.restDuration) || 5 * 60)),
      phase: timer.pomodoro === true && timer.phase === "rest" ? "rest" : "work",
      countdownBeeps: timer.countdownBeeps === true,
      trackCompletions: timer.trackCompletions === true || timer.recurring === true,
      dailyTarget,
      completedToday: timer.completionDate === today ? Math.max(0, Math.round(Number(timer.completedToday) || 0)) : 0,
      completionDate: today
    };
  });

  let legacyDefaultsRemoved = rawState.legacyDefaultsRemoved === true;
  if (!legacyDefaultsRemoved) {
    const legacyIds = new Set(timers.filter(timer => legacyDefaults.some(([name, duration, color]) => timer.name === name && timer.duration === duration && timer.color === color)).map(timer => timer.id));
    timers = timers.filter(timer => !legacyIds.has(timer.id));
    legacyDefaultsRemoved = true;
  }

  const widgets = (Array.isArray(rawState.widgets) ? rawState.widgets : []).filter(widget => widget && typeof widget === "object").map((widget, index) => {
    const type = widget.type === "toggle" ? "toggle" : "counter";
    return {
      ...widget,
      id: entityId(widget.id),
      type,
      name: typeof widget.name === "string" && widget.name.trim() ? widget.name.trim() : `Habit ${index + 1}`,
      goal: type === "counter" ? Math.max(1, Math.round(Number(widget.goal) || 1)) : 1,
      days: normalizeDays(widget.days),
      color: typeof widget.color === "string" ? widget.color : palette[(timers.length + index) % palette.length]
    };
  });

  const foods = (Array.isArray(rawState.foods) ? rawState.foods : []).filter(food => food && typeof food === "object").map((food, index) => ({
    id: entityId(food.id),
    title: typeof food.title === "string" && food.title.trim() ? food.title.trim() : `Food ${index + 1}`,
    servingSize: Math.max(.01, Number(food.servingSize) || 1),
    servingUnit: normalizeServingUnit(food.servingUnit) || "g",
    ...Object.fromEntries(nutrientKeys.map(key => [key, Math.max(0, Number(food[key]) || 0)]))
  }));
  const foodLogs = {};
  Object.entries(rawState.foodLogs && typeof rawState.foodLogs === "object" ? rawState.foodLogs : {}).forEach(([date, entries]) => {
    if (!Array.isArray(entries)) return;
    foodLogs[date] = entries.filter(entry => entry && typeof entry === "object").map(entry => ({
      id: entityId(entry.id),
      foodId: String(entry.foodId || ""),
      servingSize: Math.max(.01, Number(entry.servingSize) || 1),
      loggedAt: Math.max(0, Number(entry.loggedAt) || 0),
      snapshot: entry.snapshot && typeof entry.snapshot === "object" ? entry.snapshot : null,
      mealId: entry.mealId == null ? "" : String(entry.mealId),
      mealTitle: typeof entry.mealTitle === "string" ? entry.mealTitle : "",
    }));
  });
  const rawGoal = rawState.nutritionGoal && typeof rawState.nutritionGoal === "object" ? rawState.nutritionGoal : null;
  const nutritionGoal = rawGoal ? Object.fromEntries(nutrientKeys.map(key => [key, Math.max(0, Number(rawGoal[key]) || 0)])) : null;
  const recentFoodIds = (Array.isArray(rawState.recentFoodIds) ? rawState.recentFoodIds : []).map(String).filter(id => foods.some(food => food.id === id)).slice(0, 6);
  const meals = (Array.isArray(rawState.meals) ? rawState.meals : []).filter(meal => meal && typeof meal === "object").map((meal, index) => ({
    id: entityId(meal.id),
    title: typeof meal.title === "string" && meal.title.trim() ? meal.title.trim() : `Meal ${index + 1}`,
    items: (Array.isArray(meal.items) ? meal.items : []).filter(item => item && foods.some(food => food.id === String(item.foodId))).map(item => ({ foodId: String(item.foodId), servingSize: Math.max(.01, Number(item.servingSize) || 1) }))
  })).filter(meal => meal.items.length);
  const recentMealIds = (Array.isArray(rawState.recentMealIds) ? rawState.recentMealIds : []).map(String).filter(id => meals.some(meal => meal.id === id)).slice(0, 6);

  const rawStrength = rawState.strength && typeof rawState.strength === "object" ? rawState.strength : {};
  const legacyMuscles = (Array.isArray(rawStrength.muscleGroups) && rawStrength.muscleGroups.length ? rawStrength.muscleGroups : defaultMuscles.map(([id, name, color]) => ({ id, name, color }))).filter(Boolean).map((muscle, index) => ({
    id: String(muscle.id || `muscle-${index + 1}`), name: String(muscle.name || `Muscle ${index + 1}`).trim(), color: muscle.color || palette[index % palette.length], hidden: muscle.hidden === true
  }));
  const muscleName = id => legacyMuscles.find(muscle => muscle.id === String(id))?.name || "Muscle";
  const muscleKey = name => String(name || "Muscle").trim().toLocaleLowerCase();
  const legacyExercises = (Array.isArray(rawStrength.exercises) ? rawStrength.exercises : []).filter(Boolean).map((exercise, index) => ({
    id: String(exercise.id || uid()), name: String(exercise.name || `Exercise ${index + 1}`).trim(), mode: exercise.mode === "bodyweight" ? "bodyweight" : "external",
    bodyweightFactor: Math.max(0, Number(exercise.bodyweightFactor) || 1),
    allocations: (Array.isArray(exercise.allocations) ? exercise.allocations : []).filter(item => item && Number(item.share) > 0).map(item => ({ muscleId: String(item.muscleId), name: muscleName(item.muscleId), share: Number(item.share) }))
  }));
  const legacyExercise = id => legacyExercises.find(exercise => exercise.id === String(id));
  const storedLoadsAreKg = rawStrength.unit !== "lb";
  const loadInLb = (value, isKg = storedLoadsAreKg) => Math.round(Math.max(0, Number(value) || 0) * (isKg ? 2.2046226218 : 1) * 10) / 10;
  const normalizeTemplateExercise = (item, index) => {
    const oldExercise = legacyExercise(item?.exerciseId);
    const allocation = oldExercise?.allocations?.[0];
    const name = String(item?.name || oldExercise?.name || `Exercise ${index + 1}`).trim();
    const muscleGroup = String(item?.muscleGroup || allocation?.name || "Other").trim();
    return { id: String(item?.id || uid()), name, muscleGroup, sets: Math.max(1, Math.round(Number(item?.sets) || 3)), reps: Math.max(0, Number(item?.reps) || 0), load: loadInLb(item?.load) };
  };
  const normalizeSessionExercise = (exercise, index, sessionUnit) => {
    const oldExercise = legacyExercise(exercise?.exerciseId);
    const rawAllocations = Array.isArray(exercise?.allocations) && exercise.allocations.length ? exercise.allocations : oldExercise?.allocations || [];
    const muscleGroup = String(exercise?.muscleGroup || rawAllocations[0]?.name || muscleName(rawAllocations[0]?.muscleId) || "Other").trim();
    const allocations = rawAllocations.length ? rawAllocations.map(item => { const name = String(item.name || muscleName(item.muscleId)).trim(); return { muscleId: muscleKey(name), name, share: Math.max(0, Number(item.share) || 0) }; }) : [{ muscleId: muscleKey(muscleGroup), name: muscleGroup, share: 1 }];
    return { ...exercise, id: String(exercise?.id || uid()), exerciseId: String(exercise?.exerciseId || exercise?.id || uid()), name: String(exercise?.name || oldExercise?.name || `Exercise ${index + 1}`).trim(), muscleGroup, mode: "external", unit: "lb", allocations,
      sets: (Array.isArray(exercise?.sets) ? exercise.sets : []).map(set => ({ id: String(set?.id || uid()), reps: Math.max(0, Number(set?.reps) || 0), load: loadInLb(set?.load, sessionUnit !== "lb"), completed: set?.completed === true })) };
  };
  const normalizeWorkout = (template, index) => ({ id: String(template.id || uid()), name: String(template.name || `Workout ${index + 1}`).trim(), exercises: (Array.isArray(template.exercises) ? template.exercises : []).map(normalizeTemplateExercise) });
  const rawMesocycles = (Array.isArray(rawStrength.mesocycles) ? rawStrength.mesocycles : []).filter(Boolean);
  const workoutSources = [
    ...rawMesocycles.flatMap(meso => Array.isArray(meso.templates) ? meso.templates : []),
    ...(Array.isArray(rawStrength.workouts) ? rawStrength.workouts : [])
  ].filter(Boolean);
  const workouts = [...new Map(workoutSources.map((template, index) => {
    const workout = normalizeWorkout(template, index);
    return [workout.id, workout];
  })).values()];
  let migratedSessionOrder = 0;
  const mesocycles = rawMesocycles.map((meso, index) => {
    const sessions = (Array.isArray(meso.sessions) ? meso.sessions : []).filter(Boolean).map((session, sessionIndex) => {
      const sessionOrder = migratedSessionOrder++;
      const sessionExercises = Array.isArray(session.exercises) ? session.exercises : [];
      const workout = workouts.find(item => item.id === String(session.templateId || ""))
        || workouts.find(item => item.name.trim().toLocaleLowerCase() === String(session.name || "").trim().toLocaleLowerCase())
        || workouts.find(item => sessionExercises.some(exercise => item.exercises.some(templateExercise => templateExercise.id === String(exercise?.exerciseId || "") || templateExercise.name.trim().toLocaleLowerCase() === String(exercise?.name || "").trim().toLocaleLowerCase())));
      const rawCreatedAt = Number(session.createdAt || session.completedAt || session.startedAt);
      const storedDate = validDateKey(session.date) ? session.date : "";
      const date = storedDate || (Number.isFinite(rawCreatedAt) && rawCreatedAt > 0 ? dayKey(new Date(rawCreatedAt)) : dayKey());
      const createdAt = Number.isFinite(rawCreatedAt) && rawCreatedAt > 0 ? rawCreatedAt : dateFromKey(date).getTime() + sessionOrder;
      const status = session.status === "in-progress" ? "in-progress" : "completed";
      return {
        ...session,
        id: String(session.id || uid()), templateId: String(workout?.id || session.templateId || ""),
        name: String(session.name || workout?.name || `Workout ${sessionIndex + 1}`).trim(),
        weekIndex: Math.max(0, Math.round(Number(session.weekIndex) || 0)), date, createdAt, status, unit: "lb",
        exercises: sessionExercises.map((exercise, exerciseIndex) => normalizeSessionExercise(exercise, exerciseIndex, session.unit || rawStrength.unit))
      };
    });
    return {
      id: String(meso.id || uid()), name: String(meso.name || `Mesocycle ${index + 1}`).trim(),
      progressionRate: Math.max(0, Number(meso.progressionRate) || .025),
      workoutIds: (Array.isArray(meso.workoutIds) ? meso.workoutIds : Array.isArray(meso.templates) ? meso.templates.map(template => template?.id) : workouts.map(workout => workout.id)).map(String).filter(id => workouts.some(workout => workout.id === id)),
      weeks: (Array.isArray(meso.weeks) && meso.weeks.length ? meso.weeks : Array.from({ length: 5 }, (_, week) => ({ deload: week === 4 }))).map(week => ({ deload: week?.deload === true, completed: week?.completed === true })),
      sessions, archived: meso.archived === true
    };
  });
  const strength = { unit: "lb", workouts, mesocycles, activeMesocycleId: mesocycles.some(meso => meso.id === rawStrength.activeMesocycleId) ? rawStrength.activeMesocycleId : (mesocycles.find(meso => !meso.archived)?.id || "") };

  return { schemaVersion: STATE_SCHEMA_VERSION, timers, widgets, logs, foods, meals, foodLogs, nutritionGoal, recentFoodIds, recentMealIds, strength, legacyDefaultsRemoved };
}

async function loadState() {
  if (window.__TEMPO_INITIAL_STATE__) {
    return migrateState(window.__TEMPO_INITIAL_STATE__);
  }
  const current = readStoredState(STORAGE_KEY);
  const legacy = LEGACY_STORAGE_KEYS.map(readStoredState).find(Boolean);
  const currentLooksValid = current && typeof current === "object" && (current.schemaVersion || Array.isArray(current.timers) || (current.logs && typeof current.logs === "object"));
  return migrateState(currentLooksValid ? current : legacy);
}

function saveState(sections) {
  state.schemaVersion = STATE_SCHEMA_VERSION;
  persistencePending = true;
  window.tempoServer?.saveState(state, sections);
}

function ensureWidgetLog(date, widget) {
  state.logs[date] ||= {};
  state.logs[date][habitLogKey(widget.id)] ||= { name: widget.name, color: widget.color, value: 0, done: false };
  const record = state.logs[date][habitLogKey(widget.id)];
  record.name = widget.name;
  record.color = widget.color;
  record.type = widget.type;
  record.goal = widget.type === "counter" ? widget.goal : 1;
  return record;
}

function isScheduled(timer, date = new Date()) {
  return (timer.days || allDays).includes(weekdayAt(date));
}

function formatSchedule(timer) {
  const days = timer.days || allDays;
  if (days.length === 7) return "Every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every(day => days.includes(day))) return "Weekdays";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "Weekends";
  return allDays.filter(day => days.includes(day)).map(day => shortDayNames[day]).join(", ");
}

function syncTimers(now = Date.now()) {
  let changed = false;
  state.timers.forEach(timer => {
    if (!timer.running || !timer.lastTick) return;
    let elapsed = Math.floor((now - timer.lastTick) / 1000);
    if (elapsed < 1) return;
    let cursor = timer.lastTick;
    changed = true;
    while (timer.running && elapsed >= 0) {
      const previousRemaining = timer.remaining;
      if (timer.remaining > elapsed) {
        timer.remaining -= elapsed;
        timer.lastTick = cursor + elapsed * 1000;
        maybePlayCountdownBeep(timer, previousRemaining);
        break;
      }
      const completedAt = cursor + timer.remaining * 1000;
      elapsed -= timer.remaining;
      if (timer.pomodoro && timer.phase !== "rest") {
        timer.phase = "rest";
        timer.remaining = timer.restDuration;
        timer.lastTick = completedAt;
        cursor = completedAt;
        if (elapsed < timer.restDuration) { beep(); toast(`${timer.name} work complete — rest started.`); }
        if (elapsed < 1) break;
      } else {
        completeTimer(timer, completedAt);
        break;
      }
    }
  });
  return changed;
}

function completeTimer(timer, completedAt = Date.now()) {
  timer.remaining = 0;
  timer.running = false;
  timer.lastTick = null;
  const completedDay = dayKey(new Date(completedAt));
  const today = dayKey();
  if (timer.completionDate !== today) { timer.completedToday = 0; timer.completionDate = today; }
  if (timer.trackCompletions && completedDay === today) timer.completedToday += 1;
  saveState("timers");
  beep();
  const targetReached = timer.trackCompletions && timer.completedToday >= timer.dailyTarget;
  toast(targetReached ? `${timer.name} complete — today’s target reached.` : timer.trackCompletions ? `${timer.name} complete — ${timer.completedToday} of ${timer.dailyTarget} today.` : `${timer.name} complete — nicely done.`);
}

function resetTimerCountsForCurrentDay(date = dayKey()) {
  let changed = false;
  state.timers.forEach(timer => {
    if (timer.completionDate === date) return;
    timer.completedToday = 0;
    timer.completionDate = date;
    if (!timer.running && timer.remaining <= 0) { timer.phase = "work"; timer.remaining = timer.duration; timer.lastTick = null; }
    changed = true;
  });
  return changed;
}

function primeAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    audioContext ||= new AudioContext();
    if (audioContext.state === "suspended") audioContext.resume();
    return audioContext;
  } catch (_) {}
  return null;
}

function playGentleChime(ctx) {
  const start = ctx.currentTime + .02;
  [
    [523.25, 0],
    [659.25, .13],
    [783.99, .27]
  ].forEach(([frequency, delay]) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, start + delay);
    gain.gain.exponentialRampToValueAtTime(.055, start + delay + .025);
    gain.gain.exponentialRampToValueAtTime(.0001, start + delay + .65);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start + delay);
    oscillator.stop(start + delay + .68);
  });
}

function beep() {
  const ctx = primeAudio();
  if (!ctx) return;
  if (ctx.state === "running") playGentleChime(ctx);
  else ctx.resume().then(() => playGentleChime(ctx)).catch(() => {});
}

function playCountdownBeep() {
  const ctx = primeAudio();
  if (!ctx) return;
  const play = () => {
    const start = ctx.currentTime + .01;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(.045, start + .01);
    gain.gain.exponentialRampToValueAtTime(.0001, start + .12);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + .13);
  };
  if (ctx.state === "running") play();
  else ctx.resume().then(play).catch(() => {});
}

function maybePlayCountdownBeep(timer, previousRemaining) {
  if (timer.countdownBeeps && timer.running && timer.remaining >= 1 && timer.remaining <= 5 && timer.remaining !== previousRemaining) playCountdownBeep();
}

function formatClock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function formatSpent(seconds) {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h) return `${h}h ${m ? `${m}m` : ""}`.trim();
  if (m) return `${m}m`;
  return `${seconds}s`;
}

function formatDayRemaining(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${Math.max(0, seconds)}s`;
}

function widgetRecord(widget, date = dayKey()) { return state.logs[date]?.[habitLogKey(widget.id)] || { value: 0, done: false }; }
function isHistoricalView() { return visibleDay !== dayKey(); }

function renderViewContext() {
  const historical = isHistoricalView();
  const label = formatCalendarDate(visibleDay, { weekday: "long", month: "long", day: "numeric" });
  $("#progressDateLabel").textContent = historical ? label.toUpperCase() : "";
  $("#progressDateLabel").hidden = !historical;
  $("#habitsHeading").textContent = historical ? `${label} habits` : "Today’s habits";
}

function itemProgress(item, date) {
  const key = dayKey(date);
  if (item.kind === "nutrition") return item.goal > 0 ? Math.min(1, item.value / item.goal) : 0;
  const record = widgetRecord(item, key);
  return item.type === "counter" ? Math.min(1, (record.value || 0) / item.goal) : record.done ? 1 : 0;
}

function scheduledGoalItems(date = new Date()) {
  return state.widgets.filter(widget => isScheduled(widget, date)).map(widget => ({ ...widget, kind: "widget" }));
}

function momentumGoalItems(date = new Date(), filter = momentumFilter) {
  const scheduled = scheduledGoalItems(date);
  const habits = scheduled.filter(item => item.kind === "widget");
  const nutrition = nutritionRingItems(dayKey(date));
  if (filter === "habits") return habits;
  if (filter === "nutrition") return nutrition;
  return [...habits, ...nutrition];
}

function dailyScore(date = new Date(), filter = momentumFilter) {
  const items = momentumGoalItems(date, filter);
  return items.length ? items.reduce((sum, item) => sum + itemProgress(item, date), 0) / items.length : 0;
}

function roundNutrition(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function formatNutrition(value, key) {
  const rounded = roundNutrition(value, key === "calories" ? 0 : 1);
  return `${rounded}${key === "calories" ? " kcal" : " g"}`;
}

function foodSnapshot(food) {
  return { title: food.title, servingSize: food.servingSize, servingUnit: food.servingUnit, ...Object.fromEntries(nutrientKeys.map(key => [key, food[key]])) };
}

function entryFood(entry) { return state.foods.find(food => food.id === entry.foodId) || entry.snapshot; }

function entryNutrients(entry) {
  const food = entryFood(entry);
  if (!food) return Object.fromEntries(nutrientKeys.map(key => [key, 0]));
  const ratio = entry.servingSize / Math.max(.01, Number(food.servingSize) || 1);
  return Object.fromEntries(nutrientKeys.map(key => [key, (Number(food[key]) || 0) * ratio]));
}

function mealNutrients(meal) {
  return meal.items.reduce((totals, item) => {
    const food = state.foods.find(candidate => String(candidate.id) === String(item.foodId));
    if (!food) return totals;
    const values = entryNutrients({ foodId: food.id, servingSize: item.servingSize });
    nutrientKeys.forEach(key => { totals[key] += values[key]; });
    return totals;
  }, Object.fromEntries(nutrientKeys.map(key => [key, 0])));
}

function nutritionTotals(date = foodLogDay) {
  return (state.foodLogs[date] || []).reduce((totals, entry) => {
    const values = entryNutrients(entry);
    nutrientKeys.forEach(key => { totals[key] += values[key]; });
    return totals;
  }, Object.fromEntries(nutrientKeys.map(key => [key, 0])));
}

function nutritionRingItems(date = visibleDay) {
  if (!state.nutritionGoal) return [];
  const totals = nutritionTotals(date);
  return nutrientKeys.filter(key => state.nutritionGoal[key] > 0).map(key => ({ id: `nutrition-${key}`, kind: "nutrition", key, name: nutrientLabels[key], color: nutrientColors[key], value: totals[key], goal: state.nutritionGoal[key] }));
}

function renderHabits() {
  const grid = $("#habitGrid");
  const viewDate = dateFromKey(visibleDay);
  const historical = isHistoricalView();
  grid.innerHTML = state.widgets.map(widget => {
    const record = widgetRecord(widget, visibleDay);
    const scheduled = isScheduled(widget, viewDate);
    const value = widget.type === "counter" ? record.value || 0 : record.done ? 1 : 0;
    const goal = widget.type === "counter" ? widget.goal : 1;
    const percent = Math.min(100, value / goal * 100);
    const complete = value >= goal;
    const controls = widget.type === "counter"
      ? `<div class="counter-actions"><button data-action="decrement" ${scheduled && value > 0 ? "" : "disabled"} aria-label="Subtract one from ${escapeHtml(widget.name)}">${icon("minus", "−")}</button><button data-action="increment" ${scheduled ? "" : "disabled"} aria-label="Add one to ${escapeHtml(widget.name)}">${icon("plus", "+")}</button></div>`
      : `<button class="toggle-action ${complete ? "done" : ""}" data-action="toggle-widget" ${scheduled ? "" : "disabled"}>${!scheduled ? `Not scheduled ${historical ? "this day" : "today"}` : complete ? `${icon("check", "✓")}Done for ${historical ? "this day" : "today"}` : "Mark as done"}</button>`;
    return `<article class="habit-card ${scheduled ? "" : "off-schedule"}" style="--widget-color:${widget.color}" data-id="${widget.id}" draggable="false">
      <div class="habit-top"><div><span class="habit-kind">${widget.type === "counter" ? `${icon("list-plus", "+")}Counter` : `${icon("check", "✓")}Toggle`}</span><h3>${escapeHtml(widget.name)}</h3><p class="schedule-copy">${formatSchedule(widget)}</p></div><div class="card-tools"><span class="drag-handle" role="button" tabindex="0" aria-label="Drag ${escapeHtml(widget.name)} to reorder" title="Drag to reorder">${icon("grip-vertical", "⋮")}</span><button class="menu-button" data-action="widget-menu" aria-label="Options for ${escapeHtml(widget.name)}">${icon("ellipsis", "…")}</button></div></div>
      <div class="menu habit-menu"><button data-action="edit-widget">Edit habit</button><button class="danger" data-action="delete-widget">Delete habit</button></div>
      ${widget.type === "counter" ? `<div class="habit-progress"><div class="habit-progress-line"><strong>${value}</strong><span>of ${goal} ${historical ? "this day" : "today"}</span></div><div class="progress-track"><i style="--value:${percent}%"></i></div></div>` : ""}
      ${controls}
    </article>`;
  }).join("");
  const scheduled = state.widgets.filter(widget => isScheduled(widget, viewDate));
  const done = scheduled.filter(widget => itemProgress({ ...widget, kind: "widget" }, viewDate) >= 1).length;
  $("#habitSummary").textContent = !state.widgets.length ? "Add a counter or toggle to start tracking." : `${done} of ${scheduled.length} scheduled habit${scheduled.length === 1 ? "" : "s"} complete`;
}

function renderTimers() {
  const grid = $("#timerGrid");
  const openMenuId = $(".menu.open", grid)?.closest(".timer-card")?.dataset.id;
  const focusedMenuAction = document.activeElement?.closest?.(".timer-card button[data-action]");
  const focusedMenuId = focusedMenuAction?.closest(".timer-card")?.dataset.id;
  const focusedAction = focusedMenuAction?.dataset.action;
  renderViewContext();
  grid.innerHTML = state.timers.map(timer => {
    const phaseDuration = timer.pomodoro && timer.phase === "rest" ? timer.restDuration : timer.duration;
    const progress = phaseDuration ? Math.min(360, (phaseDuration - timer.remaining) / phaseDuration * 360) : 0;
    const phaseLabel = timer.pomodoro ? timer.phase === "rest" ? "REST" : "WORK" : "";
    const timerState = timer.remaining === 0 ? "COMPLETE" : timer.running ? "RUNNING" : "REMAINING";
    const status = timer.pomodoro && timer.remaining > 0 ? `<span class="timer-phase">${phaseLabel}</span><span class="timer-state">${timerState}</span>` : `<span>${timerState}</span>`;
    const primaryAction = `<button class="control-button ${timer.remaining > 0 ? "icon-control-button" : ""}" data-action="toggle" aria-label="${timer.running ? "Pause timer" : timer.remaining === 0 ? "Run timer again" : "Start timer"}">${timer.running ? icon("pause", "Ⅱ") : timer.remaining === 0 ? "Run again" : icon("play", "▶")}</button>`;
    const durationLabel = timer.pomodoro ? `${formatSpent(timer.duration)} work · ${formatSpent(timer.restDuration)} rest` : formatSpent(timer.duration);
    return `<article class="timer-card ${timer.running ? "running" : ""}" style="--timer-color:${timer.color}" data-id="${timer.id}" draggable="false">
      <div class="card-top"><div class="timer-title"><span class="timer-dot"></span><div><h3>${escapeHtml(timer.name)}</h3><p>${durationLabel}${timer.trackCompletions ? ` · ${timer.completedToday} of ${timer.dailyTarget} today` : ""}</p></div></div><div class="card-tools"><span class="drag-handle" role="button" tabindex="0" aria-label="Drag ${escapeHtml(timer.name)} to reorder" title="Drag to reorder">${icon("grip-vertical", "⋮")}</span><button class="menu-button" data-action="menu" aria-label="Options for ${escapeHtml(timer.name)}">${icon("ellipsis", "…")}</button></div></div>
      <div class="menu ${timer.id === openMenuId ? "open" : ""}"><button data-action="edit">Edit timer</button><button class="danger" data-action="delete">Delete timer</button></div>
      <div class="dial-wrap"><div class="dial" style="--progress:${progress}deg"><div class="time-display"><strong>${formatClock(timer.remaining)}</strong>${status}</div></div></div>
      <div class="card-actions">${primaryAction}<button class="reset-button" data-action="reset" title="Reset timer" aria-label="Reset ${escapeHtml(timer.name)}">${icon("rotate-ccw", "↻")}</button></div>
    </article>`;
  }).join("");
  if (openMenuId && focusedMenuId === openMenuId && focusedAction) {
    const openCard = [...grid.querySelectorAll(".timer-card")].find(card => card.dataset.id === openMenuId);
    requestAnimationFrame(() => openCard?.querySelector(`[data-action="${focusedAction}"]`)?.focus());
  }
  renderHabits();
  renderDailyRings();
  renderWeeklyChart();
}

function drawDailyRingCanvas() {
  const items = dailyRingItems;
  const viewDate = dailyRingViewDate || dateFromKey(visibleDay);
  const canvas = $("#dailyRings");
  const size = Math.round(canvas.getBoundingClientRect().width || 240);
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const maxRadius = size / 2 - 10;
  const thickness = items.length ? Math.max(4, Math.min(15, (maxRadius - 17) / items.length * .7)) : 12;
  const gap = 1;
  const center = size / 2;
  const activeItemId = hoveredRingItemId || selectedRingItemId;
  dailyRingCanvasSize = size;
  dailyRingHitAreas = [];

  items.forEach((item, index) => {
    const radius = maxRadius - index * (thickness + gap);
    if (radius <= thickness) return;
    const progress = itemProgress(item, viewDate);
    const active = item.id === activeItemId;
    const ringWidth = thickness + (active ? 5 : 0);
    dailyRingHitAreas.push({ item, radius, thickness: ringWidth, progress });
    ctx.globalAlpha = activeItemId && !active ? .3 : 1;
    ctx.lineWidth = ringWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.strokeStyle = active ? "#c7c3b8" : "#dedbd1";
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.stroke();
    if (progress > 0) {
      ctx.beginPath();
      ctx.strokeStyle = item.color;
      if (active) { ctx.shadowColor = item.color; ctx.shadowBlur = 8; }
      ctx.arc(center, center, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  });
  ctx.globalAlpha = 1;
}

function updateRingHighlight() {
  const activeItemId = hoveredRingItemId || selectedRingItemId;
  $$(".ring-legend-row", $("#ringsLegend")).forEach(row => {
    row.classList.toggle("active", row.dataset.ringItemId === activeItemId);
    row.setAttribute("aria-pressed", String(row.dataset.ringItemId === selectedRingItemId));
  });
  drawDailyRingCanvas();
}

function renderDailyRings() {
  const viewDate = dateFromKey(visibleDay);
  const items = progressSummaryTab === "nutrition" ? nutritionRingItems(visibleDay) : scheduledGoalItems(viewDate).sort((a, b) => a.name.localeCompare(b.name));
  if (!items.some(item => item.id === selectedRingItemId)) selectedRingItemId = null;
  if (!items.some(item => item.id === hoveredRingItemId)) hoveredRingItemId = null;
  dailyRingItems = items;
  dailyRingViewDate = viewDate;
  $("#habitProgressTab").setAttribute("aria-selected", String(progressSummaryTab === "habits"));
  $("#nutritionProgressTab").setAttribute("aria-selected", String(progressSummaryTab === "nutrition"));
  drawDailyRingCanvas();

  const progressFor = item => itemProgress(item, viewDate);
  const reached = items.filter(item => progressFor(item) >= 1).length;
  const score = items.length ? Math.round(items.reduce((sum, item) => sum + progressFor(item), 0) / items.length * 100) : 0;
  $("#goalsReached").textContent = `${reached}/${items.length}`;
  $("#progressSpent").textContent = `${score}%`;
  $("#progressGoal").textContent = `${reached}/${items.length}`;
  const habitsRemaining = items.filter(item => progressFor(item) < 1).length;
  const caloriesRemaining = state.nutritionGoal ? Math.max(0, state.nutritionGoal.calories - nutritionTotals(visibleDay).calories) : 0;
  $("#progressRemainingLabel").textContent = progressSummaryTab === "habits" ? "HABITS REMAINING" : "CALORIES REMAINING";
  $("#scheduledTimeRemaining").textContent = progressSummaryTab === "habits" ? String(habitsRemaining) : formatNutrition(caloriesRemaining, "calories");
  $("#dailyRings").setAttribute("aria-label", items.length ? `Daily progress rings for ${items.map(item => item.name).join(", ")}` : "No daily progress rings scheduled");
  $("#ringsLegend").innerHTML = items.length ? items.map(item => {
    const progress = progressFor(item);
    const record = item.kind === "widget" ? widgetRecord(item, visibleDay) : null;
    const detail = item.kind === "nutrition" ? `${formatNutrition(item.value, item.key)} / ${formatNutrition(item.goal, item.key)}` : item.type === "counter" ? `${record.value || 0} / ${item.goal}` : record.done ? "Complete" : "Not done";
    return `<button type="button" class="ring-legend-row ${item.id === (hoveredRingItemId || selectedRingItemId) ? "active" : ""}" data-ring-item-id="${escapeHtml(item.id)}" aria-pressed="${item.id === selectedRingItemId}"><span class="legend-color" style="background:${item.color}"></span><strong>${escapeHtml(item.name)}</strong><span>${detail}</span><b>${Math.round(progress * 100)}%</b></button>`;
  }).join("") : `<div class="rings-empty">${progressSummaryTab === "nutrition" ? "Set a nutrition goal to see daily progress rings." : `No ${progressSummaryTab} are scheduled for this day.`}</div>`;
  updateTimeLeft();
}

function renderWeeklyChart() {
  const cardioGoal = Number(cardioData?.zone2GoalMinutes) > 0 ? Number(cardioData.zone2GoalMinutes) : null;
  const stepsGoal = Number(cardioData?.dailyStepsGoal) > 0 ? Number(cardioData.dailyStepsGoal) : null;
  const sleepGoal = sleepData?.goal && Number(sleepData.goal.minutes) > 0 ? sleepData.goal : null;
  const nutritionGoalKeys = nutrientKeys.filter(key => Number(state.nutritionGoal?.[key]) > 0);
  const nutritionTab = $('[data-momentum-filter="nutrition"]');
  const cardioTab = $('[data-momentum-filter="cardio"]');
  const sleepTab = $('[data-momentum-filter="sleep"]');
  nutritionTab.hidden = !nutritionGoalKeys.length;
  cardioTab.hidden = !cardioGoal && !stepsGoal;
  sleepTab.hidden = !sleepGoal;
  if (!nutritionGoalKeys.length && momentumFilter === "nutrition") momentumFilter = "all";
  if (!cardioGoal && !stepsGoal && momentumFilter === "cardio") momentumFilter = "all";
  if (!sleepGoal && momentumFilter === "sleep") momentumFilter = "all";
  $$('[data-momentum-filter]').forEach(button => button.setAttribute("aria-selected", String(button.dataset.momentumFilter === momentumFilter)));
  $("#momentumNutrientLegend").hidden = momentumFilter !== "nutrition";
  $("#momentumNutrientLegend").innerHTML = nutritionGoalKeys.map(key => `<span style="--nutrient-color:${nutrientColors[key]}"><i></i>${escapeHtml(nutrientLabels[key])}</span>`).join("");
  $("#momentumCardioSummary").hidden = momentumFilter !== "cardio" || !cardioGoal;
  $("#momentumSleepSummary").hidden = momentumFilter !== "sleep";
  const today = dayKey();
  const sunday = addCalendarDays(today, -weekdayForKey(today));
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(sunday, index));
  const cardioSecondsByDay = new Map(days.map(key => [key, 0]));
  if (cardioGoal) (cardioData.dailyZone2 || []).forEach(day => {
    if (cardioSecondsByDay.has(day.date)) cardioSecondsByDay.set(day.date, Math.max(0, Number(day.moderateSeconds) || 0));
  });
  const cardioWeekSeconds = [...cardioSecondsByDay.values()].reduce((sum, seconds) => sum + seconds, 0);
  $("#momentumCardioZone2").hidden = !cardioGoal;
  if (cardioGoal) {
    const cardioWeekMinutes = Math.round(cardioWeekSeconds / 60);
    $("#momentumCardioProgress").textContent = `${cardioWeekMinutes} / ${cardioGoal} min`;
    $("#momentumCardioProgressFill").style.width = `${Math.min(100, cardioWeekSeconds / (cardioGoal * 60) * 100)}%`;
    const track = $("#momentumCardioZone2 i");
    track.setAttribute("aria-valuemax", String(cardioGoal));
    track.setAttribute("aria-valuenow", String(Math.min(cardioGoal, cardioWeekMinutes)));
  }
  const stepsByDay = new Map((cardioData?.dailySteps || []).map(point => [point.date, Math.max(0, Number(point.count) || 0)]));
  const sleepResultsByDay = new Map(days.map(key => [key, sleepGoalResult(key, sleepData?.sessions || [], sleepGoal)]));
  const recordedSleepResults = [...sleepResultsByDay.values()].filter(result => result.recorded);
  if (sleepGoal) $("#momentumSleepProgress").textContent = `${recordedSleepResults.filter(result => result.met).length} / ${recordedSleepResults.length} nights`;
  $("#weeklyChart").setAttribute("aria-label", momentumFilter === "cardio" ? (stepsGoal ? "Daily steps goal progress from Sunday through Saturday" : "Daily Zone 2 cardio minutes from Sunday through Saturday") : momentumFilter === "sleep" ? "Nightly sleep duration and bedtime goal results from Sunday through Saturday" : `${momentumFilter === "all" ? "All" : momentumFilter} daily completion scores from Sunday through Saturday`);
  let cardioCumulativeSeconds = 0;
  $("#weeklyChart").innerHTML = days.map(key => {
    const date = dateFromKey(key);
    const cardioDaySeconds = cardioSecondsByDay.get(key) || 0;
    const sleepResult = sleepResultsByDay.get(key);
    cardioCumulativeSeconds += cardioDaySeconds;
    const daySteps = stepsByDay.get(key) || 0;
    const score = momentumFilter === "cardio" && stepsGoal
      ? Math.round(Math.min(1, daySteps / stepsGoal) * 100)
      : momentumFilter === "cardio" && cardioGoal
        ? Math.round(Math.min(1, cardioDaySeconds / (cardioGoal * 60)) * 100)
      : momentumFilter === "sleep" && sleepGoal
        ? (sleepResult.recorded ? Math.round(sleepResult.durationPercent) : 0)
        : Math.round(dailyScore(date, momentumFilter) * 100);
    const label = formatCalendarDate(key, { weekday: "short" });
    const isToday = key === today;
    const isFuture = key > today;
    const selected = key === visibleDay;
    const accessibleDate = formatCalendarDate(key, { weekday: "long", month: "long", day: "numeric" });
    let barMarkup = `<span class="bar-well"><i class="bar-fill" style="height:${score}%"></i></span>`;
    let progressDescription = `${score}% complete`;
    let valueLabel = `${score}%`;
    if (momentumFilter === "nutrition") {
      const totals = nutritionTotals(key);
      const nutrientProgress = nutritionGoalKeys.map(key => {
        const goal = Number(state.nutritionGoal?.[key]) || 0;
        return { key, percent: Math.round(Math.min(1, (Number(totals[key]) || 0) / goal) * 100) };
      });
      progressDescription = nutrientProgress.map(({ key, percent }) => `${nutrientLabels[key]} ${percent}%`).join(", ");
      barMarkup = `<span class="bar-well nutrition-bar-well" style="grid-template-columns:repeat(${nutrientProgress.length},minmax(2px,1fr))" aria-hidden="true">${nutrientProgress.map(({ key, percent }) => `<i style="--nutrient-color:${nutrientColors[key]}"><b style="height:${percent}%"></b></i>`).join("")}</span>`;
    } else if (momentumFilter === "cardio" && stepsGoal) {
      progressDescription = `${new Intl.NumberFormat().format(daySteps)} of ${new Intl.NumberFormat().format(stepsGoal)} daily steps, ${score}% complete`;
      valueLabel = daySteps >= 1000 ? `${(daySteps / 1000).toFixed(daySteps >= 10000 ? 0 : 1)}k` : String(daySteps);
      barMarkup = `<span class="bar-well"><i class="bar-fill cardio-steps-bar-fill" style="height:${score}%;${daySteps ? "" : "min-height:0"}"></i></span>`;
    } else if (momentumFilter === "cardio" && cardioGoal) {
      const dayMinutes = Math.round(cardioDaySeconds / 60);
      const cumulativeMinutes = Math.round(cardioCumulativeSeconds / 60);
      progressDescription = `${dayMinutes} Zone 2 minutes on this day, ${cumulativeMinutes} of ${cardioGoal} weekly minutes through this day, ${score}% of the weekly goal completed on this day`;
      valueLabel = `${dayMinutes}m`;
      barMarkup = `<span class="bar-well"><i class="bar-fill cardio-bar-fill" style="height:${score}%;${cardioDaySeconds ? "" : "min-height:0"}"></i></span>`;
    } else if (momentumFilter === "sleep" && sleepGoal) {
      if (sleepResult.recorded) {
        progressDescription = `${sleepResult.minutes} of ${sleepGoal.minutes} sleep minutes, duration ${sleepResult.durationMet ? "met" : "not met"}, bedtime ${sleepResult.bedtimeMet ? "met" : "not met"}`;
        valueLabel = `${Math.round(sleepResult.durationPercent)}%`;
      } else {
        progressDescription = "No recorded sleep";
        valueLabel = "—";
      }
      barMarkup = `<span class="bar-well" aria-hidden="true"><i class="bar-fill sleep-duration-fill" style="height:${sleepResult.recorded ? Math.round(sleepResult.durationPercent) : 0}%"></i></span>`;
    }
    const bedtimeDot = momentumFilter === "sleep" && sleepGoal && sleepResult.bedtimeMet && !isFuture ? `<i class="sleep-bedtime-dot" aria-hidden="true"></i>` : "";
    return `<button type="button" class="day-bar ${isToday ? "today" : ""} ${selected ? "selected" : ""} ${isFuture ? "future" : ""}" data-date="${key}" title="${escapeHtml(`${label}: ${progressDescription}`)}" aria-label="View ${accessibleDate}, ${escapeHtml(progressDescription)}" aria-pressed="${selected}" ${isFuture ? "disabled" : ""}>${barMarkup}<strong>${isFuture ? "—" : valueLabel}</strong><span class="day-bar-label">${label}${bedtimeDot}</span></button>`;
  }).join("");
}

function describeRingItem(item) {
  if (item.kind === "nutrition") return `${formatNutrition(item.value, item.key)} of ${formatNutrition(item.goal, item.key)}`;
  const record = widgetRecord(item, visibleDay);
  if (item.type === "counter") return `${record.value || 0} of ${item.goal}`;
  return record.done ? "Complete" : "Not done";
}

function ringHitFromPointer(event) {
  const canvas = $("#dailyRings");
  const canvasRect = canvas.getBoundingClientRect();
  const x = (event.clientX - canvasRect.left) * dailyRingCanvasSize / canvasRect.width;
  const y = (event.clientY - canvasRect.top) * dailyRingCanvasSize / canvasRect.height;
  const distance = Math.hypot(x - dailyRingCanvasSize / 2, y - dailyRingCanvasSize / 2);
  const nearest = dailyRingHitAreas.reduce((best, area) => !best || Math.abs(distance - area.radius) < Math.abs(distance - best.radius) ? area : best, null);
  return nearest && Math.abs(distance - nearest.radius) <= nearest.thickness / 2 + 3 ? nearest : null;
}

function updateRingTooltip(event) {
  const canvas = $("#dailyRings");
  const tooltip = $("#ringTooltip");
  const nearest = ringHitFromPointer(event);
  if (!nearest) {
    tooltip.hidden = true;
    if (hoveredRingItemId) { hoveredRingItemId = null; updateRingHighlight(); }
    return;
  }
  if (hoveredRingItemId !== nearest.item.id) { hoveredRingItemId = nearest.item.id; updateRingHighlight(); }
  const visualRect = canvas.parentElement.getBoundingClientRect();
  tooltip.textContent = `${nearest.item.name} · ${describeRingItem(nearest.item)} · ${Math.round(nearest.progress * 100)}%`;
  tooltip.style.left = `${Math.max(55, Math.min(visualRect.width - 55, event.clientX - visualRect.left))}px`;
  tooltip.style.top = `${Math.max(34, event.clientY - visualRect.top)}px`;
  tooltip.hidden = false;
}

function updateTimeLeft(now = new Date()) {
  if (isHistoricalView()) {
    $("#dayRemainingLabel").textContent = "HISTORICAL DAY";
    $("#dayTimeLeft").textContent = "Complete";
    return;
  }
  $("#dayRemainingLabel").textContent = "DAY REMAINING";
  const secondsLeft = Math.max(0, Math.ceil((nextTimezoneDayBoundary(now.getTime()) - now.getTime()) / 1000));
  $("#dayTimeLeft").textContent = formatDayRemaining(secondsLeft);
}

function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }

function toggleTimer(id) {
  syncTimers();
  const timer = state.timers.find(t => t.id === id);
  if (!timer) return;
  if (timer.running) { timer.running = false; timer.lastTick = null; }
  else {
    primeAudio();
    if (timer.remaining <= 0) { timer.phase = "work"; timer.remaining = timer.duration; }
    timer.running = true; timer.lastTick = Date.now();
    if (timer.countdownBeeps && timer.remaining <= 5) playCountdownBeep();
  }
  saveState("timers"); renderTimers();
}

function resetTimer(id) {
  syncTimers();
  const timer = state.timers.find(t => t.id === id);
  if (!timer) return;
  timer.phase = "work"; timer.remaining = timer.duration; timer.running = false; timer.lastTick = null;
  saveState("timers"); renderTimers(); toast(`${timer.name} reset.`);
}

function openDialog(timer = null) {
  $("#timerForm").reset();
  $("#editTimerId").value = timer?.id || "";
  $("#dialogTitle").textContent = timer ? "Edit timer" : "New timer";
  $("#timerName").value = timer?.name || "";
  const duration = timer?.duration || 25 * 60;
  $("#timerHours").value = Math.floor(duration / 3600);
  $("#timerMinutes").value = Math.floor(duration % 3600 / 60);
  $("#timerSeconds").value = duration % 60;
  const restDuration = timer?.restDuration || 5 * 60;
  $("#restHours").value = Math.floor(restDuration / 3600);
  $("#restMinutes").value = Math.floor(restDuration % 3600 / 60);
  $("#restSeconds").value = restDuration % 60;
  $("#timerPomodoro").checked = timer?.pomodoro === true;
  $("#timerCountdownBeeps").checked = timer?.countdownBeeps === true;
  updatePomodoroVisibility();
  $("#trackCompletions").checked = timer?.trackCompletions === true;
  $("#timerDailyTarget").value = timer?.dailyTarget || 1;
  updateTimerTargetVisibility();
  const color = timer?.color || palette[state.timers.length % palette.length];
  $$("input[name=color]").forEach(input => input.checked = input.value === color);
  $("#formError").textContent = "";
  $("#timerDialog").showModal();
  requestAnimationFrame(() => $("#timerName").focus());
}

function saveTimer(event) {
  event.preventDefault();
  const name = $("#timerName").value.trim();
  const duration = Number($("#timerHours").value) * 3600 + Number($("#timerMinutes").value) * 60 + Number($("#timerSeconds").value);
  const pomodoro = $("#timerPomodoro").checked;
  const restDuration = Number($("#restHours").value) * 3600 + Number($("#restMinutes").value) * 60 + Number($("#restSeconds").value);
  const countdownBeeps = $("#timerCountdownBeeps").checked;
  const trackCompletions = $("#trackCompletions").checked;
  const dailyTarget = Math.max(1, Math.round(Number($("#timerDailyTarget").value) || 1));
  if (!name) { $("#formError").textContent = "Give your timer a name."; return; }
  if (!duration || duration < 1) { $("#formError").textContent = "Choose a duration of at least one second."; return; }
  if (pomodoro && (!restDuration || restDuration < 1)) { $("#formError").textContent = "Choose a rest duration of at least one second."; return; }
  const id = $("#editTimerId").value;
  const existing = state.timers.find(t => t.id === id);
  const color = $("input[name=color]:checked").value;
  if (existing) {
    syncTimers();
    const timingChanged = existing.duration !== duration || existing.pomodoro !== pomodoro || (pomodoro && existing.restDuration !== restDuration);
    existing.name = name; existing.color = color; existing.pomodoro = pomodoro; existing.restDuration = restDuration || 5 * 60; existing.countdownBeeps = countdownBeeps; existing.trackCompletions = trackCompletions; existing.dailyTarget = dailyTarget;
    if (timingChanged) { existing.phase = "work"; existing.duration = duration; existing.remaining = duration; existing.running = false; existing.lastTick = null; }
  } else state.timers.push({ id: uid(), name, duration, remaining: duration, running: false, lastTick: null, color, pomodoro, restDuration: restDuration || 5 * 60, phase: "work", countdownBeeps, trackCompletions, dailyTarget, completedToday: 0, completionDate: dayKey() });
  saveState("timers"); $("#timerDialog").close(); renderTimers(); toast(existing ? "Timer updated." : "Timer added.");
}

function updateTimerTargetVisibility() { $("#goalConfig").hidden = !$("#trackCompletions").checked; }
function updatePomodoroVisibility() {
  const pomodoro = $("#timerPomodoro").checked;
  $("#restDurationConfig").hidden = !pomodoro;
  $("#timerDurationLabel").textContent = pomodoro ? "Work duration" : "Duration";
}

function openDeleteConfirmation(title, message, action) {
  pendingDeleteAction = action;
  $("#deleteConfirmationTitle").textContent = title;
  $("#deleteConfirmationMessage").textContent = message;
  const dialog = $("#deleteConfirmationDialog");
  dialog.showModal();
  requestAnimationFrame(() => $("#confirmDeleteButton").focus());
}

function deleteTimer(id) {
  const timer = state.timers.find(t => t.id === id);
  if (!timer) return;
  openDeleteConfirmation(`Delete “${timer.name}”?`, "This timer will be removed from your dashboard.", () => {
    state.timers = state.timers.filter(t => t.id !== id); saveState("timers"); renderTimers(); toast("Timer deleted.");
  });
}

function updateWidgetTypeFields() {
  const type = $("input[name=widgetType]:checked")?.value || "counter";
  $("#counterGoalField").hidden = type !== "counter";
}

function openWidgetDialog(widget = null) {
  if (!Array.isArray(state.widgets)) state.widgets = [];
  $("#widgetForm").reset();
  $("#editWidgetId").value = widget?.id || "";
  $("#widgetDialogTitle").textContent = widget ? "Edit habit" : "New habit";
  $("#widgetName").value = widget?.name || "";
  $("#widgetGoal").value = widget?.goal || 8;
  const type = widget?.type || "counter";
  $$('input[name="widgetType"]').forEach(input => { input.checked = input.value === type; input.disabled = Boolean(widget); });
  const days = widget?.days || allDays;
  $$('input[name="widgetWeekday"]').forEach(input => input.checked = days.includes(Number(input.value)));
  const color = widget?.color || palette[(state.timers.length + state.widgets.length) % palette.length];
  $("#widgetColorOptions").innerHTML = palette.map((swatch, index) => `<label><input type="radio" name="widgetColor" value="${swatch}" ${swatch === color || (!palette.includes(color) && index === 0) ? "checked" : ""} /><span style="--swatch:${swatch}"></span></label>`).join("");
  $("#widgetFormError").textContent = "";
  updateWidgetTypeFields();
  const dialog = $("#widgetDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  requestAnimationFrame(() => $("#widgetName").focus());
}

function saveWidget(event) {
  event.preventDefault();
  const id = $("#editWidgetId").value;
  const existing = state.widgets.find(widget => widget.id === id);
  const type = existing?.type || $("input[name=widgetType]:checked").value;
  const name = $("#widgetName").value.trim();
  const goal = type === "counter" ? Number($("#widgetGoal").value) : 1;
  const days = $$('input[name="widgetWeekday"]:checked').map(input => Number(input.value));
  const color = $("input[name=widgetColor]:checked")?.value;
  if (!name) { $("#widgetFormError").textContent = "Give your habit a name."; return; }
  if (type === "counter" && (!Number.isInteger(goal) || goal < 1)) { $("#widgetFormError").textContent = "Choose a whole-number goal of at least one."; return; }
  if (!days.length) { $("#widgetFormError").textContent = "Choose at least one active day."; return; }
  if (existing) Object.assign(existing, { name, goal, days, color });
  else state.widgets.push({ id: uid(), type, name, goal, days, color });
  saveState("habits");
  $("#widgetDialog").close();
  renderTimers();
  toast(existing ? "Habit updated." : `${type === "counter" ? "Counter" : "Toggle"} added.`);
}

function changeWidgetValue(id, change) {
  const widget = state.widgets.find(item => item.id === id);
  const viewDate = dateFromKey(visibleDay);
  if (!widget || !isScheduled(widget, viewDate)) return;
  const record = ensureWidgetLog(visibleDay, widget);
  if (widget.type === "counter") record.value = Math.max(0, (record.value || 0) + change);
  else record.done = !record.done;
  renderTimers();
  if (itemProgress({ ...widget, kind: "widget" }, viewDate) >= 1) toast(`${widget.name} complete.`);
  if(/^\d+$/.test(String(widget.id)))window.tempoServer.updateHabitLog(visibleDay,widget.id,record).catch(error=>window.dispatchEvent(new CustomEvent("tempo:save-error",{detail:{message:error.message}})));
  else saveState("habitLogs");
}

function deleteWidget(id) {
  const widget = state.widgets.find(item => item.id === id);
  if (!widget) return;
  openDeleteConfirmation(`Delete “${widget.name}”?`, "The habit will be removed, but your past daily records will be kept.", () => {
    state.widgets = state.widgets.filter(item => item.id !== id);
    saveState("habits"); renderTimers(); toast("Habit deleted.");
  });
}

const cardioDateFormatter = new Intl.DateTimeFormat(undefined, { timeZone: appTimezone, month: "short", day: "numeric", year: "numeric" });
const cardioDateTimeFormatter = new Intl.DateTimeFormat(undefined, { timeZone: appTimezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

function formatCardioDuration(seconds) {
  const totalMinutes = Math.max(0, Math.round(Number(seconds) / 60));
  const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function cardioChart(points, valueFor, timeFor, labelFor, emptyMessage) {
  if (!points.length) return `<p class="cardio-chart-empty">${escapeHtml(emptyMessage)}</p>`;
  const width = 720, height = 250, left = 43, right = 15, top = 17, bottom = 31;
  const values = points.map(valueFor).filter(Number.isFinite);
  const times = points.map(timeFor);
  const minimumTime = Math.min(...times), maximumTime = Math.max(...times);
  let minimumValue = Math.floor((Math.min(...values) - 5) / 5) * 5;
  let maximumValue = Math.ceil((Math.max(...values) + 5) / 5) * 5;
  if (minimumValue === maximumValue) { minimumValue -= 5; maximumValue += 5; }
  const x = time => left + (maximumTime === minimumTime ? (width - left - right) / 2 : (time - minimumTime) / (maximumTime - minimumTime) * (width - left - right));
  const y = value => top + (maximumValue - value) / (maximumValue - minimumValue) * (height - top - bottom);
  const coordinates = points.map(point => [x(timeFor(point)), y(valueFor(point))]);
  const line = coordinates.map(([pointX, pointY], index) => `${index ? "L" : "M"}${pointX.toFixed(2)},${pointY.toFixed(2)}`).join(" ");
  const area = `${line} L${coordinates.at(-1)[0].toFixed(2)},${height - bottom} L${coordinates[0][0].toFixed(2)},${height - bottom} Z`;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = minimumValue + (maximumValue - minimumValue) * index / 4;
    const lineY = y(value);
    return `<line class="grid" x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}"/><text x="${left - 7}" y="${lineY + 3}" text-anchor="end">${Math.round(value)}</text>`;
  }).join("");
  const pointStep = Math.max(1, Math.ceil(points.length / 45));
  const circles = coordinates.map(([pointX, pointY], index) => index % pointStep ? "" : `<circle class="trend-point" cx="${pointX}" cy="${pointY}" r="3"><title>${escapeHtml(labelFor(points[index]))}</title></circle>`).join("");
  return `<svg class="cardio-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(emptyMessage.replace(/^No /, "Chart of "))}">${grid}<path class="trend-area" d="${area}"/><path class="trend-line" d="${line}"/>${circles}<text x="${left}" y="${height - 8}">${escapeHtml(labelFor(points[0], true))}</text><text x="${width - right}" y="${height - 8}" text-anchor="end">${escapeHtml(labelFor(points.at(-1), true))}</text></svg>`;
}

function cardioPointsInRange(points, range) {
  if (range === "all" || !points.length) return points;
  const cutoff = Date.parse(`${dayKey()}T00:00:00Z`) - (Number(range) - 1) * 86400000;
  return points.filter(point => Date.parse(`${point.date}T00:00:00Z`) >= cutoff);
}

function restingHeartRatesInRange() { return cardioPointsInRange(cardioData?.restingHeartRates || [], cardioRestingRange); }

function renderRestingHeartRateChart() {
  const points = restingHeartRatesInRange();
  return cardioChart(
    points,
    point => point.beatsPerMinute,
    point => Date.parse(`${point.date}T00:00:00Z`),
    (point, axis = false) => axis ? cardioDateFormatter.format(new Date(`${point.date}T12:00:00Z`)) : `${cardioDateFormatter.format(new Date(`${point.date}T12:00:00Z`))}: ${point.beatsPerMinute} bpm`,
    "No resting heart-rate measurements have been synced for this range."
  );
}

function cardioRangeOptions(selectedRange) {
  return [["30", "30 days"], ["90", "90 days"], ["365", "1 year"], ["all", "All data"]].map(([value, label]) => `<option value="${value}" ${selectedRange === value ? "selected" : ""}>${label}</option>`).join("");
}

function cardioHour(timestamp) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: appTimezone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(timestamp)).find(value => value.type === "hour");
  return Number(part?.value || 0) % 24;
}

function stepWeekTimelineRange(sessions) {
  const ranges = sessions.filter(session => !session.nap).map(session => {
    const midnight = sleepClockHourStart(session.date, 0);
    const wakeHour = (Number(session.endTime) - midnight) / 3600000;
    let bedtimeHour = (Number(session.startTime) - midnight) / 3600000;
    while (bedtimeHour <= wakeHour) bedtimeHour += 24;
    return { wakeHour, bedtimeHour };
  }).filter(range => Number.isFinite(range.wakeHour) && Number.isFinite(range.bedtimeHour));
  if (!ranges.length) return { startHour: 0, endHour: 24 };
  const startHour = Math.max(0, Math.floor(Math.min(...ranges.map(range => range.wakeHour))));
  const endHour = Math.min(30, Math.ceil(Math.max(...ranges.map(range => range.bedtimeHour))));
  return endHour > startHour ? { startHour, endHour } : { startHour: 0, endHour: 24 };
}

function cardioStepHourSelectionMarkup(cells) {
  const selected = cells.flat().find(cell => cell.hourStart === selectedCardioStepHourStart);
  if (!selected) return `<p class="cardio-step-selection" id="cardioStepsSelection" role="status" aria-live="polite" hidden></p>`;
  const date = dayKey(new Date(selected.hourStart));
  const range = `${sleepTimeFormatter.format(new Date(selected.hourStart))}–${sleepTimeFormatter.format(new Date(selected.hourEnd))}`;
  return `<p class="cardio-step-selection" id="cardioStepsSelection" role="status" aria-live="polite"><strong>${new Intl.NumberFormat().format(selected.count)}</strong> steps · ${escapeHtml(formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" }))}, ${escapeHtml(range)}</p>`;
}

function selectCardioStepHour(cell) {
  selectedCardioStepHourStart = Number(cell.dataset.cardioStepHour);
  $$('[data-cardio-step-hour]', $("#cardioContent")).forEach(button => {
    const selected = Number(button.dataset.cardioStepHour) === selectedCardioStepHourStart;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const output = $("#cardioStepsSelection");
  if (!output) return;
  const start = selectedCardioStepHourStart, end = Number(cell.dataset.cardioStepHourEnd), count = Number(cell.dataset.cardioStepCount) || 0;
  const date = dayKey(new Date(start));
  const range = `${sleepTimeFormatter.format(new Date(start))}–${sleepTimeFormatter.format(new Date(end))}`;
  output.hidden = false;
  output.innerHTML = `<strong>${new Intl.NumberFormat().format(count)}</strong> steps · ${escapeHtml(formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" }))}, ${escapeHtml(range)}`;
}

function renderHourlyStepsHeatmap() {
  const today = dayKey(), firstDay = addCalendarDays(today, -6);
  const dates = Array.from({ length: 7 }, (_, index) => addCalendarDays(firstDay, index));
  const sleepSessions = (sleepData?.sessions || []).filter(session => Number.isFinite(Number(session.startTime)) && Number.isFinite(Number(session.endTime)));
  const weekSleepSessions = sleepSessions.filter(session => dates.includes(session.date) && !session.nap);
  const { startHour, endHour } = stepWeekTimelineRange(weekSleepSessions);
  const visibleHours = Array.from({ length: endHour - startHour }, (_, index) => startHour + index);
  const dateSet = new Set(dates), hourly = new Map();
  for (const point of cardioData?.hourlySteps || []) {
    const date = dayKey(new Date(point.startTime));
    if (!dateSet.has(date)) continue;
    const key = `${date}:${cardioHour(point.startTime)}`;
    hourly.set(key, (hourly.get(key) || 0) + Math.max(0, Number(point.count) || 0));
  }
  const daily = new Map((cardioData?.dailySteps || []).map(point => [point.date, Math.max(0, Number(point.count) || 0)]));
  const number = new Intl.NumberFormat();
  const rowsData = dates.map(date => visibleHours.map((offsetHour, index) => {
    const hourStart = sleepTimelineBoundary(date, offsetHour);
    const hourEnd = sleepTimelineBoundary(date, offsetHour + 1);
    const asleep = sleepSessions.some(session => Number(session.startTime) < hourEnd && Number(session.endTime) > hourStart);
    const cellDate = addCalendarDays(date, Math.floor(offsetHour / 24));
    const hour = ((offsetHour % 24) + 24) % 24;
    return { index, offsetHour, hourStart, hourEnd, asleep, count: asleep ? 0 : hourly.get(`${cellDate}:${hour}`) || 0 };
  }));
  const axis = visibleHours.map(hour => `<span>${hour % 3 ? "" : sleepTimelineLabel(hour)}</span>`).join("");
  const rows = dates.map(date => {
    const cells = rowsData[dates.indexOf(date)];
    const hours = cells.map(cell => {
      const count = cell.count;
      const level = count > 1500 ? 5 : count > 1000 ? 4 : count > 500 ? 3 : count > 250 ? 2 : count > 0 ? 1 : 0;
      const label = `${formatCalendarDate(dayKey(new Date(cell.hourStart)), { weekday: "long", month: "short", day: "numeric" })}, ${sleepTimeFormatter.format(new Date(cell.hourStart))}: ${number.format(count)} steps`;
      const selected = cell.hourStart === selectedCardioStepHourStart;
      return `<button class="cardio-step-hour level-${level} ${selected ? "selected" : ""}" type="button" style="grid-column:${cell.index + 1}" data-cardio-step-hour="${cell.hourStart}" data-cardio-step-hour-end="${cell.hourEnd}" data-cardio-step-count="${count}" aria-label="${escapeHtml(label)}" aria-pressed="${selected}" title="${escapeHtml(label)}"></button>`;
    }).join("");
    const hourlyTotal = cells.reduce((sum, cell) => sum + cell.count, 0);
    const total = daily.get(date) ?? hourlyTotal;
    return `<div class="cardio-steps-heatmap-row" role="row"><strong>${escapeHtml(formatCalendarDate(date, { weekday: "short" }))}<small>${number.format(total)} steps</small></strong><div role="row" aria-label="${escapeHtml(formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" }))}">${hours}</div></div>`;
  }).join("");
  return `<div class="cardio-steps-heatmap-scroll" style="--step-columns:${visibleHours.length}"><div class="cardio-steps-hour-axis" aria-hidden="true">${axis}</div><div class="cardio-steps-heatmap" role="grid" aria-label="Hourly steps while awake for the last seven days">${rows}</div></div>${cardioStepHourSelectionMarkup(rowsData)}<div class="cardio-steps-legend"><span>Fewer</span>${Array.from({ length: 5 }, (_, index) => `<i class="cardio-step-hour level-${index + 1}"></i>`).join("")}<span>More</span></div>`;
}

function recentAwakeTimeSummary() {
  if (!sleepData?.sessions) return null;
  const today = dayKey(), start = addCalendarDays(today, -6);
  const sleepByDay = new Map();
  sleepData.sessions.forEach(session => sleepByDay.set(session.date, (sleepByDay.get(session.date) || 0) + Math.max(0, Number(session.minutesAsleep) || 0)));
  const recorded = [...sleepByDay].filter(([date]) => date >= start && date <= today).map(([, minutes]) => minutes);
  if (!recorded.length) return null;
  const averageSleepMinutes = recorded.reduce((sum, minutes) => sum + minutes, 0) / recorded.length;
  const averageAwakeMinutes = Math.max(0, 1440 - averageSleepMinutes);
  return { averageAwakeMinutes, walkingMinutes: Math.max(0, averageAwakeMinutes - 180), recordedNights: recorded.length };
}

function formatHoursCompact(minutes) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(minutes / 60);
}

function renderCardioStepsGoal() {
  const goal = Number(cardioData?.dailyStepsGoal) > 0 ? Number(cardioData.dailyStepsGoal) : null;
  const todaySteps = Math.max(0, Number((cardioData?.dailySteps || []).find(point => point.date === dayKey())?.count) || 0);
  const awake = recentAwakeTimeSummary();
  const pace = liveStepsPace({ goal, todaySteps, walkingMinutes: awake?.walkingMinutes, sessions: sleepData?.sessions, today: dayKey() });
  const paceWindow = pace ? pace.remainingMinutes > 0 ? `in ${formatHoursCompact(pace.remainingMinutes)} hours remaining` : pace.remainingSteps ? "Walking window ended" : "Goal reached" : "Sync today’s sleep to calculate";
  const percent = goal ? Math.min(100, todaySteps / goal * 100) : 0;
  const number = new Intl.NumberFormat();
  return `<section class="cardio-panel cardio-steps-goal-panel">
    <div class="cardio-steps-goal-heading"><div><p class="eyebrow">DAILY MOVEMENT</p><h2>Steps goal</h2></div><span class="cardio-steps-goal-actions"><button class="secondary-button cardio-steps-refresh-button ${cardioSyncing ? "is-syncing" : ""}" type="button" data-cardio-steps-refresh aria-label="Refresh steps" title="Refresh steps" ${cardioSyncing ? "disabled" : ""}>${icon("refresh-cw", "↻")}</button><button class="secondary-button" type="button" data-cardio-steps-goal>${goal ? "Edit goal" : "Add goal"}</button></span></div>
    ${goal ? `<div class="cardio-steps-progress"><div><strong>${number.format(todaySteps)}<small> / ${number.format(goal)} steps</small></strong><span class="cardio-steps-hourly"><small>Steps per hour</small><b>${pace?.hourlySteps == null ? "—" : number.format(pace.hourlySteps)}</b><small>${paceWindow}</small></span></div><div class="cardio-steps-progress-track" role="progressbar" aria-label="Daily steps goal" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(goal, todaySteps)}"><i style="width:${percent}%"></i></div><small>${todaySteps >= goal ? "Goal reached" : `${number.format(goal - todaySteps)} steps remaining`}</small></div>` : `<div class="cardio-zone2-empty"><strong>${number.format(todaySteps)} steps today</strong><p>Add a daily target to calculate the pace you need each hour.</p></div>`}
  </section>`;
}

function openCardioStepsGoalDialog() {
  $("#cardioStepsGoal").value = cardioData?.dailyStepsGoal || 10000;
  $("#cardioStepsGoalError").textContent = "";
  $("#cardioStepsGoalDialog").showModal();
  requestAnimationFrame(() => $("#cardioStepsGoal").focus());
}

async function saveCardioStepsGoal(event) {
  event.preventDefault();
  const steps = Number($("#cardioStepsGoal").value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 1000000) { $("#cardioStepsGoalError").textContent = "Enter 1–1,000,000 whole steps."; return; }
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    cardioData = await window.tempoServer.setCardioStepsGoal(steps);
    $("#cardioStepsGoalDialog").close();
    renderCardio(); renderWeeklyChart(); if ($("#settingsView").classList.contains("active")) renderSettings(); toast("Daily steps goal saved.");
  } catch (error) { $("#cardioStepsGoalError").textContent = error.message || "Could not save the daily steps goal."; }
  finally { submit.disabled = false; }
}

function renderCardioSessionDetailPage() {
  const content = $("#cardioSessionContent");
  if (!selectedCardioSessionId || !selectedCardioSession) {
    $("#cardioSessionHeading").textContent = "Treadmill session";
    $("#cardioSessionMeta").textContent = "";
    $("#deleteCardioSessionButton").hidden = true;
    content.innerHTML = `<div class="cardio-loading">Loading session from D1…</div>`;
    return;
  }
  const session = selectedCardioSession;
  const samples = Array.isArray(session.samples) ? session.samples : [];
  const zoneEntries = [
    ["Light", session.zones.light, "#79aeb8"], ["Moderate", session.zones.moderate, "#d6a13b"],
    ["Vigorous", session.zones.vigorous, "#ec7d4f"], ["Peak", session.zones.peak, "#c94f4f"]
  ];
  const zoneTotal = zoneEntries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  const chart = cardioChart(samples, sample => sample.bpm, sample => sample.at, (sample, axis = false) => axis ? new Intl.DateTimeFormat(undefined, { timeZone: appTimezone, hour: "numeric", minute: "2-digit" }).format(new Date(sample.at)) : `${cardioDateTimeFormatter.format(new Date(sample.at))}: ${sample.bpm} bpm`, "No heart-rate samples were recorded for this treadmill session.");
  $("#cardioSessionHeading").textContent = session.displayName;
  $("#cardioSessionMeta").textContent = `${cardioDateTimeFormatter.format(new Date(session.startTime))} · ${formatCardioDuration(session.activeDurationSeconds)}`;
  $("#deleteCardioSessionButton").hidden = false;
  content.innerHTML = `<section class="cardio-panel cardio-session-detail-page">
    <div class="cardio-detail-metrics">
      <div><span>Average HR</span><strong>${session.averageHeartRate ?? "—"}${session.averageHeartRate ? " bpm" : ""}</strong></div>
      <div><span>Heart-rate range</span><strong>${session.minimumHeartRate && session.maximumHeartRate ? `${session.minimumHeartRate}–${session.maximumHeartRate} bpm` : "—"}</strong></div>
      <div><span>Distance</span><strong>${session.distanceMeters == null ? "—" : `${(session.distanceMeters / 1000).toFixed(2)} km`}</strong></div>
      <div><span>Calories</span><strong>${session.caloriesKcal == null ? "—" : `${Math.round(session.caloriesKcal)} kcal`}</strong></div>
      <div><span>Steps</span><strong>${session.steps == null ? "—" : new Intl.NumberFormat().format(session.steps)}</strong></div>
    </div>
    <div class="cardio-chart-wrap">${chart}</div>
    ${zoneTotal ? `<div class="cardio-zone-bar" aria-label="Heart-rate zone distribution">${zoneEntries.map(([, value, color]) => `<i style="--zone-width:${Number(value || 0) / zoneTotal * 100}%;--zone-color:${color}"></i>`).join("")}</div><div class="cardio-zone-legend">${zoneEntries.map(([name, value, color]) => `<span><i style="--zone-color:${color}"></i>${name} ${formatCardioDuration(value)}</span>`).join("")}</div>` : ""}
  </section>`;
}

function cardioSessionDateKey(session) { return dayKey(new Date(session.startTime)); }

function changeCardioCalendarMonth(amount) {
  const date = dateFromKey(`${cardioCalendarMonth}-01`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  cardioCalendarMonth = date.toISOString().slice(0, 7);
  renderCardio();
}

function renderCardioCalendar(sessions) {
  const monthStart = `${cardioCalendarMonth}-01`;
  const gridStart = addCalendarDays(monthStart, -weekdayForKey(monthStart));
  const sessionsByDate = new Map();
  sessions.forEach(session => {
    const key = cardioSessionDateKey(session);
    if (!sessionsByDate.has(key)) sessionsByDate.set(key, []);
    sessionsByDate.get(key).push(session);
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => `<div class="cardio-calendar-weekday">${day}</div>`).join("");
  const days = Array.from({ length: 42 }, (_, index) => {
    const key = addCalendarDays(gridStart, index);
    const daySessions = sessionsByDate.get(key) || [];
    const label = formatCalendarDate(key, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return `<div class="cardio-calendar-day${key.slice(0, 7) === cardioCalendarMonth ? "" : " is-outside"}${key === dayKey() ? " is-today" : ""}" aria-label="${escapeHtml(label)}">
      <span class="cardio-calendar-date">${Number(key.slice(-2))}</span>
      <div class="cardio-calendar-sessions">${daySessions.map(session => `<button type="button" data-cardio-session-id="${session.id}" data-cardio-average="${session.averageHeartRate ?? "—"}" aria-label="Open ${escapeHtml(session.displayName)} on ${escapeHtml(label)}, average heart rate ${session.averageHeartRate ?? "not available"} beats per minute"><strong>${escapeHtml(session.displayName)}</strong><span>${session.averageHeartRate ?? "—"} avg bpm</span></button>`).join("")}</div>
    </div>`;
  }).join("");
  return `<section class="cardio-panel cardio-calendar-panel">
    <div class="cardio-calendar-heading"><h2>Treadmill sessions</h2><div class="cardio-calendar-controls"><button type="button" data-cardio-calendar="previous" aria-label="Previous month">${icon("chevron-left", "‹")}</button><strong>${escapeHtml(formatCalendarDate(monthStart, { month: "long", year: "numeric" }))}</strong><button type="button" data-cardio-calendar="next" aria-label="Next month">${icon("chevron-right", "›")}</button><button type="button" data-cardio-calendar="today">Today</button></div></div>
    <div class="cardio-calendar" role="grid" aria-label="Treadmill sessions for ${escapeHtml(formatCalendarDate(monthStart, { month: "long", year: "numeric" }))}">${weekdays}${days}</div>
  </section>`;
}

function cardioZone2WeekSummary() {
  const today = dayKey();
  const start = addCalendarDays(today, -weekdayForKey(today));
  const end = addCalendarDays(start, 6);
  const seconds = (cardioData?.dailyZone2 || []).reduce((sum, day) => {
    return day.date >= start && day.date <= end ? sum + Math.max(0, Number(day.moderateSeconds) || 0) : sum;
  }, 0);
  return { start, end, seconds, minutes: Math.round(seconds / 60) };
}

function renderCardioZone2Goal() {
  const summary = cardioZone2WeekSummary();
  const goal = Number(cardioData?.zone2GoalMinutes) > 0 ? Number(cardioData.zone2GoalMinutes) : null;
  const percent = goal ? Math.min(100, summary.seconds / (goal * 60) * 100) : 0;
  const remaining = goal ? Math.max(0, Math.ceil(goal - summary.seconds / 60)) : null;
  const dateRange = `${formatCalendarDate(summary.start, { month: "short", day: "numeric" })}–${formatCalendarDate(summary.end, { month: "short", day: "numeric" })}`;
  return `<section class="cardio-panel cardio-zone2-goal-panel">
    <div class="cardio-zone2-goal-heading"><div><p class="eyebrow">ZONE 2</p><h2>Weekly cardio goal</h2></div><button class="secondary-button" type="button" data-cardio-zone2-goal>${goal ? "Edit goal" : "Add goal"}</button></div>
    ${goal ? `<div class="cardio-zone2-progress"><div><strong>${summary.minutes}<small> / ${goal} min</small></strong><span>${remaining ? `${remaining} min remaining` : "Goal reached"}</span></div><div class="cardio-zone2-progress-track" role="progressbar" aria-label="Weekly Zone 2 cardio goal" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(goal, summary.minutes)}"><i style="width:${percent}%"></i></div><small>${escapeHtml(dateRange)} · Moderate zone only</small></div>` : `<div class="cardio-zone2-empty"><strong>${summary.minutes} min this week</strong><p>Add a weekly target to track your Zone 2 progress.</p></div>`}
  </section>`;
}

function openCardioZone2GoalDialog() {
  $("#cardioZone2GoalMinutes").value = cardioData?.zone2GoalMinutes || 150;
  $("#cardioZone2GoalError").textContent = "";
  $("#cardioZone2GoalDialog").showModal();
  requestAnimationFrame(() => $("#cardioZone2GoalMinutes").focus());
}

function healthSyncStatusMarkup(connection, syncing, localError = "") {
  const active = syncing || connection.syncing;
  const waiting = !active && connection.busy;
  const error = localError || connection.lastError || "";
  const stateLabel = active ? "Syncing with Google Health…" : waiting ? "Another Google Health sync is in progress…" : error ? "Automatic sync needs attention" : "";
  const stateMarkup = stateLabel ? `<span class="health-sync-state ${active || waiting ? "is-syncing" : ""}">${active || waiting ? icon("refresh-cw", "↻") : icon("circle-alert", "!")}${escapeHtml(stateLabel)}</span>` : "";
  const lastSynced = connection.lastSyncAt ? `Last synced ${cardioDateTimeFormatter.format(new Date(connection.lastSyncAt))}` : "Not synced yet";
  return `<div class="cardio-sync-meta" role="status" aria-live="polite">${stateMarkup}<span>${escapeHtml(lastSynced)}</span>${error ? `<span class="cardio-sync-error">${escapeHtml(error)}</span>` : ""}</div>`;
}

async function saveCardioZone2Goal(event) {
  event.preventDefault();
  const minutes = Number($("#cardioZone2GoalMinutes").value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
    $("#cardioZone2GoalError").textContent = "Enter 1–10,080 whole minutes.";
    return;
  }
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    cardioData = await window.tempoServer.setCardioZone2Goal(minutes);
    $("#cardioZone2GoalDialog").close();
    renderCardio();
    renderWeeklyChart();
    if ($("#settingsView").classList.contains("active")) renderSettings();
    toast("Zone 2 goal saved.");
  } catch (error) {
    $("#cardioZone2GoalError").textContent = error.message || "Could not save the Zone 2 goal.";
  } finally {
    submit.disabled = false;
  }
}

function renderCardio() {
  const content = $("#cardioContent");
  if (cardioLoading && !cardioData) { content.innerHTML = `<div class="cardio-loading">Loading cardio data from D1…</div>`; return; }
  if (cardioError && !cardioData) { content.innerHTML = `<div class="cardio-error">${escapeHtml(cardioError)}</div>`; return; }
  if (!cardioData) return;
  const connection = cardioData.connection;
  if (!connection.configured) {
    content.innerHTML = `<div class="cardio-connect-card"><div><span>${icon("cloud-off", "!")}</span><h2>Google Health isn’t configured</h2><p>The Tempo deployment administrator needs to add the Google OAuth client ID, client secret, and token-encryption key as Cloudflare Worker secrets.</p></div></div>`;
    return;
  }
  if (!connection.connected) {
    content.innerHTML = `<div class="cardio-connect-card"><div><span>${icon("heart-pulse", "♥")}</span><h2>Connect Google Health</h2><button class="primary-button" type="button" data-cardio-connect>Connect</button></div></div>`;
    return;
  }
  const resting = cardioData.restingHeartRates || [], sessions = cardioData.sessions || [];
  const latest = resting.at(-1), recent = resting.slice(-30);
  const recentAverage = recent.length ? Math.round(recent.reduce((sum, point) => sum + point.beatsPerMinute, 0) / recent.length) : null;
  const change = recent.length > 1 ? recent.at(-1).beatsPerMinute - recent[0].beatsPerMinute : null;
  const latestSession = sessions[0];
  content.innerHTML = `
    ${healthSyncStatusMarkup(connection, cardioSyncing, cardioSyncError)}
    <div class="cardio-summary-grid">
      <div class="cardio-summary-card"><span>Latest resting HR</span><strong>${latest?.beatsPerMinute ?? "—"}</strong><small>${latest ? `bpm · ${escapeHtml(cardioDateFormatter.format(new Date(`${latest.date}T12:00:00Z`)))}` : "No synced data"}</small></div>
      <div class="cardio-summary-card"><span>30-day average</span><strong>${recentAverage ?? "—"}</strong><small>${recentAverage ? "beats per minute" : "No synced data"}</small></div>
      <div class="cardio-summary-card"><span>30-day change</span><strong>${change == null ? "—" : `${change > 0 ? "+" : ""}${change}`}</strong><small>${change == null ? "No comparison" : "beats per minute"}</small></div>
      <div class="cardio-summary-card"><span>Treadmill sessions</span><strong>${sessions.length}</strong><small>${latestSession ? `Latest ${escapeHtml(cardioDateFormatter.format(new Date(latestSession.startTime)))}` : "No synced sessions"}</small></div>
    </div>
    <div class="cardio-main-stack">
      <div class="cardio-goals-grid">
        ${renderCardioStepsGoal()}
        ${renderCardioZone2Goal()}
      </div>
      <section class="cardio-panel cardio-resting-panel"><div class="cardio-panel-heading"><h2>Resting heart rate</h2><select id="cardioRestingRange" aria-label="Resting heart rate range">${cardioRangeOptions(cardioRestingRange)}</select></div><div class="cardio-chart-wrap">${renderRestingHeartRateChart()}</div></section>
      <section class="cardio-panel cardio-steps-panel"><div class="cardio-panel-heading"><div><h2>Steps this week</h2><p>Hourly activity over the last seven days</p></div></div>${renderHourlyStepsHeatmap()}</section>
      ${renderCardioCalendar(sessions)}
    </div>`;
}

async function loadCardio(force = false) {
  if (cardioLoading) return cardioLoadPromise;
  if (cardioData && !force) { renderCardio(); renderWeeklyChart(); if ($("#settingsView").classList.contains("active")) renderSettings(); return cardioData; }
  cardioLoading = true; cardioError = ""; renderCardio(); if ($("#settingsView").classList.contains("active")) renderSettings();
  cardioLoadPromise = (async () => {
    try { cardioData = await window.tempoServer.getCardio(); }
    catch (error) { cardioError = error.message || "Tempo could not load cardio data from D1."; }
    finally { cardioLoading = false; cardioLoadPromise = null; renderCardio(); renderWeeklyChart(); if ($("#settingsView").classList.contains("active")) renderSettings(); }
    return cardioData;
  })();
  return cardioLoadPromise;
}

async function connectGoogleHealth() {
  const buttons = [$("[data-cardio-connect]")].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; });
  try { await window.tempoServer.connectGoogleHealth(); }
  catch (error) { buttons.forEach(button => { button.disabled = false; }); toast(error.message || "Could not start Google Health authorization."); }
}

async function syncCardio(force = false) {
  if (cardioSyncing) return;
  cardioSyncing = true; cardioSyncError = ""; renderCardio();
  try {
    cardioData = await window.tempoServer.syncCardio(force);
    return true;
  } catch (error) {
    if (error.code !== "sync_in_progress") cardioSyncError = error.message || "Google Health sync failed.";
    cardioData = await window.tempoServer.getCardio().catch(() => cardioData);
    return false;
  } finally { cardioSyncing = false; renderCardio(); renderWeeklyChart(); }
}

async function refreshCardioSteps() {
  if (await syncCardio(true)) toast("Steps refreshed.");
}

async function visitCardio() {
  await Promise.all([loadCardio(), loadSleep()]);
  renderCardio();
  if (activeView !== "cardioView") return;
  const sleepConnection = sleepData?.connection;
  if (sleepConnection?.configured && sleepConnection.connected && sleepConnection.sleepAuthorized && !sleepConnection.busy && !isRecentlySynced(sleepConnection.lastSyncAt)) await syncSleep();
  if (activeView !== "cardioView") return;
  const connection = cardioData?.connection;
  if (connection?.configured && connection.connected && !connection.busy && !isRecentlySynced(connection.lastSyncAt)) await syncCardio();
}

async function selectCardioSession(id, updateHistory = true) {
  selectedCardioSessionId = id; selectedCardioSession = null;
  showView("cardioSessionView", updateHistory);
  renderCardioSessionDetailPage();
  try { selectedCardioSession = await window.tempoServer.getCardioSession(id); }
  catch (error) {
    selectedCardioSessionId = null;
    toast(error.message || "Could not load that treadmill session.");
    showView("cardioView", false);
    history.replaceState(null, "", `${pathForView(privateBasePath, "cardioView")}${location.search}`);
    return;
  }
  renderCardioSessionDetailPage();
}

function deleteSelectedCardioSession() {
  if (!selectedCardioSessionId || !selectedCardioSession) return;
  const id = selectedCardioSessionId;
  openDeleteConfirmation(`Delete “${selectedCardioSession.displayName}”?`, "This removes the session and prevents Google Health sync from adding it again.", async () => {
    try {
      cardioData = await window.tempoServer.deleteCardioSession(id);
      selectedCardioSessionId = null; selectedCardioSession = null;
      renderCardio(); renderWeeklyChart();
      showView("cardioView");
      toast("Cardio session deleted.");
    } catch (error) { toast(error.message || "Could not delete that cardio session."); }
  });
}

const sleepStageLabels = { AWAKE: "Awake", RESTLESS: "Restless", REM: "REM", LIGHT: "Light", DEEP: "Deep", ASLEEP: "Asleep" };
const sleepStageOrder = ["AWAKE", "RESTLESS", "REM", "LIGHT", "DEEP", "ASLEEP"];
const sleepTimeFormatter = new Intl.DateTimeFormat(undefined, { timeZone: appTimezone, hour: "numeric", minute: "2-digit" });
const sleepClockPartsFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: appTimezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function sleepDayTotals(sessions) {
  const totals = new Map();
  sessions.filter(session => !session.nap).forEach(session => totals.set(session.date, (totals.get(session.date) || 0) + session.minutesAsleep));
  return totals;
}

function sleepClockMinutes(timestamp) {
  const parts = Object.fromEntries(sleepClockPartsFormatter.formatToParts(new Date(timestamp)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function normalizedSleepClockMinutes(minutes) {
  return minutes < 12 * 60 ? minutes + 24 * 60 : minutes;
}

function sleepGoalResult(date, sessions, goal = sleepData?.goal) {
  const nightSessions = sessions.filter(session => session.date === date && !session.nap);
  if (!goal || !nightSessions.length) return { recorded: false, minutes: 0, durationPercent: 0, durationMet: false, bedtimeMet: false, met: false };
  const minutes = nightSessions.reduce((sum, session) => sum + Math.max(0, Number(session.minutesAsleep) || 0), 0);
  const startMinutes = sleepClockMinutes(Math.min(...nightSessions.map(session => session.startTime)));
  const [goalHour, goalMinute] = goal.startTime.split(":").map(Number);
  const durationPercent = Math.min(100, minutes / goal.minutes * 100);
  const durationMet = minutes >= goal.minutes;
  const bedtimeMet = normalizedSleepClockMinutes(startMinutes) <= normalizedSleepClockMinutes(goalHour * 60 + goalMinute);
  return { recorded: true, minutes, durationPercent, durationMet, bedtimeMet, met: durationMet && bedtimeMet };
}

function formatSleepGoalTime(value) {
  const [hour, minute] = String(value).split(":").map(Number);
  const date = new Date(Date.UTC(2020, 0, 1, hour, minute));
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(date);
}

function renderSleepGoal(sessions) {
  const goal = sleepData?.goal;
  const today = dayKey();
  const sunday = addCalendarDays(today, -weekdayForKey(today));
  const days = Array.from({ length: 7 }, (_, index) => addCalendarDays(sunday, index)).filter(date => date <= today);
  const results = days.map(date => sleepGoalResult(date, sessions, goal)).filter(result => result.recorded);
  const met = results.filter(result => result.met).length;
  const hours = goal ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(goal.minutes / 60) : "";
  return `<section class="cardio-panel sleep-goal-panel"><div class="sleep-goal-heading"><div><h2>Sleep goal</h2></div><button class="secondary-button" type="button" data-sleep-goal>${goal ? "Edit goal" : "Add goal"}</button></div>${goal ? `<div class="sleep-goal-stats"><div><span>Duration</span><strong>${hours} hours</strong></div><div><span>Asleep by</span><strong>${escapeHtml(formatSleepGoalTime(goal.startTime))}</strong></div><div><span>This week</span><strong>${met} / ${results.length || 0} nights</strong></div></div>` : `<div class="sleep-goal-empty"><strong>No sleep goal set</strong><p>Add your target duration and sleep start time.</p></div>`}</section>`;
}

function formatSleepDuration(minutes) {
  const totalMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function openSleepGoalDialog() {
  $("#sleepGoalHours").value = sleepData?.goal ? sleepData.goal.minutes / 60 : 8;
  $("#sleepGoalStartTime").value = sleepData?.goal?.startTime || "22:30";
  $("#sleepGoalError").textContent = "";
  $("#sleepGoalDialog").showModal();
  requestAnimationFrame(() => $("#sleepGoalHours").focus());
}

async function saveSleepGoal(event) {
  event.preventDefault();
  const hours = Number($("#sleepGoalHours").value);
  const minutes = Math.round(hours * 60);
  const startTime = $("#sleepGoalStartTime").value;
  if (!Number.isFinite(hours) || minutes < 1 || minutes > 1440 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    $("#sleepGoalError").textContent = "Enter a duration up to 24 hours and a valid sleep start time.";
    return;
  }
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    sleepData = await window.tempoServer.setSleepGoal(minutes, startTime);
    $("#sleepGoalDialog").close();
    renderSleep();
    renderWeeklyChart();
    if ($("#settingsView").classList.contains("active")) renderSettings();
    toast("Sleep goal saved.");
  } catch (error) {
    $("#sleepGoalError").textContent = error.message || "Could not save the sleep goal.";
  } finally {
    submit.disabled = false;
  }
}

function averageSleepForRange(totals, startDate, days) {
  const values = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addCalendarDays(startDate, offset);
    if (totals.has(date)) values.push(totals.get(date));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length / 60 : null;
}

const sleepClockFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: appTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function sleepClockHourStart(date, hour) {
  const [year, month, day] = date.split("-").map(Number);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour);
  let timestamp = desiredAsUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(sleepClockFormatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
    const representedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour));
    timestamp += desiredAsUtc - representedAsUtc;
  }
  return timestamp;
}

function sleepTimelineBoundary(date, offsetHours) {
  const dayOffset = Math.floor(offsetHours / 24);
  const hour = ((offsetHours % 24) + 24) % 24;
  return sleepClockHourStart(addCalendarDays(date, dayOffset), hour);
}

function sleepTimelineLabel(offsetHour) {
  const hour = ((offsetHour % 24) + 24) % 24;
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

function sleepWeekTimelineStartHour(sessions) {
  const offsets = sessions.filter(session => !session.nap).flatMap(session => {
    const midnight = sleepClockHourStart(session.date, 0);
    return [(Number(session.startTime) - midnight) / 3600000, (Number(session.endTime) - midnight) / 3600000];
  }).filter(Number.isFinite);
  if (!offsets.length) return -2;
  const firstHour = Math.floor(Math.min(...offsets));
  const lastHour = Math.ceil(Math.max(...offsets));
  const occupiedHours = lastHour - firstHour;
  if (occupiedHours <= 12) return firstHour - Math.floor((12 - occupiedHours) / 2);
  return Math.floor((firstHour + lastHour) / 2 - 6);
}

function renderSleepHeatmap(sessions) {
  const today = dayKey(), firstDay = addCalendarDays(today, -6);
  const weekDates = Array.from({ length: 7 }, (_, offset) => addCalendarDays(firstDay, offset));
  const weekSessions = sessions.filter(session => weekDates.includes(session.date) && !session.nap);
  const timelineStartHour = sleepWeekTimelineStartHour(weekSessions);
  const timelineLabels = Array.from({ length: 7 }, (_, index) => `<span style="--axis-left:${index / 6 * 100}%">${sleepTimelineLabel(timelineStartHour + index * 2)}</span>`).join("");
  const rows = Array.from({ length: 7 }, (_, offset) => {
    const date = addCalendarDays(firstDay, offset);
    const daySessions = sessions.filter(session => session.date === date && !session.nap);
    const sleepStart = daySessions.length ? Math.min(...daySessions.map(session => session.startTime)) : null;
    const sleepEnd = daySessions.length ? Math.max(...daySessions.map(session => session.endTime)) : null;
    const minutesAsleep = daySessions.reduce((sum, session) => sum + Math.max(0, Number(session.minutesAsleep) || 0), 0);
    const duration = formatSleepDuration(minutesAsleep);
    const sleepWindow = sleepStart == null || sleepEnd == null ? "—" : `${sleepTimeFormatter.format(new Date(sleepStart))}–${sleepTimeFormatter.format(new Date(sleepEnd))}`;
    const timelineStart = sleepTimelineBoundary(date, timelineStartHour);
    const timelineEnd = sleepTimelineBoundary(date, timelineStartHour + 12);
    const timelineDuration = timelineEnd - timelineStart;
    const segments = daySessions.flatMap(session => session.stages || []).map(stage => {
      const start = Math.max(timelineStart, Number(stage.startTime));
      const end = Math.min(timelineEnd, Number(stage.endTime));
      if (!sleepStageLabels[stage.type] || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "";
      const left = (start - timelineStart) / timelineDuration * 100;
      const width = (end - start) / timelineDuration * 100;
      const minutes = Math.max(1, Math.round((end - start) / 60000));
      const label = `${sleepStageLabels[stage.type]}, ${sleepTimeFormatter.format(new Date(start))}–${sleepTimeFormatter.format(new Date(end))}, ${minutes} min`;
      return `<i class="sleep-stage-segment stage-${stage.type.toLowerCase()}" style="--stage-left:${left}%;--stage-width:${width}%" title="${escapeHtml(label)}"><span class="sr-only">${escapeHtml(label)}</span></i>`;
    }).join("");
    const dayLabel = formatCalendarDate(date, { weekday: "long", month: "short", day: "numeric" });
    return `<div class="sleep-timeline-row"><strong>${escapeHtml(formatCalendarDate(date, { weekday: "short" }))}<small>${escapeHtml(formatCalendarDate(date, { month: "numeric", day: "numeric" }))}</small><small class="sleep-row-window">${escapeHtml(sleepWindow)}</small></strong><div class="sleep-stage-track" role="img" aria-label="${escapeHtml(`${dayLabel}: ${sleepWindow === "—" ? "No sleep stages" : `sleep from ${sleepWindow}, ${duration} total`}`)}">${segments}</div><span class="sleep-row-total">${duration}</span></div>`;
  }).join("");
  const legend = sleepStageOrder.map(stage => `<span><i class="sleep-stage-swatch stage-${stage.toLowerCase()}"></i>${sleepStageLabels[stage]}</span>`).join("");
  return `<section class="cardio-panel sleep-heatmap-panel"><div class="cardio-panel-heading"><div><h2>Sleep stages this week</h2></div></div><div class="sleep-heatmap-scroll"><div class="sleep-timeline-axis">${timelineLabels}</div>${rows}</div><div class="sleep-stage-legend">${legend}</div></section>`;
}

function renderSleep() {
  const content = $("#sleepContent");
  if (sleepLoading && !sleepData) { content.innerHTML = `<div class="cardio-loading">Loading sleep data from D1…</div>`; return; }
  if (sleepError && !sleepData) { content.innerHTML = `<div class="cardio-error">${escapeHtml(sleepError)}</div>`; return; }
  if (!sleepData) return;
  const connection = sleepData.connection;
  if (!connection.configured) { content.innerHTML = `<div class="cardio-connect-card"><div><span>${icon("cloud-off", "!")}</span><h2>Google Health isn’t configured</h2><p>The Tempo deployment administrator needs to configure the Google OAuth credentials and token-encryption key.</p></div></div>`; return; }
  if (!connection.connected || !connection.sleepAuthorized) {
    const reconnect = connection.connected;
    content.innerHTML = `<div class="cardio-connect-card"><div><span>${icon("moon", "☾")}</span><h2>${reconnect ? "Grant sleep access" : "Connect Google Health"}</h2>${reconnect ? `<p>Your existing connection predates sleep access. Reconnect once to add the read-only sleep permission.</p>` : ""}<button class="primary-button" type="button" data-sleep-connect>Connect</button></div></div>`;
    return;
  }
  const sessions = sleepData.sessions || [], totals = sleepDayTotals(sessions), today = dayKey();
  const currentAverage = averageSleepForRange(totals, addCalendarDays(today, -29), 30);
  const previousAverage = averageSleepForRange(totals, addCalendarDays(today, -59), 30);
  const change = currentAverage == null || previousAverage == null ? null : currentAverage - previousAverage;
  const latest = [...sessions].filter(session => !session.nap).at(-1);
  const formatHours = value => value == null ? "—" : value.toFixed(1);
  content.innerHTML = `${healthSyncStatusMarkup(connection, sleepSyncing, sleepSyncError)}
    <div class="sleep-summary-grid">
      <div class="cardio-summary-card sleep-primary-stat"><span>30-day average</span><strong>${formatHours(currentAverage)}<small>hours</small></strong><p>${totals.size ? `Across ${[...totals].filter(([date]) => date >= addCalendarDays(today, -29) && date <= today).length} recorded nights` : "No synced sleep yet"}</p></div>
      <div class="cardio-summary-card"><span>Month-over-month</span><strong class="${change == null ? "" : change >= 0 ? "is-positive" : "is-negative"}">${change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)} h`}</strong><small>${change == null ? "Needs both 30-day periods" : "vs previous 30-day average"}</small></div>
      <div class="cardio-summary-card"><span>Latest night</span><strong>${latest ? formatHours(latest.minutesAsleep / 60) : "—"}<small>${latest ? "hours" : ""}</small></strong><small>${latest ? escapeHtml(cardioDateFormatter.format(new Date(`${latest.date}T12:00:00Z`))) : "No synced sleep"}</small></div>
    </div>${renderSleepGoal(sessions)}${renderSleepHeatmap(sessions)}`;
}

async function loadSleep(force = false) {
  if (sleepLoading) return sleepLoadPromise;
  if (sleepData && !force) { renderSleep(); renderWeeklyChart(); if ($("#settingsView").classList.contains("active")) renderSettings(); return sleepData; }
  sleepLoading = true; sleepError = ""; renderSleep(); if ($("#settingsView").classList.contains("active")) renderSettings();
  sleepLoadPromise = (async () => {
    try { sleepData = await window.tempoServer.getSleep(); }
    catch (error) { sleepError = error.message || "Tempo could not load sleep data from D1."; }
    finally { sleepLoading = false; sleepLoadPromise = null; renderSleep(); renderWeeklyChart(); if ($("#cardioView").classList.contains("active")) renderCardio(); if ($("#settingsView").classList.contains("active")) renderSettings(); }
    return sleepData;
  })();
  return sleepLoadPromise;
}

async function connectSleep() {
  const buttons = [$("[data-sleep-connect]")].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; });
  try { await window.tempoServer.connectGoogleHealth("sleep"); }
  catch (error) { buttons.forEach(button => { button.disabled = false; }); toast(error.message || "Could not start Google Health authorization."); }
}

async function syncSleep() {
  if (sleepSyncing) return;
  sleepSyncing = true; sleepSyncError = ""; renderSleep();
  try { sleepData = await window.tempoServer.syncSleep(); }
  catch (error) { if (error.code !== "sync_in_progress") sleepSyncError = error.message || "Google Health sleep sync failed."; sleepData = await window.tempoServer.getSleep().catch(() => sleepData); }
  finally { sleepSyncing = false; renderSleep(); renderWeeklyChart(); }
}

async function visitSleep() {
  await loadSleep();
  if (activeView !== "sleepView") return;
  const connection = sleepData?.connection;
  if (connection?.configured && connection.connected && connection.sleepAuthorized && !connection.busy && !isRecentlySynced(connection.lastSyncAt)) await syncSleep();
}

function financeMoney(value, currency = financeData?.currency || "CAD") {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const fallbackCurrency = financeData?.currency || "CAD";
  const normalizedCurrency = typeof currency === "string" && /^[A-Z]{3}$/.test(currency.toUpperCase()) ? currency.toUpperCase() : fallbackCurrency;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: normalizedCurrency, maximumFractionDigits: normalizedCurrency === "JPY" ? 0 : 2 }).format(Number(value));
  } catch (_) {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: fallbackCurrency, maximumFractionDigits: fallbackCurrency === "JPY" ? 0 : 2 }).format(Number(value));
  }
}

function financeQuantity(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(Number(value));
}

function financeHoldingChangeMarkup(holding) {
  const change = Number(holding.valueChange), percent = Number(holding.percentChange);
  if (holding.valueChange == null || holding.percentChange == null || !Number.isFinite(change) || !Number.isFinite(percent)) return `<strong>—</strong><small>No historical value</small>`;
  const className = change > 0 ? "is-positive" : change < 0 ? "is-negative" : "";
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  const percentSign = percent > 0 ? "+" : percent < 0 ? "−" : "";
  return `<strong class="${className}">${sign}${financeMoney(Math.abs(change))}</strong><small class="${className}">${percentSign}${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(percent))}%</small>`;
}

function financeChangeCard(label, comparison, position) {
  const change = comparison?.change;
  const className = change == null ? "" : change > 0 ? "is-positive" : change < 0 ? "is-negative" : "";
  const fallback = comparison?.fallbackLabels || [];
  const detail = comparison?.value == null ? "Waiting for price history" : `From ${financeMoney(comparison.value)}${fallback.length ? ` · Current values used for ${fallback.map(escapeHtml).join(", ")}` : ""}`;
  return `<div class="cardio-summary-card" role="group" aria-label="${position} of 4, ${escapeHtml(label)}"><span>${escapeHtml(label)}</span><strong class="${className}">${change == null ? "—" : `${change > 0 ? "+" : ""}${financeMoney(change)}`}</strong><small>${detail}</small></div>`;
}

function financePercent(value, digits = 1) {
  return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value) || 0)}%`;
}

function financeAllocationGroups(holdings) {
  const categories = financeData?.allocation?.categories || [];
  const byDescendingMarketValue = (left, right) => {
    const leftValue = left.marketValue == null || !Number.isFinite(Number(left.marketValue)) ? null : Number(left.marketValue);
    const rightValue = right.marketValue == null || !Number.isFinite(Number(right.marketValue)) ? null : Number(right.marketValue);
    if (leftValue == null) return rightValue == null ? 0 : 1;
    if (rightValue == null) return -1;
    return rightValue - leftValue;
  };
  const groups = categories.map(category => ({ ...category, holdings: holdings.filter(holding => holding.allocationCategoryId === category.id).sort(byDescendingMarketValue), unassigned: false }));
  const unassignedHoldings = holdings.filter(holding => holding.allocationCategoryId == null).sort(byDescendingMarketValue);
  if (unassignedHoldings.length) groups.push({ id: null, name: "Unassigned", color: null, targetPercentage: null, currentPercentage: financeData?.allocation?.unassignedPercentage || 0, driftPercentage: financeData?.allocation?.unassignedPercentage || 0, holdings: unassignedHoldings, unassigned: true });
  return groups.filter(group => group.holdings.length).map(group => {
    const marketValues = group.holdings.map(holding => holding.marketValue);
    const previousValues = group.holdings.map(holding => holding.previousMarketValue);
    const marketValue = marketValues.every(value => value != null) ? marketValues.reduce((sum, value) => sum + Number(value), 0) : null;
    const previousMarketValue = previousValues.every(value => value != null) ? previousValues.reduce((sum, value) => sum + Number(value), 0) : null;
    const valueChange = marketValue == null || previousMarketValue == null ? null : marketValue - previousMarketValue;
    const percentChange = valueChange == null || !previousMarketValue ? null : valueChange / previousMarketValue * 100;
    return { ...group, marketValue, previousMarketValue, valueChange, percentChange };
  });
}

function renderFinanceAllocationGroupRow(group) {
  return `<tr class="finance-allocation-group-row"><th><span class="finance-group-name ${group.unassigned ? "is-unassigned" : ""}" style="${group.color ? `--allocation-color:${group.color}` : ""}"><i></i>${escapeHtml(group.name)}</span></th><td colspan="2"></td><td><strong>${financeMoney(group.marketValue)}</strong><small>${financePercent(group.currentPercentage)} of portfolio</small></td><td class="finance-holding-change">${financeHoldingChangeMarkup(group)}</td><td></td></tr>`;
}

function renderFinanceAllocationGroupCards(group) {
  return `<section class="finance-holding-card-group"><header><div><span class="finance-group-name ${group.unassigned ? "is-unassigned" : ""}" style="${group.color ? `--allocation-color:${group.color}` : ""}"><i></i>${escapeHtml(group.name)}</span></div><div class="finance-group-card-metrics"><span><small>Market value</small><strong>${financeMoney(group.marketValue)}</strong></span><span class="finance-holding-change"><small>Change</small>${financeHoldingChangeMarkup(group)}</span></div></header>${group.holdings.map(renderFinanceHoldingCard).join("")}</section>`;
}

function allocationSegments(categories, valueKey, includeUnassigned = false) {
  const segments = categories.map(category => `<i style="--allocation-color:${category.color};--allocation-width:${Math.max(0, Math.min(100, Number(category[valueKey]) || 0))}%" title="${escapeHtml(category.name)}: ${financePercent(category[valueKey])}"></i>`);
  if (includeUnassigned && financeData.allocation.unassignedPercentage > 0) segments.push(`<i class="is-unassigned" style="--allocation-width:${Math.min(100, financeData.allocation.unassignedPercentage)}%" title="Unassigned: ${financePercent(financeData.allocation.unassignedPercentage)}"></i>`);
  return segments.join("");
}

function renderAllocationDrift() {
  const allocation = financeData?.allocation;
  const categories = allocation?.categories || [];
  if (!categories.length) return `<section class="cardio-panel allocation-drift-panel"><div class="cardio-panel-heading"><div><h2>Asset allocation</h2></div><button class="secondary-button" type="button" data-finance-allocation-library>Set up categories</button></div><div class="finance-empty allocation-empty"><span>${icon("chart-pie", "◔")}</span><h3>No allocation targets yet</h3><p>Create categories, set their target percentages, then assign each holding.</p></div></section>`;
  return `<section class="cardio-panel allocation-drift-panel"><div class="cardio-panel-heading"><div><h2>Allocation drift</h2><p>Current market value compared with your target mix.</p></div></div>
    <div class="allocation-comparison"><div><span>Current</span><div class="allocation-segmented-bar">${allocationSegments(categories, "currentPercentage", true)}</div></div><div><span>Target</span><div class="allocation-segmented-bar">${allocationSegments(categories, "targetPercentage")}</div></div></div>
    <div class="allocation-drift-list">${categories.map(category => { const drift = category.driftPercentage; const driftClass = Math.abs(drift) < .05 ? "is-even" : drift > 0 ? "is-over" : "is-under"; return `<div class="allocation-drift-row"><i style="--allocation-color:${category.color}"></i><strong>${escapeHtml(category.name)}</strong><span>${financeMoney(category.currentValue)}</span><span>${financePercent(category.currentPercentage)} current</span><span>${financePercent(category.targetPercentage)} target</span><b class="${driftClass}">${drift > .05 ? "+" : ""}${financePercent(drift)}</b></div>`; }).join("")}${allocation.unassignedPercentage > .05 ? `<div class="allocation-drift-row is-unassigned"><i></i><strong>Unassigned</strong><span>${financeMoney(allocation.unassignedValue)}</span><span>${financePercent(allocation.unassignedPercentage)} current</span><span>No target</span><b class="is-over">+${financePercent(allocation.unassignedPercentage)}</b></div>` : ""}</div></section>`;
}

function renderFinanceHolding(holding) {
  const defaultCashLabel = `${holding.currency} cash`;
  const label = holding.type === "CASH" ? holding.name || defaultCashLabel : holding.symbol;
  const detail = holding.type === "CASH" ? (holding.name && holding.name !== defaultCashLabel ? defaultCashLabel : "Cash balance") : (holding.name && holding.name !== holding.symbol ? holding.name : `${holding.currency || "—"} security`);
  return `<tr data-finance-holding-id="${holding.id}">
    <th><strong>${escapeHtml(label || "Holding")}</strong><small>${escapeHtml(detail || "")}</small></th>
    <td>${holding.type === "CASH" ? financeMoney(1, holding.currency) : holding.nativePrice == null ? "—" : financeMoney(holding.nativePrice, holding.currency)}</td>
    <td>${escapeHtml(financeQuantity(holding.quantity))}</td>
    <td><strong>${financeMoney(holding.marketValue)}</strong>${holding.currency && holding.currency !== financeData.currency ? `<small>${financeMoney(holding.type === "CASH" ? holding.quantity : holding.quantity * (holding.nativePrice || 0), holding.currency)}</small>` : ""}</td>
    <td class="finance-holding-change">${financeHoldingChangeMarkup(holding)}</td>
    <td><div class="finance-row-actions"><button type="button" data-finance-action="edit" aria-label="Edit ${escapeHtml(label || "holding")}">${icon("pencil", "Edit")}</button><button type="button" data-finance-action="delete" aria-label="Delete ${escapeHtml(label || "holding")}">${icon("trash-2", "×")}</button></div></td>
  </tr>`;
}

function renderFinanceHoldingCard(holding) {
  const defaultCashLabel = `${holding.currency} cash`;
  const label = holding.type === "CASH" ? holding.name || defaultCashLabel : holding.symbol;
  const detail = holding.type === "CASH" ? (holding.name && holding.name !== defaultCashLabel ? defaultCashLabel : "Cash balance") : (holding.name && holding.name !== holding.symbol ? holding.name : `${holding.currency || "—"} security`);
  const price = holding.type === "CASH" ? financeMoney(1, holding.currency) : holding.nativePrice == null ? "—" : financeMoney(holding.nativePrice, holding.currency);
  const nativeValue = holding.currency && holding.currency !== financeData.currency ? financeMoney(holding.type === "CASH" ? holding.quantity : holding.quantity * (holding.nativePrice || 0), holding.currency) : "";
  return `<article class="finance-holding-card" data-finance-holding-id="${holding.id}">
    <header><div><strong>${escapeHtml(label || "Holding")}</strong><small>${escapeHtml(detail || "")}</small></div><div class="finance-row-actions"><button type="button" data-finance-action="edit" aria-label="Edit ${escapeHtml(label || "holding")}">${icon("pencil", "Edit")}</button><button type="button" data-finance-action="delete" aria-label="Delete ${escapeHtml(label || "holding")}">${icon("trash-2", "×")}</button></div></header>
    <div class="finance-holding-card-metrics"><div><span>Price</span><strong>${price}</strong></div><div><span>Quantity</span><strong>${escapeHtml(financeQuantity(holding.quantity))}</strong></div><div><span>Market value</span><strong>${financeMoney(holding.marketValue)}</strong>${nativeValue ? `<small>${nativeValue}</small>` : ""}</div><div class="finance-holding-change"><span>Change</span>${financeHoldingChangeMarkup(holding)}</div></div>
  </article>`;
}

function renderFinances() {
  const content = $("#financesContent");
  if (financeLoading && !financeData) { content.innerHTML = `<div class="cardio-loading">Loading finances</div>`; return; }
  if (financeError && !financeData) { content.innerHTML = `<div class="cardio-error">${escapeHtml(financeError)}</div>`; return; }
  if (!financeData) return;
  const holdings = financeData.holdings || [];
  const allocationGroups = financeAllocationGroups(holdings);
  const syncMeta = financeData.lastRefreshedAt ? `Prices refreshed ${escapeHtml(cardioDateTimeFormatter.format(new Date(financeData.lastRefreshedAt)))}` : "Prices have not been refreshed yet";
  content.innerHTML = `<div class="finance-sync-meta" role="status" aria-live="polite">${financeRefreshing ? `<span class="health-sync-state is-syncing">${icon("refresh-cw", "↻")}Refreshing market prices…</span>` : ""}<span>${syncMeta}</span>${financeError ? `<span class="finance-sync-error">${escapeHtml(financeError)}</span>` : ""}</div>
    <div class="finance-summary-grid" role="region" aria-roledescription="carousel" aria-label="Portfolio summary. Swipe or use the left and right arrow keys to view all four cards." tabindex="0"><div class="cardio-summary-card finance-total-card" role="group" aria-label="1 of 4, total portfolio value"><span>Total portfolio value</span><strong>${financeMoney(financeData.totalValue)}</strong></div>${financeChangeCard("Since yesterday", financeData.changes?.yesterday, 2)}${financeChangeCard("Since last week", financeData.changes?.week, 3)}${financeChangeCard("Since last month", financeData.changes?.month, 4)}</div>
    ${renderAllocationDrift()}
    <div class="finance-layout">
      <section class="cardio-panel finance-holdings-panel"><div class="cardio-panel-heading"><div><h2>Holdings</h2></div><button class="secondary-button" type="button" data-finance-add>${icon("plus", "+")}Add holding</button></div>${holdings.length ? `<div class="finance-table-wrap"><table class="finance-table"><thead><tr><th>Asset</th><th>Price</th><th>Quantity</th><th>Market value</th><th>Change</th><th></th></tr></thead><tbody>${allocationGroups.map(group => `${renderFinanceAllocationGroupRow(group)}${group.holdings.map(renderFinanceHolding).join("")}`).join("")}</tbody></table></div><div class="finance-holding-cards">${allocationGroups.map(renderFinanceAllocationGroupCards).join("")}</div>` : `<div class="finance-empty"><span>${icon("wallet-cards", "$")}</span><h3>No holdings yet</h3><p>Add a stock ticker or cash balance to start your portfolio.</p></div>`}</section>
    </div>`;
}

function renderFinanceSettings() {
  const select = $("#settingsFinanceCurrency"), status = $("#settingsFinanceCurrencyStatus");
  if (!select || !status) return;
  select.disabled = financeLoading || !financeData;
  if (financeData) select.value = financeData.currency;
  status.textContent = financeData ? `Portfolio totals are displayed in ${financeData.currency}. Exchange rates refresh automatically when you visit Finances.` : "Loading portfolio currency…";
}

async function loadFinances(force = false) {
  if (financeLoading) return financeLoadPromise;
  if (financeData && !force) { renderFinances(); renderFinanceSettings(); renderAllocationLibrary(); return financeData; }
  financeLoading = true; financeError = ""; renderFinances(); renderFinanceSettings();
  financeLoadPromise = (async () => {
    try { financeData = await window.tempoServer.getFinances(); }
    catch (error) { financeError = error.message || "Tempo could not load portfolio data from D1."; }
    finally { financeLoading = false; financeLoadPromise = null; renderFinances(); renderFinanceSettings(); renderAllocationLibrary(); }
    return financeData;
  })();
  return financeLoadPromise;
}

async function refreshFinancePrices(force = false) {
  if (financeRefreshing) {
    await financeRefreshPromise;
    if (!force) return financeData;
  }
  financeRefreshing = true; financeError = ""; renderFinances();
  financeRefreshPromise = (async () => {
    try { financeData = await window.tempoServer.refreshFinances(force); }
    catch (error) { financeError = error.message || "Yahoo Finance refresh failed."; }
    finally { financeRefreshing = false; financeRefreshPromise = null; renderFinances(); renderFinanceSettings(); }
    return financeData;
  })();
  return financeRefreshPromise;
}

async function visitFinances() {
  await loadFinances();
  if (activeView === "financesView" && !isRecentlySynced(financeData?.lastRefreshedAt)) await refreshFinancePrices();
}

function renderFinanceCategoryOptions(select, selectedId = null) {
  const categories = financeData?.allocation?.categories || [];
  select.innerHTML = `<option value="">Unassigned</option>${categories.map(category => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("")}`;
  select.value = selectedId == null ? "" : String(selectedId);
}

function renderAllocationLibrary() {
  const grid = $("#allocationLibraryGrid");
  if (!grid) return;
  if (financeLoading && !financeData) { grid.innerHTML = `<div class="cardio-loading">Loading allocation categories</div>`; return; }
  const categories = financeData?.allocation?.categories || [];
  const targetTotal = financeData?.allocation?.targetTotal || 0;
  $("#allocationTargetSummary").innerHTML = `<div><span>Target plan</span><strong>${financePercent(targetTotal)}</strong></div><p class="${Math.abs(targetTotal - 100) < .05 ? "is-complete" : ""}">${Math.abs(targetTotal - 100) < .05 ? "Your targets add up to 100%." : `${financePercent(Math.abs(100 - targetTotal))} ${targetTotal < 100 ? "remains to allocate" : "over-allocated"}. Adjust targets until the plan totals 100%.`}</p>`;
  grid.innerHTML = categories.length ? categories.map(category => `<article class="food-card allocation-category-card" data-allocation-category-id="${category.id}" style="--allocation-color:${category.color}" draggable="false"><div class="food-card-top"><div><span><i></i>Allocation category</span><h2>${escapeHtml(category.name)}</h2></div><div class="allocation-card-tools"><span class="drag-handle" data-allocation-drag-handle role="button" tabindex="0" aria-label="Reorder ${escapeHtml(category.name)}" title="Drag to reorder">${icon("grip-vertical", "⋮")}</span><button class="menu-button" type="button" data-allocation-action="menu" aria-label="Options for ${escapeHtml(category.name)}">${icon("ellipsis", "…")}</button></div></div><div class="menu food-menu"><button type="button" data-allocation-action="edit">Edit category</button><button class="danger" type="button" data-allocation-action="delete">Delete category</button></div><div class="allocation-card-target"><strong>${financePercent(category.targetPercentage)}</strong><span>target</span></div><div class="allocation-card-current"><span>Current allocation</span><strong>${financePercent(category.currentPercentage)}</strong><small>${financeMoney(category.currentValue)}</small></div></article>`).join("") : `<div class="empty-nutrition-state"><span>${icon("chart-pie", "◔")}</span><h2>Build your allocation plan</h2><p>Create categories for the asset groups you want to target.</p><button class="primary-button" type="button" data-new-allocation-category>New category</button></div>`;
}

async function saveAllocationCategoryOrder(ids, focusId = null) {
  try {
    financeData = await window.tempoServer.reorderAllocationCategories(ids);
    renderAllocationLibrary(); renderFinances();
    if (focusId != null) requestAnimationFrame(() => $(`[data-allocation-category-id="${focusId}"] [data-allocation-drag-handle]`)?.focus());
  } catch (error) {
    financeData = await window.tempoServer.getFinances().catch(() => financeData);
    renderAllocationLibrary(); renderFinances();
    toast(error.message || "Could not reorder allocation categories.");
  }
}

function renderAllocationColorOptions(selectedColor) {
  const palette = financeData?.allocationColors || ["#ec5f3e", "#f0ad43", "#d9c84d", "#73a66f", "#3d8f7c", "#4c91a8", "#6179ad", "#8270a8", "#ad668d", "#9a7460"];
  $("#allocationColorOptions").innerHTML = palette.map((color, index) => `<label><input type="radio" name="allocationColor" value="${color}" ${color === selectedColor || (!selectedColor && index === 0) ? "checked" : ""}/><span style="--swatch:${color}" aria-label="Color ${index + 1}"></span></label>`).join("");
}

function openAllocationCategoryDialog(category = null) {
  $("#allocationCategoryForm").reset();
  $("#allocationCategoryId").value = category?.id || "";
  $("#allocationCategoryDialogHeading").textContent = category ? "Edit allocation category" : "New allocation category";
  $("#allocationCategoryName").value = category?.name || "";
  $("#allocationCategoryTarget").value = category?.targetPercentage ?? "";
  $("#allocationCategoryError").textContent = "";
  renderAllocationColorOptions(category?.color);
  $("#allocationCategoryDialog").showModal();
  $("#allocationCategoryName").focus();
}

async function saveAllocationCategory(event) {
  event.preventDefault();
  const id = $("#allocationCategoryId").value;
  const body = { name: $("#allocationCategoryName").value, targetPercentage: Number($("#allocationCategoryTarget").value), color: $('input[name="allocationColor"]:checked')?.value };
  const errorElement = $("#allocationCategoryError");
  const submit = $('button[type="submit"]', event.currentTarget);
  errorElement.textContent = ""; submit.disabled = true;
  try {
    financeData = id ? await window.tempoServer.updateAllocationCategory(id, body) : await window.tempoServer.addAllocationCategory(body);
    $("#allocationCategoryDialog").close(); renderAllocationLibrary(); renderFinances();
    toast(id ? "Allocation category updated." : "Allocation category added.");
  } catch (error) { errorElement.textContent = error.message || "Could not save that allocation category."; }
  finally { submit.disabled = false; }
}

function deleteAllocationCategory(category) {
  openDeleteConfirmation(`Delete ${category.name}?`, "Holdings in this category will become unassigned.", async () => {
    try { financeData = await window.tempoServer.deleteAllocationCategory(category.id); renderAllocationLibrary(); renderFinances(); toast("Allocation category deleted."); }
    catch (error) { toast(error.message || "Could not delete that allocation category."); }
  });
}

async function addFinanceHolding(event) {
  event.preventDefault();
  const type = $("#financeHoldingType").value, quantity = Number($("#financeQuantity").value);
  const body = { type, quantity, allocationCategoryId: $("#financeAllocationCategory").value || null, ...(type === "STOCK" ? { symbol: $("#financeTicker").value } : { currency: $("#financeCashCurrency").value, name: $("#financeCashName").value }) };
  const errorElement = $("#financeHoldingError"); errorElement.textContent = "";
  try {
    financeData = await window.tempoServer.addFinanceHolding(body);
    $("#financeHoldingDialog").close(); renderFinances();
    await refreshFinancePrices(true);
    toast(`${type === "STOCK" ? "Stock" : "Cash"} added.`);
  }
  catch (error) { errorElement.textContent = error.message || "Could not add that holding."; }
}

function openFinanceHoldingDialog() {
  $("#financeHoldingForm").reset();
  $("#financeHoldingType").value = "STOCK";
  $("#financeCashCurrency").value = financeData?.currency || "CAD";
  $("#financeHoldingError").textContent = "";
  renderFinanceCategoryOptions($("#financeAllocationCategory"));
  updateFinanceHoldingFields();
  $("#financeHoldingDialog").showModal();
  $("#financeTicker").focus();
}

function updateFinanceHoldingFields() {
  const cash = $("#financeHoldingType")?.value === "CASH";
  if ($("#financeTickerField")) $("#financeTickerField").hidden = cash;
  if ($("#financeCashCurrencyField")) $("#financeCashCurrencyField").hidden = !cash;
  if ($("#financeCashNameField")) $("#financeCashNameField").hidden = !cash;
}

function updateFinanceEditHoldingFields() {
  const cash = $("#financeEditHoldingType").value === "CASH";
  $("#financeEditTickerField").hidden = cash;
  $("#financeEditCashCurrencyField").hidden = !cash;
  $("#financeEditCashNameField").hidden = !cash;
}

function openFinanceEditHoldingDialog(row) {
  const holding = financeData?.holdings?.find(item => String(item.id) === row.dataset.financeHoldingId);
  if (!holding) return;
  $("#financeEditHoldingId").value = holding.id;
  $("#financeEditHoldingType").value = holding.type;
  $("#financeEditTicker").value = holding.symbol || "";
  $("#financeEditCashCurrency").value = holding.currency || financeData?.currency || "CAD";
  $("#financeEditCashName").value = holding.type === "CASH" && holding.name !== `${holding.currency} cash` ? holding.name || "" : "";
  $("#financeEditQuantity").value = holding.quantity;
  renderFinanceCategoryOptions($("#financeEditAllocationCategory"), holding.allocationCategoryId);
  $("#financeEditHoldingError").textContent = "";
  updateFinanceEditHoldingFields();
  $("#financeEditHoldingDialog").showModal();
  requestAnimationFrame(() => (holding.type === "STOCK" ? $("#financeEditTicker") : $("#financeEditCashName")).focus());
}

async function saveFinanceHolding(event) {
  event.preventDefault();
  const type = $("#financeEditHoldingType").value;
  const body = { type, quantity: Number($("#financeEditQuantity").value), allocationCategoryId: $("#financeEditAllocationCategory").value || null, ...(type === "STOCK" ? { symbol: $("#financeEditTicker").value } : { currency: $("#financeEditCashCurrency").value, name: $("#financeEditCashName").value }) };
  const submit = $('button[type="submit"]', event.currentTarget);
  const errorElement = $("#financeEditHoldingError");
  errorElement.textContent = "";
  submit.disabled = true;
  try {
    financeData = await window.tempoServer.updateFinanceHolding($("#financeEditHoldingId").value, body);
    $("#financeEditHoldingDialog").close();
    renderFinances();
    await refreshFinancePrices(true);
    toast("Holding updated.");
  } catch (error) {
    errorElement.textContent = error.message || "Could not update that holding.";
  } finally {
    submit.disabled = false;
  }
}

function deleteFinanceHolding(row) {
  const holding = financeData?.holdings?.find(item => String(item.id) === row.dataset.financeHoldingId);
  const label = holding?.type === "CASH" ? holding.name || `${holding.currency} cash` : holding?.symbol || "holding";
  openDeleteConfirmation(`Delete ${label}?`, "This removes the holding from your portfolio.", async () => {
    try { financeData = await window.tempoServer.deleteFinanceHolding(row.dataset.financeHoldingId); renderFinances(); toast("Holding deleted."); }
    catch (error) { toast(error.message || "Could not delete that holding."); }
  });
}

const primaryViewOrder = ["timersView", "foodLogView", "strengthView", "cardioView", "sleepView", "financesView"];
const primaryViewParents = { foodLibraryView: "foodLogView", workoutLibraryView: "strengthView", workoutSessionView: "strengthView", cardioSessionView: "cardioView", allocationLibraryView: "financesView" };
let metroTransitionDirection = 0;

function primaryViewFor(viewId) { return primaryViewParents[viewId] || viewId; }

function centerActivePageTab(behavior = "smooth") {
  const activeTab = $('.app-nav [aria-current="page"]');
  if (activeTab) activeTab.scrollIntoView({ behavior, block: "nearest", inline: "center" });
}

function navigateToPrimaryView(viewId, direction = 0) {
  if (!primaryViewOrder.includes(viewId) || viewId === activeView) return;
  metroTransitionDirection = direction || Math.sign(primaryViewOrder.indexOf(viewId) - primaryViewOrder.indexOf(primaryViewFor(activeView)));
  showView(viewId);
}

function installMetroPager() {
  const pager = $("#pagePager");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ignoredSwipeTarget = "button,a,input,select,textarea,label,[contenteditable],[data-drag-id],[data-page-swipe-ignore],.drag-handle,.finance-summary-grid,.finance-table-wrap,.strength-week-tabs";
  let gesture = null;
  let snapbackTimer = null;

  const resetDraggedView = view => {
    const draggedView = view || gesture?.view;
    if (draggedView) {
      draggedView.style.removeProperty("transform");
      draggedView.style.removeProperty("transition");
    }
    pager.classList.remove("is-paging");
  };

  const beginGesture = (target, id, x, y) => {
    const currentPrimary = primaryViewFor(activeView);
    if (!primaryViewOrder.includes(currentPrimary) || activeView !== currentPrimary || target.closest(ignoredSwipeTarget)) return false;
    const view = $(`#${activeView}`);
    if (snapbackTimer) { clearTimeout(snapbackTimer); snapbackTimer = null; }
    resetDraggedView(view);
    gesture = { id, startX: x, startY: y, dx: 0, horizontal: false, samples: [], view };
    return true;
  };

  const recordSample = (x, time = performance.now()) => {
    gesture.samples.push({ x, time });
    while (gesture.samples.length > 2 && gesture.samples[1].time < time - 120) gesture.samples.shift();
  };

  const moveGesture = (id, x, y, claimHorizontalGesture) => {
    if (!gesture || gesture.id !== id) return;
    const dx = x - gesture.startX;
    const dy = y - gesture.startY;
    let justLocked = false;
    if (!gesture.horizontal) {
      const absX = Math.abs(dx), absY = Math.abs(dy);
      if (Math.max(absX, absY) < 12) return;
      if (absY > absX * 1.25) { gesture = null; return; }
      if (absX <= absY * 1.1) return;
      gesture.horizontal = true;
      gesture.samples = [];
      justLocked = true;
      pager.classList.add("is-paging");
    }
    claimHorizontalGesture(justLocked);
    recordSample(x);
    const index = primaryViewOrder.indexOf(activeView);
    const atEdge = (index === 0 && dx > 0) || (index === primaryViewOrder.length - 1 && dx < 0);
    gesture.dx = atEdge ? dx * .22 : dx;
    gesture.view.style.transition = "none";
    gesture.view.style.transform = `translateX(${gesture.dx}px)`;
  };

  const finishGesture = (id, finalX) => {
    if (!gesture || gesture.id !== id) return;
    if (gesture.horizontal && Number.isFinite(finalX)) {
      const rawDx = finalX - gesture.startX;
      const index = primaryViewOrder.indexOf(activeView);
      const atEdge = (index === 0 && rawDx > 0) || (index === primaryViewOrder.length - 1 && rawDx < 0);
      gesture.dx = atEdge ? rawDx * .22 : rawDx;
      recordSample(finalX);
    }
    const finished = gesture;
    const firstSample = finished.samples[0], lastSample = finished.samples.at(-1);
    const velocity = firstSample && lastSample && lastSample.time > firstSample.time ? (lastSample.x - firstSample.x) / (lastSample.time - firstSample.time) : 0;
    const direction = finished.dx < 0 ? 1 : -1;
    const currentIndex = primaryViewOrder.indexOf(activeView);
    const targetIndex = currentIndex + direction;
    const travelThreshold = Math.min(88, Math.max(56, pager.clientWidth * .09));
    const shouldNavigate = finished.horizontal && targetIndex >= 0 && targetIndex < primaryViewOrder.length && (Math.abs(finished.dx) > travelThreshold || Math.abs(velocity) > .4);
    gesture = null;
    pager.classList.remove("is-paging");
    if (shouldNavigate) {
      resetDraggedView(finished.view);
      navigateToPrimaryView(primaryViewOrder[targetIndex], direction);
    }
    else if (finished.horizontal && !reducedMotion.matches) {
      finished.view.style.transition = "transform .18s cubic-bezier(.2,.75,.25,1)";
      requestAnimationFrame(() => { finished.view.style.transform = "translateX(0)"; });
      snapbackTimer = setTimeout(() => { resetDraggedView(finished.view); snapbackTimer = null; }, 190);
    } else resetDraggedView(finished.view);
  };

  const cancelGesture = id => {
    if (!gesture || gesture.id !== id) return;
    resetDraggedView(gesture.view);
    gesture = null;
  };

  pager.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" || event.button !== 0) return;
    beginGesture(event.target, event.pointerId, event.clientX, event.clientY);
  });
  pager.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    moveGesture(event.pointerId, event.clientX, event.clientY, justLocked => {
      if (justLocked) pager.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
  });
  pager.addEventListener("pointerup", event => finishGesture(event.pointerId, event.clientX));
  pager.addEventListener("pointercancel", event => {
    if (event.pointerType !== "touch") cancelGesture(event.pointerId);
  });

  pager.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    beginGesture(event.target, `touch:${touch.identifier}`, touch.clientX, touch.clientY);
  }, { passive: true });
  pager.addEventListener("touchmove", event => {
    if (!gesture || !String(gesture.id).startsWith("touch:")) return;
    const identifier = Number(String(gesture.id).slice(6));
    const touch = Array.from(event.touches).find(item => item.identifier === identifier);
    if (touch) moveGesture(gesture.id, touch.clientX, touch.clientY, () => event.preventDefault());
  }, { passive: false });
  pager.addEventListener("touchend", event => {
    if (!gesture || !String(gesture.id).startsWith("touch:")) return;
    const identifier = Number(String(gesture.id).slice(6));
    const touch = Array.from(event.changedTouches).find(item => item.identifier === identifier);
    if (touch) finishGesture(gesture.id, touch.clientX);
  });
  pager.addEventListener("touchcancel", event => {
    if (!gesture || !String(gesture.id).startsWith("touch:")) return;
    const identifier = Number(String(gesture.id).slice(6));
    if (Array.from(event.changedTouches).some(item => item.identifier === identifier)) cancelGesture(gesture.id);
  });
}

async function changeFinanceCurrency(event) {
  const select = event.target; select.disabled = true;
  try { financeData = await window.tempoServer.setFinanceCurrency(select.value); renderFinances(); renderFinanceSettings(); toast(`Portfolio currency changed to ${select.value}. Exchange rates refresh when you visit Finances.`); }
  catch (error) { renderFinanceSettings(); toast(error.message || "Could not change portfolio currency."); }
}

function detailIdForView(viewId) {
  if (viewId === "cardioSessionView") return selectedCardioSessionId;
  if (viewId === "workoutSessionView") return activeStrengthSessionId;
  return null;
}

function updateViewLinkPaths() {
  $$('[data-view-link]').forEach(link => { link.href = pathForView(privateBasePath, link.dataset.viewLink); });
}

function showView(viewId, updateHistory = true) {
  activeView = viewId;
  $$(".view").forEach(view => view.classList.toggle("active", view.id === viewId));
  $$('[data-view-link]').forEach(link => link.setAttribute("aria-current", link.dataset.viewLink === viewId || (viewId === "foodLibraryView" && link.dataset.viewLink === "foodLogView") || (["workoutLibraryView", "workoutSessionView"].includes(viewId) && link.dataset.viewLink === "strengthView") || (viewId === "cardioSessionView" && link.dataset.viewLink === "cardioView") || (viewId === "allocationLibraryView" && link.dataset.viewLink === "financesView") ? "page" : "false"));
  if (updateHistory) {
    const path = pathForView(privateBasePath, viewId, detailIdForView(viewId));
    if (location.pathname !== path) history.pushState(null, "", `${path}${location.search}`);
  }
  const title = viewId === "timersView" ? "tempo" : `${$("#" + viewId + " h1")?.textContent?.trim() || "tempo"} · tempo`;
  document.title = title;
  if (viewId === "foodLibraryView") renderFoodLibrary();
  if (viewId === "foodLogView") renderFoodLog();
  if (viewId === "strengthView") renderStrength();
  if (viewId === "workoutLibraryView") renderWorkoutLibrary();
  if (viewId === "workoutSessionView") renderStrengthLogger();
  if (viewId === "settingsView") { renderSettings(); loadFinances(); loadCardio(); loadSleep(); }
  if (viewId === "cardioView") visitCardio();
  if (viewId === "timersView" && !cardioData) loadCardio();
  if (viewId === "timersView" && !sleepData) loadSleep();
  if (viewId === "sleepView") visitSleep();
  if (viewId === "financesView") visitFinances();
  if (viewId === "allocationLibraryView") { loadFinances(); renderAllocationLibrary(); }
  if (viewId === "cardioSessionView") renderCardioSessionDetailPage();
  const enteredView = $(`#${viewId}`);
  if (metroTransitionDirection && enteredView && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    enteredView.style.setProperty("--metro-enter-x", `${metroTransitionDirection * 72}px`);
    enteredView.classList.remove("metro-page-entering");
    void enteredView.offsetWidth;
    enteredView.classList.add("metro-page-entering");
    enteredView.addEventListener("animationend", () => enteredView.classList.remove("metro-page-entering"), { once: true });
  }
  metroTransitionDirection = 0;
  requestAnimationFrame(() => centerActivePageTab(updateHistory ? "smooth" : "auto"));
  window.scrollTo({ top: 0, behavior: "smooth" });
  schedulePageWalkthrough(viewId);
}

const generalWalkthroughSteps = [
  {
    view: "timersView", target: ".brand", title: "Welcome to your Tempo space",
    description: "This is your private place for tracking the routines and signals that shape your days. Only someone with your private link can open it."
  },
  {
    view: "timersView", target: ".daily-progress-panel", title: "See the day at a glance",
    description: "Your progress rings bring habits and nutrition goals together. Momentum above shows how those daily scores build across the week."
  },
  {
    view: "timersView", target: "#newTimerButton", title: "Make time intentional",
    description: "Create timers for focused work, breaks, reading, or anything else you want to give protected time."
  },
  {
    view: "timersView", target: "#newHabitButton", title: "Track repeatable habits",
    description: "Add a counter for measurable habits or a simple toggle for yes-or-no routines, then choose the days each one appears."
  },
  {
    view: "timersView", target: ".app-nav", title: "Bring the rest of your day together",
    description: "Use the main navigation for nutrition, strength training, cardio, sleep, and finances. Each area stays inside this same private space."
  },
  {
    view: "settingsView", target: ".settings-share-card", title: "Keep your private link safe",
    description: "This link is the key to your Tempo space. Save it somewhere secure, or scan the QR code to open the same space on another device."
  }
];

const pageWalkthroughs = {
  foodLogView: {
    page: "nutrition",
    steps: [
      { view: "foodLogView", target: ".nutrition-page-heading", title: "Your nutrition workspace", description: "Log food for today or any of the previous seven days, and open the Food library when you need to manage reusable foods and meals." },
      { view: "foodLogView", target: ".nutrition-totals-card", title: "Measure against your daily goal", description: "Your calorie and macro totals update as you log food. Set a nutrition goal to see progress for calories, carbs, protein, fats, and fibre." },
      { view: "foodLogView", target: ".quick-log-card", title: "Log food without slowing down", description: "Search your saved foods and meals, use recent items, or create a new food directly from this panel." },
      { view: "foodLogView", target: "#openFoodLibraryButton", title: "Build your Food library", description: "Create reusable foods and meals, or import and export foods as CSV when you want to manage them in bulk." }
    ]
  },
  strengthView: {
    page: "strength",
    steps: [
      { view: "strengthView", target: ".strength-page-heading", title: "Plan progressive strength training", description: "Strength combines reusable workouts with multi-week training blocks, so each session follows a clear plan." },
      { view: "strengthView", target: "#strengthTemplateButton", title: "Start with your Workout Library", description: "Create the workouts you repeat, including exercises, muscle groups, sets, reps, and starting loads." },
      { view: "strengthView", target: "#newMesocycleButton", title: "Organize workouts into a block", description: "A training block schedules your workouts across several weeks and applies the progression rate you choose." },
      { view: "strengthView", target: "#strengthContent", title: "Train and review progress here", description: "Start scheduled workouts, record every set, complete weeks, and compare muscle-group volume as your block progresses." }
    ]
  },
  cardioView: {
    page: "cardio",
    steps: [
      { view: "cardioView", target: ".cardio-page-heading", title: "Bring in your cardio activity", description: "Connect Google Health once. Tempo automatically imports resting heart rate, daily steps, and treadmill sessions whenever you visit Cardio." },
      { view: "cardioView", target: "#cardioContent", title: "Explore trends and sessions", description: "Use the range and calendar views to understand trends, then open a treadmill session for its heart-rate zones and detailed timeline." }
    ]
  },
  sleepView: {
    page: "sleep",
    steps: [
      { view: "sleepView", target: ".sleep-page-heading", title: "Understand your sleep", description: "Sleep uses the same Google Health connection as Cardio and automatically imports recent nights and their recorded stages whenever you visit." },
      { view: "sleepView", target: "#sleepContent", title: "Review duration and sleep stages", description: "See nightly duration at a glance and inspect how each night was divided across the available sleep stages." }
    ]
  },
  financesView: {
    page: "finances",
    steps: [
      { view: "financesView", target: ".finances-page-heading", title: "Build your portfolio and target mix", description: "Create allocation categories with target percentages, then assign each stock or cash holding to a category when you add or edit it." },
      { view: "financesView", target: "#financesContent", title: "See where your allocation has drifted", description: "Tempo compares each category’s current share of market value with its target, so you can see portfolio drift alongside performance and holding totals." }
    ]
  },
  settingsView: {
    page: "settings",
    steps: [
      { view: "settingsView", target: ".settings-share-card", title: "Open this space on another device", description: "Copy the private URL or scan its QR code, and remember that anyone with this link receives full access to the space." },
      { view: "settingsView", target: "#settingsNutritionGoalCard", title: "Configure your nutrition goal", description: "Set the daily calorie and macro targets used by Nutrition and the progress summaries on Home." },
      { view: "settingsView", target: "#settingsFinanceCurrencyCard", title: "Choose your portfolio currency", description: "Finances converts supported stocks and cash into this display currency throughout the portfolio." }
    ]
  }
};

function pageWalkthroughSeen(page) {
  return Boolean(window.__TEMPO_BOOTSTRAP__?.walkthrough?.pages?.[page]);
}

function startPageWalkthrough(viewId) {
  const walkthrough = pageWalkthroughs[viewId];
  if (!walkthrough || walkthroughActive || pageWalkthroughSeen(walkthrough.page) || activeView !== viewId) return;
  startWalkthrough(walkthrough.steps, walkthrough.page, viewId);
}

function schedulePageWalkthrough(viewId) {
  clearTimeout(pageWalkthroughTimer);
  if (!pageWalkthroughReady || walkthroughActive || !pageWalkthroughs[viewId]) return;
  pageWalkthroughTimer = setTimeout(() => startPageWalkthrough(viewId), 350);
}

function positionWalkthrough() {
  if (!walkthroughActive) return;
  const step = activeWalkthroughSteps[walkthroughStepIndex];
  const target = $(step.target);
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const padding = 8;
  const spotlight = $("#walkthroughSpotlight");
  const top = Math.max(8, rect.top - padding);
  const left = Math.max(8, rect.left - padding);
  const right = Math.min(innerWidth - 8, rect.right + padding);
  const bottom = Math.min(innerHeight - 8, rect.bottom + padding);
  spotlight.style.top = `${top}px`;
  spotlight.style.left = `${left}px`;
  spotlight.style.width = `${Math.max(36, right - left)}px`;
  spotlight.style.height = `${Math.max(36, bottom - top)}px`;

  const popover = $("#walkthroughPopover");
  const popoverRect = popover.getBoundingClientRect();
  const gap = 18;
  const margin = 16;
  const availableBelow = innerHeight - bottom;
  const availableAbove = top;
  let popoverTop;
  if (availableBelow >= popoverRect.height + gap + margin) popoverTop = bottom + gap;
  else if (availableAbove >= popoverRect.height + gap + margin) popoverTop = top - popoverRect.height - gap;
  else popoverTop = Math.max(margin, Math.min(innerHeight - popoverRect.height - margin, availableBelow >= availableAbove ? bottom + gap : top - popoverRect.height - gap));
  const popoverLeft = Math.max(margin, Math.min(innerWidth - popoverRect.width - margin, rect.left + rect.width / 2 - popoverRect.width / 2));
  popover.style.top = `${popoverTop}px`;
  popover.style.left = `${popoverLeft}px`;
}

function queueWalkthroughPosition() {
  if (walkthroughLayoutFrame) return;
  walkthroughLayoutFrame = requestAnimationFrame(() => { walkthroughLayoutFrame = null; positionWalkthrough(); });
}

function showWalkthroughStep(index) {
  walkthroughStepIndex = Math.max(0, Math.min(activeWalkthroughSteps.length - 1, index));
  const step = activeWalkthroughSteps[walkthroughStepIndex];
  const transition = ++walkthroughStepTransition;
  if (activeView !== step.view) showView(step.view);
  $("#walkthroughProgress").textContent = `Step ${walkthroughStepIndex + 1} of ${activeWalkthroughSteps.length}`;
  $("#walkthroughTitle").textContent = step.title;
  $("#walkthroughDescription").textContent = step.description;
  $("#walkthroughError").hidden = true;
  $("#previousWalkthroughButton").hidden = walkthroughStepIndex === 0;
  $("#nextWalkthroughButton").textContent = walkthroughStepIndex === activeWalkthroughSteps.length - 1 ? "Finish" : "Next";
  $("#walkthroughDots").innerHTML = activeWalkthroughSteps.map((_, dotIndex) => `<i class="${dotIndex === walkthroughStepIndex ? "active" : ""}"></i>`).join("");
  requestAnimationFrame(() => {
    if (!walkthroughActive || transition !== walkthroughStepTransition) return;
    const target = $(step.target);
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    requestAnimationFrame(() => {
      if (!walkthroughActive || transition !== walkthroughStepTransition) return;
      positionWalkthrough();
      $("#nextWalkthroughButton").focus();
    });
  });
}

function setWalkthroughBusy(value) {
  walkthroughBusy = value;
  ["#skipWalkthroughButton", "#previousWalkthroughButton", "#nextWalkthroughButton"].forEach(selector => { $(selector).disabled = value; });
}

function closeWalkthrough() {
  const returnView = walkthroughReturnView;
  const page = activeWalkthroughPage;
  walkthroughStepTransition += 1;
  walkthroughActive = false;
  activeWalkthroughPage = null;
  activeWalkthroughSteps = [];
  setWalkthroughBusy(false);
  $("#walkthroughOverlay").hidden = true;
  $(".app-shell").removeAttribute("inert");
  document.body.classList.remove("walkthrough-active");
  window.removeEventListener("resize", queueWalkthroughPosition);
  window.removeEventListener("scroll", queueWalkthroughPosition, true);
  showView(returnView);
  requestAnimationFrame(() => page ? $(`#${returnView} h1, #${returnView} h2`)?.focus() : $(".brand")?.focus());
}

async function finishWalkthrough(status) {
  if (walkthroughBusy) return;
  setWalkthroughBusy(true);
  $("#walkthroughError").hidden = true;
  try {
    if (activeWalkthroughPage) {
      await window.tempoServer.setPageWalkthroughStatus(activeWalkthroughPage, status);
      window.__TEMPO_BOOTSTRAP__.walkthrough.pages ||= {};
      window.__TEMPO_BOOTSTRAP__.walkthrough.pages[activeWalkthroughPage] = status;
    } else {
      await window.tempoServer.setWalkthroughStatus(status);
      if (window.__TEMPO_BOOTSTRAP__?.walkthrough) window.__TEMPO_BOOTSTRAP__.walkthrough.status = status;
    }
    closeWalkthrough();
  } catch (error) {
    setWalkthroughBusy(false);
    const message = $("#walkthroughError");
    message.textContent = error.message || "Could not save your walkthrough choice. Check your connection and try again.";
    message.hidden = false;
    $("#nextWalkthroughButton").focus();
    positionWalkthrough();
  }
}

function handleWalkthroughKeydown(event) {
  if (!walkthroughActive) return;
  if (event.key === "Escape") { event.preventDefault(); finishWalkthrough("dismissed"); return; }
  if (event.key !== "Tab") return;
  const controls = $$('button:not([disabled]):not([hidden])', $("#walkthroughPopover"));
  if (!controls.length) return;
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function startWalkthrough(steps = generalWalkthroughSteps, page = null, returnView = "timersView") {
  if (walkthroughActive) return;
  clearTimeout(pageWalkthroughTimer);
  walkthroughActive = true;
  activeWalkthroughSteps = steps;
  activeWalkthroughPage = page;
  walkthroughReturnView = returnView;
  $("#walkthroughOverlay").hidden = false;
  $(".app-shell").setAttribute("inert", "");
  document.body.classList.add("walkthrough-active");
  window.addEventListener("resize", queueWalkthroughPosition);
  window.addEventListener("scroll", queueWalkthroughPosition, true);
  showWalkthroughStep(0);
}

async function replayWalkthroughs() {
  const button = $("#replayWalkthroughButton");
  button.disabled = true;
  try {
    const walkthrough = await window.tempoServer.resetWalkthroughs();
    window.__TEMPO_BOOTSTRAP__.walkthrough = walkthrough;
    startWalkthrough();
  } catch (error) {
    toast(error.message || "Could not reset the walkthroughs. Check your connection and try again.");
  } finally {
    button.disabled = false;
  }
}

function renderSettings() {
  syncTimers(); saveState("timers");
  renderPrivateAreaShare();
  $("#settingsNutritionGoalButton").textContent = state.nutritionGoal ? "Edit goal" : "Set up goal";
  $("#settingsNutritionGoalSummary").innerHTML = state.nutritionGoal
    ? nutrientKeys.map(key => `<div><span>${nutrientLabels[key]}</span><strong>${formatNutrition(state.nutritionGoal[key], key)}</strong></div>`).join("")
    : `<p>No nutrition goal configured.</p>`;
  const cardioGoal = Number(cardioData?.zone2GoalMinutes) > 0 ? Number(cardioData.zone2GoalMinutes) : null;
  $("#settingsCardioGoalButton").textContent = cardioGoal ? "Edit goal" : "Set up goal";
  $("#settingsCardioGoalButton").disabled = cardioLoading && !cardioData;
  $("#settingsCardioGoalSummary").innerHTML = cardioGoal
    ? `<div><span>Weekly Zone 2</span><strong>${cardioGoal} min</strong></div>`
    : `<p>${cardioLoading ? "Loading cardio goal…" : cardioError ? "Cardio goal unavailable." : "No Zone 2 cardio goal configured."}</p>`;
  const stepsGoal = Number(cardioData?.dailyStepsGoal) > 0 ? Number(cardioData.dailyStepsGoal) : null;
  $("#settingsStepsGoalButton").textContent = stepsGoal ? "Edit goal" : "Set up goal";
  $("#settingsStepsGoalButton").disabled = cardioLoading && !cardioData;
  $("#settingsStepsGoalSummary").innerHTML = stepsGoal
    ? `<div><span>Daily steps</span><strong>${new Intl.NumberFormat().format(stepsGoal)} steps</strong></div>`
    : `<p>${cardioLoading ? "Loading steps goal…" : cardioError ? "Steps goal unavailable." : "No daily steps goal configured."}</p>`;
  const sleepGoal = sleepData?.goal;
  $("#settingsSleepGoalButton").textContent = sleepGoal ? "Edit goal" : "Set up goal";
  $("#settingsSleepGoalButton").disabled = sleepLoading && !sleepData;
  $("#settingsSleepGoalSummary").innerHTML = sleepGoal
    ? `<div><span>Duration</span><strong>${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(sleepGoal.minutes / 60)} hours</strong></div><div><span>Asleep by</span><strong>${escapeHtml(formatSleepGoalTime(sleepGoal.startTime))}</strong></div>`
    : `<p>${sleepLoading ? "Loading sleep goal…" : sleepError ? "Sleep goal unavailable." : "No sleep goal configured."}</p>`;
  renderFinanceSettings();
}

function renderPrivateAreaShare() {
  const shareUrl = `${location.origin}${location.pathname}`;
  const qrContainer = $("#privateAreaQrCode");
  $("#privateAreaUrl").value = shareUrl;
  if (qrContainer.dataset.url === shareUrl) return;
  if (typeof window.qrcode !== "function") {
    qrContainer.innerHTML = "<p>QR code unavailable. Use Copy link instead.</p>";
    return;
  }
  const qr = window.qrcode(0, "M");
  qr.addData(shareUrl);
  qr.make();
  qrContainer.innerHTML = qr.createSvgTag({
    cellSize: 5,
    margin: 20,
    scalable: true,
    title: "Private Tempo area QR code",
    alt: "Scan to open this private Tempo area on another device."
  });
  qrContainer.dataset.url = shareUrl;
}

async function copyPrivateAreaUrl() {
  const input = $("#privateAreaUrl");
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
    else {
      input.select();
      if (!document.execCommand("copy")) throw new Error("Copy was not available.");
      input.setSelectionRange(0, 0);
    }
    toast("Private link copied.");
  } catch {
    input.focus(); input.select();
    toast("Couldn’t copy automatically. Copy the selected link.");
  }
}

function openFoodDialog(food = null) {
  $("#foodForm").reset();
  $("#editFoodId").value = food?.id || "";
  $("#foodDialogTitle").textContent = food ? "Edit food" : "New food";
  $("#foodTitle").value = food?.title || "";
  $("#foodServingSize").value = food?.servingSize ?? 100;
  $("#foodServingUnit").value = servingUnits.includes(food?.servingUnit) ? food.servingUnit : "g";
  nutrientKeys.forEach(key => { $(`#food${key[0].toUpperCase()}${key.slice(1)}`).value = food?.[key] ?? 0; });
  $("#foodFormError").textContent = "";
  $("#foodDialog").showModal();
  requestAnimationFrame(() => $("#foodTitle").focus());
}

function saveFood(event) {
  event.preventDefault();
  const id = $("#editFoodId").value;
  const title = $("#foodTitle").value.trim();
  const servingSize = Number($("#foodServingSize").value);
  const servingUnit = $("#foodServingUnit").value.trim();
  const nutrients = Object.fromEntries(nutrientKeys.map(key => [key, Number($(`#food${key[0].toUpperCase()}${key.slice(1)}`).value)]));
  if (!title || !servingUnit || !Number.isFinite(servingSize) || servingSize <= 0 || Object.values(nutrients).some(value => !Number.isFinite(value) || value < 0)) {
    $("#foodFormError").textContent = "Enter a title, a positive serving size, and non-negative nutrition values.";
    return;
  }
  const existing = state.foods.find(food => food.id === id);
  const food = { id: existing?.id || uid(), title, servingSize, servingUnit, ...nutrients };
  if (existing) Object.assign(existing, food); else state.foods.unshift(food);
  saveState("foods");
  $("#foodDialog").close();
  renderFoodLibrary();
  renderFoodLog();
  renderDailyRings();
  toast(existing ? "Food updated." : `${title} added to your library.`);
}

function deleteFood(id) {
  const food = state.foods.find(item => item.id === id);
  const affectedMeals = state.meals.filter(meal => meal.items.some(item => item.foodId === id));
  const mealWarning = affectedMeals.length ? ` It will also be removed from ${affectedMeals.length} meal${affectedMeals.length === 1 ? "" : "s"}.` : "";
  if (!food) return;
  openDeleteConfirmation(`Delete “${food.title}”?`, `The food will be removed from your library. Existing log entries will be kept.${mealWarning}`, () => {
    state.foods = state.foods.filter(item => item.id !== id);
    state.meals.forEach(meal => { meal.items = meal.items.filter(item => item.foodId !== id); });
    const emptyMealIds = new Set(state.meals.filter(meal => !meal.items.length).map(meal => meal.id));
    state.meals = state.meals.filter(meal => meal.items.length);
    state.recentFoodIds = state.recentFoodIds.filter(foodId => foodId !== id);
    state.recentMealIds = state.recentMealIds.filter(mealId => !emptyMealIds.has(mealId));
    saveState(["foods", "meals", "foodLogs"]); renderFoodLibrary(); renderFoodLog(); toast("Food removed from your library.");
  });
}

function addMealItemRow(item = null) {
  const fallbackFood = state.foods[0];
  const food = state.foods.find(candidate => String(candidate.id) === String(item?.foodId)) || fallbackFood;
  if (!food) return;
  const row = document.createElement("div");
  row.className = "meal-item-row";
  row.innerHTML = `<label class="meal-food-field">Food<select data-meal-food>${state.foods.slice().sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })).map(option => `<option value="${option.id}" ${String(option.id) === String(food.id) ? "selected" : ""}>${escapeHtml(option.title)}</option>`).join("")}</select></label><label class="meal-serving-field">Serving<input data-meal-serving type="number" min="0.01" step="any" value="${item?.servingSize ?? food.servingSize}" required inputmode="decimal" /></label><span data-meal-unit>${escapeHtml(food.servingUnit)}</span><button type="button" data-remove-meal-item aria-label="Remove ${escapeHtml(food.title)}">${icon("trash-2", "Delete")}</button>`;
  $("#mealItems").append(row);
  renderMealPreview();
}

function collectMealItems() {
  return $$(".meal-item-row", $("#mealItems")).map(row => {
    const selectedId = $("[data-meal-food]", row).value;
    const food = state.foods.find(item => String(item.id) === selectedId);
    return { foodId: food?.id ?? selectedId, servingSize: Number($("[data-meal-serving]", row).value) };
  });
}

function renderMealPreview() {
  const items = collectMealItems().filter(item => item.foodId && Number.isFinite(item.servingSize) && item.servingSize > 0);
  const totals = mealNutrients({ items });
  $("#mealPreview").innerHTML = items.length ? `<strong>${formatNutrition(totals.calories, "calories")}</strong>${["carbs", "protein", "fats", "fibre"].map(key => `<span>${nutrientLabels[key]} <b>${roundNutrition(totals[key])}g</b></span>`).join("")}` : "Add at least one food.";
}

function openMealDialog(meal = null) {
  if (!state.foods.length) { libraryTab = "foods"; renderFoodLibrary(); toast("Add a food before creating a meal."); return; }
  $("#mealForm").reset(); $("#editMealId").value = meal?.id || ""; $("#mealDialogTitle").textContent = meal ? "Edit meal" : "New meal"; $("#mealTitle").value = meal?.title || "";
  $("#mealItems").innerHTML = ""; (meal?.items?.length ? meal.items : [null]).forEach(addMealItemRow); $("#mealFormError").textContent = ""; renderMealPreview();
  $("#mealDialog").showModal(); requestAnimationFrame(() => $("#mealTitle").focus());
}

function saveMeal(event) {
  event.preventDefault(); const id = $("#editMealId").value; const title = $("#mealTitle").value.trim(); const items = collectMealItems();
  if (!title || !items.length || items.some(item => !state.foods.some(food => String(food.id) === String(item.foodId)) || !Number.isFinite(item.servingSize) || item.servingSize <= 0)) { $("#mealFormError").textContent = "Enter a meal title and at least one valid food serving."; return; }
  const existing = state.meals.find(meal => meal.id === id); const meal = { id: existing?.id || uid(), title, items };
  if (existing) Object.assign(existing, meal); else state.meals.push(meal);
  saveState("meals"); $("#mealDialog").close(); renderFoodLibrary(); renderFoodLog(); toast(existing ? "Meal updated." : `${title} added to your library.`);
}

function deleteMeal(id) {
  const meal = state.meals.find(item => item.id === id);
  if (!meal) return;
  openDeleteConfirmation(`Delete “${meal.title}”?`, "The meal will be removed, but its foods will stay in your library.", () => {
    state.meals = state.meals.filter(item => item.id !== id); state.recentMealIds = state.recentMealIds.filter(mealId => mealId !== id);
    saveState(["meals", "foodLogs"]); renderFoodLibrary(); renderFoodLog(); toast("Meal deleted.");
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportFoodLibrary() {
  if (!state.foods.length) { toast("Add a food before exporting."); return; }
  const columns = ["title", "serving_size", "unit", ...nutrientKeys];
  const foods = [...state.foods].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const rows = [columns, ...foods.map(food => [food.title, food.servingSize, food.servingUnit, ...nutrientKeys.map(key => food[key])])];
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `tempo-food-library-${dayKey()}.csv`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  toast(`${state.foods.length} food${state.foods.length === 1 ? "" : "s"} exported.`);
}

function parseCsv(text) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function importFoodLibrary(file) {
  if (!file) return;
  try {
    const rows = parseCsv((await file.text()).replace(/^\uFEFF/, "")).filter(row => row.some(cell => cell.trim()));
    if (rows.length < 2) throw new Error("empty");
    const headers = rows[0].map(header => header.trim().toLowerCase().replace(/[^a-z]/g, ""));
    const findColumn = (...names) => headers.findIndex(header => names.includes(header));
    const indexes = {
      title: findColumn("title", "name", "food"), servingSize: findColumn("servingsize", "defaultservingsize", "serving"), servingUnit: findColumn("unit", "servingunit"),
      calories: findColumn("calories", "calorie", "kcal"), carbs: findColumn("carbs", "carbohydrates", "carbohydrate"), protein: findColumn("protein"), fats: findColumn("fats", "fat"), fibre: findColumn("fibre", "fiber")
    };
    if (Object.values(indexes).some(index => index < 0)) throw new Error("headers");
    let added = 0; let updated = 0; let skipped = 0;
    rows.slice(1).forEach(row => {
      const title = String(row[indexes.title] || "").trim();
      const servingSize = Number(row[indexes.servingSize]);
      const servingUnit = normalizeServingUnit(row[indexes.servingUnit]);
      const nutrients = Object.fromEntries(nutrientKeys.map(key => [key, Number(row[indexes[key]])]));
      if (!title || !servingUnit || !Number.isFinite(servingSize) || servingSize <= 0 || Object.values(nutrients).some(value => !Number.isFinite(value) || value < 0)) { skipped += 1; return; }
      const existing = state.foods.find(food => food.title.localeCompare(title, undefined, { sensitivity: "base" }) === 0);
      const food = { id: existing?.id || uid(), title, servingSize, servingUnit, ...nutrients };
      if (existing) { Object.assign(existing, food); updated += 1; } else { state.foods.push(food); added += 1; }
    });
    if (!added && !updated) throw new Error("rows");
    saveState("foods"); renderFoodLibrary(); renderFoodLog(); renderDailyRings();
    toast(`CSV imported · ${added} added · ${updated} updated${skipped ? ` · ${skipped} skipped` : ""}.`);
  } catch (_) { toast("Couldn’t import CSV. Check its columns and values."); }
  finally { $("#foodCsvInput").value = ""; }
}

function renderFoodLibrary() {
  $("#newLibraryItemButton").innerHTML = `${icon("plus", "+")}New`;
  const query = $("#librarySearchInput").value.trim().toLowerCase();
  const isFoods = libraryTab === "foods";
  $("#foodsLibraryTab").setAttribute("aria-selected", String(isFoods)); $("#mealsLibraryTab").setAttribute("aria-selected", String(!isFoods));
  $("#librarySearchInput").placeholder = isFoods ? "Search foods…" : "Search meals…"; $("#librarySearchInput").setAttribute("aria-label", isFoods ? "Search food library" : "Search meal library");
  $("#importFoodsButton").hidden = !isFoods; $("#exportFoodsButton").hidden = !isFoods; $("#exportFoodsButton").disabled = !state.foods.length;
  if (isFoods) {
    const foods = state.foods.filter(food => food.title.toLowerCase().includes(query)).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    $("#foodLibraryCount").textContent = `${state.foods.length} food${state.foods.length === 1 ? "" : "s"}`;
    $("#foodLibraryGrid").innerHTML = foods.length ? foods.map(food => `<article class="food-card" data-food-id="${food.id}">
      <div class="food-card-top"><div><span>${escapeHtml(String(food.servingSize))} ${escapeHtml(food.servingUnit)} serving</span><h2>${escapeHtml(food.title)}</h2></div><button class="menu-button" type="button" data-food-action="menu" aria-label="Options for ${escapeHtml(food.title)}">${icon("ellipsis", "…")}</button></div>
      <div class="menu food-menu"><button type="button" data-food-action="edit">Edit food</button><button class="danger" type="button" data-food-action="delete">Delete food</button></div>
      <div class="food-calories"><strong>${roundNutrition(food.calories, 0)}</strong><span>kcal</span></div>
      <div class="food-macros">${["carbs", "protein", "fats", "fibre"].map(key => `<div><span>${nutrientLabels[key]}</span><strong>${roundNutrition(food[key])}g</strong></div>`).join("")}</div>
    </article>`).join("") : `<div class="empty-nutrition-state"><span>◌</span><h2>${query ? "No matching foods" : "Your food library is empty"}</h2><p>${query ? "Try another search." : "Use New above to add your first food."}</p></div>`;
    return;
  }
  const meals = state.meals.filter(meal => meal.title.toLowerCase().includes(query)).sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  $("#foodLibraryCount").textContent = `${state.meals.length} meal${state.meals.length === 1 ? "" : "s"}`;
  $("#foodLibraryGrid").innerHTML = meals.length ? meals.map(meal => {
    const totals = mealNutrients(meal); const itemNames = meal.items.map(item => state.foods.find(food => food.id === item.foodId)?.title).filter(Boolean);
    return `<article class="food-card meal-card" data-meal-id="${meal.id}"><div class="food-card-top"><div><span>${meal.items.length} food${meal.items.length === 1 ? "" : "s"}</span><h2>${escapeHtml(meal.title)}</h2></div><button class="menu-button" type="button" data-meal-action="menu" aria-label="Options for ${escapeHtml(meal.title)}">${icon("ellipsis", "…")}</button></div><div class="menu food-menu"><button type="button" data-meal-action="edit">Edit meal</button><button class="danger" type="button" data-meal-action="delete">Delete meal</button></div><p class="meal-food-list">${itemNames.map(escapeHtml).join(" · ")}</p><div class="food-calories"><strong>${roundNutrition(totals.calories, 0)}</strong><span>kcal</span></div><div class="food-macros">${["carbs", "protein", "fats", "fibre"].map(key => `<div><span>${nutrientLabels[key]}</span><strong>${roundNutrition(totals[key])}g</strong></div>`).join("")}</div></article>`;
  }).join("") : `<div class="empty-nutrition-state"><span>◌</span><h2>${query ? "No matching meals" : "No meals yet"}</h2><p>${query ? "Try another search." : state.foods.length ? "Use New above to group foods into a meal." : "Add foods first, then group them into a meal."}</p></div>`;
}

function matchingFoods(query = "") {
  const normalized = query.trim().toLowerCase();
  return state.foods.filter(food => !normalized || food.title.toLowerCase().includes(normalized)).sort((a, b) => {
    const aRecent = state.recentFoodIds.indexOf(a.id); const bRecent = state.recentFoodIds.indexOf(b.id);
    if (!normalized && aRecent !== bRecent) return (aRecent < 0 ? 99 : aRecent) - (bRecent < 0 ? 99 : bRecent);
    return a.title.localeCompare(b.title);
  });
}

function matchingLogItems(query = "") {
  const normalized = query.trim().toLowerCase();
  const items = [
    ...state.foods.map(food => ({ kind: "food", id: food.id, title: food.title, source: food, recent: state.recentFoodIds.indexOf(food.id) })),
    ...state.meals.map(meal => ({ kind: "meal", id: meal.id, title: meal.title, source: meal, recent: state.recentMealIds.indexOf(meal.id) }))
  ].filter(item => !normalized || item.title.toLowerCase().includes(normalized));
  return items.sort((a, b) => {
    if (!normalized && a.recent !== b.recent) return (a.recent < 0 ? 99 : a.recent) - (b.recent < 0 ? 99 : b.recent);
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
}

function renderFoodSearchResults() {
  const results = matchingLogItems($("#foodSearchInput").value).slice(0, 8);
  const panel = $("#foodSearchResults");
  panel.innerHTML = results.map(item => {
    if (item.kind === "food") { const food = item.source; return `<button type="button" role="option" data-quick-food-id="${food.id}"><span><strong>${escapeHtml(food.title)}</strong><small>${escapeHtml(String(food.servingSize))} ${escapeHtml(food.servingUnit)}</small></span><b>${roundNutrition(food.calories, 0)} kcal</b>${icon("plus", "+")}</button>`; }
    const meal = item.source; const totals = mealNutrients(meal); return `<button type="button" role="option" data-quick-meal-id="${meal.id}"><span><strong>${escapeHtml(meal.title)}</strong><small>Meal · ${meal.items.length} food${meal.items.length === 1 ? "" : "s"}</small></span><b>${roundNutrition(totals.calories, 0)} kcal</b>${icon("plus", "+")}</button>`;
  }).join("");
  panel.hidden = !results.length;
}

function addFoodToLog(foodId, focusSearch = true) {
  const food = state.foods.find(item => String(item.id) === String(foodId));
  if (!food) return;
  state.foodLogs[foodLogDay] ||= [];
  state.foodLogs[foodLogDay].push({ id: uid(), foodId: food.id, servingSize: food.servingSize, loggedAt: Date.now(), snapshot: foodSnapshot(food) });
  state.recentFoodIds = [food.id, ...state.recentFoodIds.filter(id => id !== food.id)].slice(0, 6);
  $("#foodSearchInput").value = "";
  $("#foodSearchResults").hidden = true;
  saveState("foodLogs"); renderFoodLog(); renderDailyRings(); toast(`${food.title} added.`);
  if (focusSearch) requestAnimationFrame(() => { $("#foodSearchInput").blur(); $("#foodSearchResults").hidden = true; });
}

function addMealToLog(mealId, focusSearch = true) {
  const meal = state.meals.find(item => String(item.id) === String(mealId)); if (!meal) return;
  state.foodLogs[foodLogDay] ||= [];
  meal.items.forEach(item => {
    const food = state.foods.find(candidate => String(candidate.id) === String(item.foodId)); if (!food) return;
    state.foodLogs[foodLogDay].push({ id: uid(), foodId: food.id, servingSize: item.servingSize, loggedAt: Date.now(), snapshot: foodSnapshot(food), mealId: meal.id, mealTitle: meal.title });
  });
  state.recentMealIds = [meal.id, ...state.recentMealIds.filter(id => id !== meal.id)].slice(0, 6);
  $("#foodSearchInput").value = ""; $("#foodSearchResults").hidden = true;
  saveState("foodLogs"); renderFoodLog(); renderDailyRings(); toast(`${meal.title} added · ${meal.items.length} food${meal.items.length === 1 ? "" : "s"}.`); if (focusSearch) requestAnimationFrame(() => { $("#foodSearchInput").blur(); $("#foodSearchResults").hidden = true; });
}

function renderFoodLog() {
  const bounds = foodLogDateBounds();
  foodLogDay = foodLogDay < bounds.min ? bounds.min : foodLogDay > bounds.max ? bounds.max : foodLogDay;
  $("#foodLogDate").value = foodLogDay;
  $("#foodLogDate").min = bounds.min; $("#foodLogDate").max = bounds.max;
  $("#previousLogDay").disabled = foodLogDay <= bounds.min; $("#nextLogDay").disabled = foodLogDay >= bounds.max;
  const date = dateFromKey(foodLogDay);
  const isToday = foodLogDay === dayKey();
  $("#foodLogDateLabel").textContent = isToday ? "TODAY" : formatCalendarDate(foodLogDay, { weekday: "long", month: "short", day: "numeric" }).toUpperCase();
  const totals = nutritionTotals(foodLogDay);
  $("#nutritionGoalSetupButton").hidden = Boolean(state.nutritionGoal);
  $("#nutritionStatGrid").innerHTML = nutrientKeys.map(key => {
    const goal = state.nutritionGoal?.[key] || 0;
    const percent = goal ? Math.min(100, totals[key] / goal * 100) : 0;
    return `<div style="--nutrient-color:${nutrientColors[key]}"><span>${nutrientLabels[key]}</span><strong>${formatNutrition(totals[key], key)}</strong><small>${goal ? `${formatNutrition(Math.max(0, goal - totals[key]), key)} left` : "No goal set"}</small><i><b style="width:${percent}%"></b></i></div>`;
  }).join("");
  const hasFoods = state.foods.length > 0;
  $("#quickLogEmpty").hidden = hasFoods;
  $(".food-search-wrap").hidden = !hasFoods;
  $("#recentFoods").hidden = !hasFoods;
  const entries = [...(state.foodLogs[foodLogDay] || [])].reverse();
  $("#foodLogSummary").textContent = `${entries.length} item${entries.length === 1 ? "" : "s"}`;
  const displayEntries = [
    ...entries.map(entry => ({ entry, pending: false })),
    ...[...pendingFoodLogDeletions.values()].filter(item => item.date === foodLogDay).map(item => ({ entry: item.entry, pending: true }))
  ].sort((a, b) => (b.entry.loggedAt || 0) - (a.entry.loggedAt || 0));
  const loggedItems = displayEntries.map(({ entry, pending }) => {
    const food = entryFood(entry);
    return food ? { entry, food, values: entryNutrients(entry), pending } : null;
  }).filter(Boolean);
  const tableRows = loggedItems.map(({ entry, food, values, pending }) => pending
    ? `<tr class="food-log-undo-row" data-entry-id="${entry.id}"><td colspan="8"><button type="button" data-log-action="undo">${icon("undo-2", "Undo")}Undo removing <strong>${escapeHtml(food.title)}</strong></button></td></tr>`
    : `<tr data-entry-id="${entry.id}"><th scope="row">${escapeHtml(food.title)}</th><td><span class="table-serving">${roundNutrition(entry.servingSize)} ${escapeHtml(food.servingUnit)}<button type="button" data-log-action="edit" aria-label="Edit serving for ${escapeHtml(food.title)}">${icon("square-pen", "Edit")}</button></span></td><td>${roundNutrition(values.calories, 0)}</td><td>${roundNutrition(values.carbs)}</td><td>${roundNutrition(values.protein)}</td><td>${roundNutrition(values.fats)}</td><td>${roundNutrition(values.fibre)}</td><td><div class="logged-food-actions"><button type="button" data-log-action="delete" aria-label="Remove ${escapeHtml(food.title)}">${icon("trash-2", "Delete")}</button></div></td></tr>`).join("");
  const cardRows = loggedItems.map(({ entry, food, values, pending }) => pending
    ? `<article class="food-log-row food-log-undo-card" data-entry-id="${entry.id}"><button type="button" data-log-action="undo">${icon("undo-2", "Undo")}Undo removing <strong>${escapeHtml(food.title)}</strong></button></article>`
    : `<article class="food-log-row" data-entry-id="${entry.id}"><div class="logged-food-main"><div><h3>${escapeHtml(food.title)}</h3><p>${roundNutrition(entry.servingSize)} ${escapeHtml(food.servingUnit)} · ${formatNutrition(values.calories, "calories")}</p></div></div><div class="logged-macros"><span>C <b>${roundNutrition(values.carbs)}g</b></span><span>P <b>${roundNutrition(values.protein)}g</b></span><span>F <b>${roundNutrition(values.fats)}g</b></span><span>Fi <b>${roundNutrition(values.fibre)}g</b></span></div><div class="logged-food-actions"><button type="button" data-log-action="edit" aria-label="Edit serving for ${escapeHtml(food.title)}">${icon("square-pen", "Edit")}</button><button type="button" data-log-action="delete" aria-label="Remove ${escapeHtml(food.title)}">${icon("trash-2", "Delete")}</button></div></article>`).join("");
  $("#foodLogList").innerHTML = loggedItems.length ? `<div class="food-log-table-wrap"><table class="food-log-table">
    <thead><tr><th>Food</th><th>Serving</th><th>Calories (kcal)</th><th>Carbs (g)</th><th>Protein (g)</th><th>Fats (g)</th><th>Fibre (g)</th><th aria-label="Actions"></th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table></div><div class="food-log-cards">${cardRows}</div>` : `<div class="empty-nutrition-state compact"><span>${icon("plus", "+")}</span><h2>Nothing logged for this day</h2><p>Search above to add a default serving instantly.</p></div>`;
  const recentFoods = state.recentFoodIds.map(id => state.foods.find(food => food.id === id)).filter(Boolean).slice(0, 3);
  const recentMeals = state.recentMealIds.map(id => state.meals.find(meal => meal.id === id)).filter(Boolean).slice(0, 3);
  $("#recentFoods").innerHTML = recentFoods.length || recentMeals.length ? `<span>Recent</span>${recentMeals.map(meal => `<button type="button" data-recent-meal-id="${meal.id}">${icon("plus", "+")}${escapeHtml(meal.title)} <i>meal</i></button>`).join("")}${recentFoods.map(food => `<button type="button" data-recent-food-id="${food.id}">${icon("plus", "+")}${escapeHtml(food.title)}</button>`).join("")}` : "";
}

function stageFoodLogDeletion(entryId) {
  const date = foodLogDay;
  const entries = state.foodLogs[date] || [];
  const index = entries.findIndex(entry => entry.id === entryId);
  if (index < 0) return;
  const [entry] = entries.splice(index, 1);
  const timer = setTimeout(() => {
    pendingFoodLogDeletions.delete(entryId);
    if (foodLogDay === date) renderFoodLog();
  }, 5000);
  pendingFoodLogDeletions.set(entryId, { entry, date, index, timer });
  saveState("foodLogs"); renderFoodLog(); renderDailyRings();
}

function undoFoodLogDeletion(entryId) {
  const pending = pendingFoodLogDeletions.get(entryId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingFoodLogDeletions.delete(entryId);
  state.foodLogs[pending.date] ||= [];
  state.foodLogs[pending.date].splice(Math.min(pending.index, state.foodLogs[pending.date].length), 0, pending.entry);
  saveState("foodLogs"); renderFoodLog(); renderDailyRings(); toast("Food restored.");
}

function openServingDialog(entryId) {
  const entry = (state.foodLogs[foodLogDay] || []).find(item => item.id === entryId);
  const food = entry && entryFood(entry); if (!entry || !food) return;
  $("#editFoodLogId").value = entry.id; $("#loggedServingSize").value = entry.servingSize;
  $("#servingFoodTitle").textContent = food.title; $("#servingDialogHelper").textContent = `Default: ${food.servingSize} ${food.servingUnit}. Nutrition recalculates automatically.`;
  $("#servingFormError").textContent = ""; $("#servingDialog").showModal(); requestAnimationFrame(() => $("#loggedServingSize").select());
}

function saveServing(event) {
  event.preventDefault(); const entry = (state.foodLogs[foodLogDay] || []).find(item => item.id === $("#editFoodLogId").value); const size = Number($("#loggedServingSize").value);
  if (!entry || !Number.isFinite(size) || size <= 0) { $("#servingFormError").textContent = "Enter a positive serving size."; return; }
  entry.servingSize = size; saveState("foodLogs"); $("#servingDialog").close(); renderFoodLog(); renderDailyRings(); toast("Serving updated.");
}

function openNutritionGoalDialog() {
  nutrientKeys.forEach(key => { $(`#goal${key[0].toUpperCase()}${key.slice(1)}`).value = state.nutritionGoal?.[key] ?? ""; });
  $("#nutritionGoalFormError").textContent = ""; $("#nutritionGoalDialog").showModal(); requestAnimationFrame(() => $("#goalCalories").focus());
}

function saveNutritionGoal(event) {
  event.preventDefault(); const goal = Object.fromEntries(nutrientKeys.map(key => [key, Number($(`#goal${key[0].toUpperCase()}${key.slice(1)}`).value)]));
  if (Object.values(goal).some(value => !Number.isFinite(value) || value < 0) || !Object.values(goal).some(value => value > 0)) { $("#nutritionGoalFormError").textContent = "Set at least one positive daily target."; return; }
  state.nutritionGoal = goal; saveState("nutritionGoal"); $("#nutritionGoalDialog").close(); renderFoodLog(); renderDailyRings(); renderWeeklyChart(); toast("Nutrition goal saved.");
  if ($("#settingsView").classList.contains("active")) renderSettings();
}

function toast(message, action = null) {
  if (persistencePending) { queuedPersistenceToast = message; return; }
  const el = $("#toast"); el.replaceChildren(document.createTextNode(message)); el.classList.toggle("has-action", Boolean(action));
  if (action) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = action.label;
    button.addEventListener("click", action.onClick, { once: true }); el.append(button);
  }
  el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), action?.duration || 2600);
}

function showConflictToast() {
  toast("This private area changed elsewhere. Refresh to make sure you have the latest state.", { label: "Refresh", onClick: () => location.reload(), duration: 10000 });
}

const formatLoad = value => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value || 0);
const strengthMuscleKey = name => String(name || "Other").trim().toLocaleLowerCase();

function activeMesocycle() { return state.strength.mesocycles.find(meso => meso.id === state.strength.activeMesocycleId) || null; }
function sessionExerciseSnapshot(templateItem, templateItemIndex = 0) {
  const muscleGroup = String(templateItem.muscleGroup || "Other").trim();
  return {
    id: uid(), exerciseId: templateItem.id, templateItemIndex, name: templateItem.name, muscleGroup, mode: "external",
    allocations: [{ muscleId: strengthMuscleKey(muscleGroup), name: muscleGroup, share: 1 }], unit: "lb",
    sets: Array.from({ length: Math.max(1, Number(templateItem.sets) || 3) }, () => ({ id: uid(), reps: Math.max(0, Number(templateItem.reps) || 8), load: Number(templateItem.load) || 0, completed: false }))
  };
}

function strengthMuscles(meso) {
  const names = new Map();
  const add = name => { const cleanName = String(name || "Other").trim(); if (cleanName) names.set(strengthMuscleKey(cleanName), cleanName); };
  state.strength.workouts.filter(workout => meso.workoutIds.includes(workout.id)).forEach(workout => workout.exercises.forEach(exercise => add(exercise.muscleGroup)));
  meso.sessions.forEach(session => session.exercises.forEach(exercise => (exercise.allocations || []).forEach(allocation => add(allocation.name))));
  return [...names].map(([id, name], index) => ({ id, name, color: palette[index % palette.length] }));
}

function volumeForSessions(meso, sessions, includeIncomplete = false) {
  const totals = Object.fromEntries(strengthMuscles(meso).map(muscle => [muscle.id, 0]));
  sessions.forEach(session => session.exercises.forEach(exercise => exercise.sets.forEach(set => {
    if (!includeIncomplete && !set.completed) return;
    const base = Math.max(0, Number(set.reps) || 0) * Math.max(0, Number(set.load) || 0);
    (exercise.allocations || []).forEach(allocation => { const key = strengthMuscleKey(allocation.name || allocation.muscleId); totals[key] = (totals[key] || 0) + base * (Number(allocation.share) || 0); });
  })));
  return totals;
}

function volumeForWeek(meso, weekIndex, excludedSessionId = null) {
  return volumeForSessions(meso, meso.sessions.filter(session => session.weekIndex === weekIndex && session.id !== excludedSessionId));
}

function previousLoadingWeek(meso, weekIndex) { return weekIndex - 1; }

function renderStrengthWorkouts() {
  const meso = activeMesocycle();
  const workouts = state.strength.workouts.filter(workout => meso?.workoutIds.includes(workout.id));
  return `<div class="section-heading strength-workout-heading"><div><h2>Workouts</h2></div></div>
    <div class="strength-template-grid">${workouts.length ? workouts.map(workout => `<article class="strength-template-card" data-template-id="${workout.id}"><div><h3>${escapeHtml(workout.name)}</h3><p>${workout.exercises.length} exercise${workout.exercises.length === 1 ? "" : "s"}</p></div><div><button class="primary-button" type="button" data-strength-action="start-workout">Start</button></div></article>`).join("") : `<button class="strength-add-template" type="button" data-strength-action="open-workout-library">No workouts in this mesocycle · Open library</button>`}</div>`;
}

function renderWorkoutLibrary() {
  const query = $("#workoutLibrarySearch").value.trim().toLocaleLowerCase();
  const workouts = state.strength.workouts.filter(workout => workout.name.toLocaleLowerCase().includes(query) || workout.exercises.some(exercise => exercise.name.toLocaleLowerCase().includes(query))).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  $("#workoutLibraryCount").textContent = `${state.strength.workouts.length} workout${state.strength.workouts.length === 1 ? "" : "s"}`;
  $("#workoutLibraryGrid").innerHTML = workouts.length ? workouts.map(workout => `<article class="food-card workout-library-card" data-workout-id="${workout.id}">
    <div class="food-card-top"><div><span>${workout.exercises.length} exercise${workout.exercises.length === 1 ? "" : "s"}</span><h2>${escapeHtml(workout.name)}</h2></div><button class="menu-button" type="button" data-workout-action="menu" aria-label="Options for ${escapeHtml(workout.name)}">${icon("ellipsis", "…")}</button></div>
    <div class="menu food-menu"><button type="button" data-workout-action="edit">Edit workout</button><button class="danger" type="button" data-workout-action="delete">Delete workout</button></div>
    <div class="workout-exercise-list">${workout.exercises.map(exercise => `<div><span>${escapeHtml(exercise.name)}</span><small>${escapeHtml(exercise.muscleGroup)} · ${exercise.sets} × ${formatLoad(exercise.reps)} · ${formatLoad(exercise.load)} lb</small></div>`).join("")}</div>
  </article>`).join("") : `<div class="empty-nutrition-state"><span>${icon("arrow-up-right", "↗")}</span><h2>${query ? "No matching workouts" : "Your workout library is empty"}</h2><p>${query ? "Try another search." : "Use New above to create your first reusable workout."}</p></div>`;
}

function renderStrength() {
  const root = $("#strengthContent"); const meso = activeMesocycle();
  $("#strengthTemplateButton").disabled = false;
  $("#editMesocycleButton").hidden = !meso;
  $("#newMesocycleButton").hidden = Boolean(meso && !meso.weeks.every(week => week.completed));
  if (!meso) {
    root.innerHTML = `<div class="strength-empty"><span>${icon("arrow-up-right", "↗")}</span><h2>Build your first mesocycle</h2><p>Use New block above to choose workouts and create your first training block.</p></div>`;
    return;
  }
  if (!Number.isInteger(strengthWeek)) {
    const lastCompletedWeek = meso.weeks.reduce((latest, week, index) => week.completed ? index : latest, -1);
    strengthWeek = Math.min(lastCompletedWeek + 1, meso.weeks.length - 1);
  }
  strengthWeek = Math.max(0, Math.min(strengthWeek, meso.weeks.length - 1));
  const totals = volumeForWeek(meso, strengthWeek); const previousIndex = previousLoadingWeek(meso, strengthWeek); const previous = previousIndex >= 0 ? volumeForWeek(meso, previousIndex) : null; const deload = meso.weeks[strengthWeek].deload;
  const visibleMuscles = strengthMuscles(meso); const weekSessions = meso.sessions.filter(session => session.weekIndex === strengthWeek);
  root.innerHTML = `
    <div class="strength-week-tabs">${meso.weeks.map((week, index) => `<button type="button" data-strength-week="${index}" aria-current="${index === strengthWeek ? "step" : "false"}"><span>W${index + 1}</span><small>${week.completed ? "Completed" : week.deload ? "Deload" : "Load"}</small></button>`).join("")}</div>
    <section class="volume-panel"><div class="volume-panel-heading"><div><p class="eyebrow">WEEKLY VOLUME</p><h2>Muscle progress</h2></div><p>${deload ? "Deload totals are informational and do not set the next target." : previous ? `Targets are based on week ${previousIndex + 1}.` : "This week establishes your baseline."}</p></div><div class="volume-grid">${visibleMuscles.map(muscle => {
      const currentLoad = totals[muscle.id] || 0; const rate = Number(meso.progressionRate); const targetLoad = previous ? (previous[muscle.id] || 0) * (1 + rate) : 0;
      const percent = targetLoad ? currentLoad / targetLoad * 100 : 0; const delta = previous && previous[muscle.id] ? (currentLoad / previous[muscle.id] - 1) * 100 : null;
      const status = deload ? "Deload" : !previous ? "" : !(previous[muscle.id] > 0) ? "No baseline" : percent >= 100 ? "Target reached" : percent >= 85 ? "Close" : "Below target";
      return `<article class="volume-card" style="--muscle-color:${muscle.color}"><div><span>${escapeHtml(muscle.name)}</span>${status ? `<b class="volume-status ${percent >= 100 && !deload ? "done" : ""}">${status}</b>` : ""}</div><strong>${formatLoad(currentLoad)}<small> lb</small></strong><p>${targetLoad ? `${formatLoad(Math.max(0, targetLoad - currentLoad))} lb remaining · ${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`}` : ""}</p><i><b style="width:${Math.min(100, percent)}%"></b></i></article>`;
    }).join("")}</div></section>
    ${renderStrengthWorkouts()}
    <section class="strength-history"><div class="strength-history-heading"><h2>Week ${strengthWeek + 1} sessions</h2>${weekSessions.length ? `<button class="secondary-button" type="button" data-strength-action="complete-week" ${meso.weeks[strengthWeek].completed ? "disabled" : ""}>${meso.weeks[strengthWeek].completed ? "Completed" : "Complete week"}</button>` : ""}</div>${weekSessions.length ? weekSessions.map(session => `<div class="strength-session-row" data-session-id="${session.id}"><button class="strength-session-open" type="button" data-strength-action="open-session"><span><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.date)} · ${session.status === "completed" ? "Completed" : "In progress"}</small></span><b>${session.exercises.reduce((sum, exercise) => sum + exercise.sets.filter(set => set.completed).length, 0)} sets ${icon("arrow-right", "→")}</b></button><button class="strength-session-delete" type="button" data-strength-action="delete-session" aria-label="Delete ${escapeHtml(session.name)} session">${icon("trash-2", "Delete")}</button></div>`).join("") : `<p>No workouts logged in this week yet.</p>`}</section>`;
  requestAnimationFrame(() => {
    const tabs = $(".strength-week-tabs", root);
    const activeTab = $('[aria-current="step"]', tabs);
    if (tabs && activeTab) tabs.scrollTo({ left: activeTab.offsetLeft - (tabs.clientWidth - activeTab.offsetWidth) / 2, behavior: "auto" });
  });
}

function workoutCountdownKey(session) {
  return String(session.createdAt || session.id);
}

function preferredWorkoutCountdownMs() {
  try {
    const preference = JSON.parse(localStorage.getItem(WORKOUT_COUNTDOWN_PREFERENCE_KEY) || "null");
    const minutes = Math.max(0, Math.min(999, Math.floor(Number(preference?.minutes) || 0)));
    const seconds = Math.max(0, Math.min(59, Math.floor(Number(preference?.seconds) || 0)));
    const durationMs = (minutes * 60 + seconds) * 1000;
    return durationMs > 0 ? durationMs : 90_000;
  } catch (_) {
    return 90_000;
  }
}

function saveWorkoutCountdownPreference(durationMs) {
  if (!(durationMs > 0)) return;
  const durationSeconds = Math.round(durationMs / 1000);
  try {
    localStorage.setItem(WORKOUT_COUNTDOWN_PREFERENCE_KEY, JSON.stringify({ minutes: Math.floor(durationSeconds / 60), seconds: durationSeconds % 60 }));
  } catch (_) {}
}

function workoutCountdownFor(session) {
  const key = workoutCountdownKey(session);
  if (!workoutCountdowns.has(key)) {
    const durationMs = preferredWorkoutCountdownMs();
    workoutCountdowns.set(key, { durationMs, remainingMs: durationMs, endAt: null, running: false, notified: false });
  }
  return workoutCountdowns.get(key);
}

function syncWorkoutCountdown(countdown, now = Date.now()) {
  if (!countdown.running) return;
  countdown.remainingMs = Math.max(0, countdown.endAt - now);
  if (countdown.remainingMs > 0) return;
  countdown.running = false;
  countdown.endAt = null;
  if (!countdown.notified) {
    countdown.notified = true;
    beep();
    toast("Rest timer complete.");
  }
}

function workoutCountdownStatus(countdown) {
  if (countdown.running) return "Running";
  if (countdown.remainingMs <= 0) return "Complete";
  if (countdown.remainingMs < countdown.durationMs) return "Paused";
  return "Ready";
}

function renderWorkoutCountdown(session) {
  const countdown = workoutCountdownFor(session);
  syncWorkoutCountdown(countdown);
  const durationSeconds = Math.round(countdown.durationMs / 1000);
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  const remainingSeconds = Math.ceil(countdown.remainingMs / 1000);
  const progress = countdown.durationMs ? countdown.remainingMs / countdown.durationMs * 100 : 0;
  const status = workoutCountdownStatus(countdown);
  return `<section class="workout-countdown" id="workoutCountdown" data-session-key="${workoutCountdownKey(session)}" data-state="${status.toLowerCase()}" style="--workout-timer-progress:${progress}%" aria-labelledby="workoutTimerTitle">
    <div class="workout-countdown-readout"><h2 id="workoutTimerTitle">Workout timer</h2><strong id="workoutTimerDisplay" role="timer" aria-atomic="true">${formatClock(remainingSeconds)}</strong></div>
    <div class="workout-countdown-config" aria-label="Timer duration"><label><span>Minutes</span><input data-workout-timer-field="minutes" type="number" inputmode="numeric" min="0" max="999" step="1" value="${minutes}" ${countdown.running ? "disabled" : ""}></label><span aria-hidden="true">:</span><label><span>Seconds</span><input data-workout-timer-field="seconds" type="number" inputmode="numeric" min="0" max="59" step="1" value="${seconds}" ${countdown.running ? "disabled" : ""}></label></div>
    <div class="workout-countdown-actions"><button class="primary-button" type="button" data-workout-timer-action="toggle" data-timer-mode="${countdown.running ? "pause" : "start"}">${countdown.running ? `${icon("pause", "Ⅱ")}Pause` : `${icon("play", "▶")}Start`}</button><button class="secondary-button" type="button" data-workout-timer-action="restart" aria-label="Restart timer" title="Restart timer">${icon("rotate-ccw", "↻")}</button></div>
    <span class="workout-countdown-status" id="workoutTimerStatus" aria-live="polite">${status}</span>
  </section>`;
}

function configuredWorkoutCountdownMs(panel) {
  const minutesField = $('[data-workout-timer-field="minutes"]', panel);
  const secondsField = $('[data-workout-timer-field="seconds"]', panel);
  const minutes = Math.max(0, Math.min(999, Math.floor(Number(minutesField?.value) || 0)));
  const seconds = Math.max(0, Math.min(59, Math.floor(Number(secondsField?.value) || 0)));
  return (minutes * 60 + seconds) * 1000;
}

function updateWorkoutCountdownUI(session) {
  const panel = $("#workoutCountdown");
  if (!panel || panel.dataset.sessionKey !== workoutCountdownKey(session)) return;
  const countdown = workoutCountdownFor(session);
  const remainingSeconds = Math.ceil(countdown.remainingMs / 1000);
  const progress = countdown.durationMs ? Math.max(0, Math.min(100, countdown.remainingMs / countdown.durationMs * 100)) : 0;
  const status = workoutCountdownStatus(countdown);
  panel.style.setProperty("--workout-timer-progress", `${progress}%`);
  panel.dataset.state = status.toLowerCase();
  $("#workoutTimerDisplay", panel).textContent = formatClock(remainingSeconds);
  const statusElement = $("#workoutTimerStatus", panel);
  if (statusElement.textContent !== status) statusElement.textContent = status;
  const toggle = $('[data-workout-timer-action="toggle"]', panel);
  const mode = countdown.running ? "pause" : "start";
  if (toggle.dataset.timerMode !== mode) {
    toggle.dataset.timerMode = mode;
    toggle.innerHTML = countdown.running ? `${icon("pause", "Ⅱ")}Pause` : `${icon("play", "▶")}Start`;
  }
  $$('[data-workout-timer-field]', panel).forEach(field => { field.disabled = countdown.running; });
}

function handleWorkoutCountdownAction(action, panel) {
  const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId);
  if (!session || panel.dataset.sessionKey !== workoutCountdownKey(session)) return;
  const countdown = workoutCountdownFor(session);
  syncWorkoutCountdown(countdown);
  const configuredMs = configuredWorkoutCountdownMs(panel);
  if (action === "toggle" && countdown.running) {
    countdown.running = false;
    countdown.endAt = null;
  } else if (configuredMs > 0) {
    saveWorkoutCountdownPreference(configuredMs);
    primeAudio();
    if (action === "restart" || countdown.remainingMs <= 0 || configuredMs !== countdown.durationMs) {
      countdown.durationMs = configuredMs;
      countdown.remainingMs = configuredMs;
    }
    countdown.notified = false;
    countdown.running = true;
    countdown.endAt = Date.now() + countdown.remainingMs;
  } else {
    toast("Enter a timer duration greater than zero.");
  }
  updateWorkoutCountdownUI(session);
}

function workoutVolumeProjectionMarkup(meso, session) {
  const sessionTotals = volumeForSessions(meso, [session], true);
  const otherWeekTotals = volumeForWeek(meso, session.weekIndex, session.id);
  const previousIndex = previousLoadingWeek(meso, session.weekIndex);
  const previousTotals = previousIndex >= 0 ? volumeForWeek(meso, previousIndex) : null;
  const muscleNames = new Map();
  session.exercises.forEach(exercise => (exercise.allocations || []).forEach(allocation => {
    const name = String(allocation.name || allocation.muscleId || exercise.muscleGroup || "Other").trim();
    muscleNames.set(strengthMuscleKey(name), name);
  }));
  const mesoMuscles = new Map(strengthMuscles(meso).map(muscle => [muscle.id, muscle]));
  const cards = [...muscleNames].map(([id, name], index) => {
    const sessionVolume = sessionTotals[id] || 0;
    const projectedWeek = (otherWeekTotals[id] || 0) + sessionVolume;
    const target = previousTotals ? (previousTotals[id] || 0) * (1 + Math.max(0, Number(meso.progressionRate) || 0)) : 0;
    const ratio = target > 0 ? projectedWeek / target * 100 : null;
    const color = mesoMuscles.get(id)?.color || palette[index % palette.length];
    const comparison = ratio === null ? `${formatLoad(projectedWeek)} lb projected this week · ${previousTotals ? "no prior volume" : "baseline week"}` : `${formatLoad(projectedWeek)} / ${formatLoad(target)} lb weekly target · ${Math.round(ratio)}%`;
    return `<article class="workout-volume-card" style="--muscle-color:${color}"><div><span>${escapeHtml(name)}</span><b>${ratio === null ? "Baseline" : `${Math.round(ratio)}%`}</b></div><strong>${formatLoad(sessionVolume)}<small> lb</small></strong><p>${comparison}</p><i><b style="width:${Math.min(100, ratio || 0)}%"></b></i></article>`;
  }).join("");
  return `<section class="workout-volume-projection" id="workoutVolumeProjection" aria-labelledby="workoutVolumeProjectionTitle"><div class="workout-volume-heading"><h2 id="workoutVolumeProjectionTitle">Projected volume</h2></div><div class="workout-volume-grid">${cards}</div></section>`;
}

function updateWorkoutVolumeProjection() {
  const meso = activeMesocycle(); const session = meso?.sessions.find(item => item.id === activeStrengthSessionId); const current = $("#workoutVolumeProjection");
  if (meso && session && current) current.outerHTML = workoutVolumeProjectionMarkup(meso, session);
}

function renderStrengthLogger() {
  const meso = activeMesocycle(); const session = meso?.sessions.find(item => item.id === activeStrengthSessionId);
  if (!session) { activeStrengthSessionId = null; showView("strengthView"); return; }
  $("#workoutSessionHeading").textContent = session.name; $("#workoutSessionBreadcrumb").textContent = session.name;
  $("#workoutSessionMeta").textContent = `Week ${session.weekIndex + 1}${session.status === "completed" ? " · Completed workout" : ""}`;
  $("#workoutSessionDate").value = session.date || dayKey();
  $("#workoutSessionDate").max = dayKey();
  $("#finishWorkoutButton").textContent = session.status === "completed" ? "Save changes" : "Finish workout";
  $("#workoutSessionContent").innerHTML = `<section class="strength-logger">${renderWorkoutCountdown(session)}${workoutVolumeProjectionMarkup(meso, session)}<div class="logger-exercises">${session.exercises.map(exercise => `<article class="logger-exercise" data-session-exercise-id="${exercise.id}"><div class="logger-exercise-heading"><div><h2>${escapeHtml(exercise.name)}</h2><p>${escapeHtml(exercise.muscleGroup || exercise.allocations[0]?.name || "Other")}</p></div><button type="button" data-strength-action="add-set">${icon("plus", "+")}Add set</button></div><div class="set-table"><div class="set-table-head"><span>Set</span><span>Load (lb)</span><span>Reps</span><span>Done</span><span></span></div>${exercise.sets.length ? exercise.sets.map((set, index) => `<div class="set-row ${set.completed ? "completed" : ""}" data-set-id="${set.id}"><strong aria-label="Set ${index + 1}">${index + 1}</strong><label class="set-field"><span>Load (lb)</span><input data-set-field="load" type="number" inputmode="decimal" min="0" step="0.1" value="${set.load}" aria-label="Set ${index + 1} load in pounds" /></label><label class="set-field"><span>Reps</span><input data-set-field="reps" type="number" inputmode="numeric" min="0" step="1" value="${set.reps}" aria-label="Set ${index + 1} reps" /></label><label class="set-check done-check" aria-label="Mark set ${index + 1} complete"><input data-set-field="completed" type="checkbox" ${set.completed ? "checked" : ""} /><span>${icon("check", "✓")}</span></label><button type="button" data-strength-action="remove-set" aria-label="Remove set ${index + 1}">${icon("trash-2", "Delete")}</button></div>`).join("") : `<div class="set-table-empty">No sets. Use <strong>Add set</strong> to add one.</div>`}</div></article>`).join("")}</div></section>`;
}

function openMesocycleDialog(meso = null) {
  $("#editMesocycleId").value = meso?.id || "";
  $("#mesocycleDialogTitle").textContent = meso ? "Edit mesocycle" : "Set up a mesocycle";
  $("#mesocycleSubmitButton").textContent = meso ? "Save" : "Create mesocycle";
  $("#mesocycleRestartButton").hidden = !meso;
  $("#mesocycleName").value = meso?.name || "Strength block";
  $("#mesocycleWeeks").value = meso?.weeks.length || 5;
  $("#mesocycleRate").value = Math.round((meso?.progressionRate ?? .025) * 1000) / 10;
  $("#mesocycleDeload").checked = meso ? meso.weeks.at(-1)?.deload === true : true;
  $("#mesocycleWorkoutOptions").innerHTML = state.strength.workouts.length ? state.strength.workouts.map(workout => `<label><input type="checkbox" name="mesocycleWorkout" value="${workout.id}" ${meso?.workoutIds.includes(workout.id) ? "checked" : ""} /><span><strong>${escapeHtml(workout.name)}</strong><small>${workout.exercises.length} exercise${workout.exercises.length === 1 ? "" : "s"}</small></span></label>`).join("") : `<p>No workouts yet. Create one in the Workout Library first.</p>`;
  $("#mesocycleFormError").textContent = ""; $("#mesocycleDialog").showModal();
}

function saveMesocycle(event) {
  event.preventDefault(); const weeks = Number($("#mesocycleWeeks").value); const rate = Number($("#mesocycleRate").value) / 100; const workoutIds = $$('input[name="mesocycleWorkout"]:checked').map(input => input.value); const editing = state.strength.mesocycles.find(meso => meso.id === $("#editMesocycleId").value); const restart = editing && event.submitter?.value === "restart";
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 16 || !Number.isFinite(rate) || rate < 0) { $("#mesocycleFormError").textContent = "Enter 2–16 weeks and a valid weekly increase."; return; }
  if (!workoutIds.length) { $("#mesocycleFormError").textContent = state.strength.workouts.length ? "Select at least one workout for this mesocycle." : "Create a workout before setting up a mesocycle."; return; }
  if (editing && !restart) {
    const lastUsedWeek = Math.max(-1, ...editing.sessions.map(session => session.weekIndex), ...editing.weeks.map((week, index) => week.completed ? index : -1));
    if (weeks <= lastUsedWeek) { $("#mesocycleFormError").textContent = `This block needs at least ${lastUsedWeek + 1} weeks to keep its existing history.`; return; }
    editing.name = $("#mesocycleName").value.trim(); editing.progressionRate = rate; editing.workoutIds = workoutIds;
    editing.weeks = Array.from({ length: weeks }, (_, index) => ({ ...(editing.weeks[index] || { completed: false }), deload: $("#mesocycleDeload").checked && index === weeks - 1 }));
    strengthWeek = Math.min(strengthWeek, weeks - 1); saveState("strength"); $("#mesocycleDialog").close(); renderStrength(); toast("Mesocycle updated."); return;
  }
  if (state.strength.mesocycles.some(meso => meso.sessions.some(session => session.status === "in-progress"))) { $("#mesocycleFormError").textContent = `Finish your in-progress workout before ${restart ? "restarting this block" : "creating a new mesocycle"}.`; return; }
  const previous = editing || activeMesocycle(); if (previous) previous.archived = true;
  const meso = { id: uid(), name: $("#mesocycleName").value.trim(), progressionRate: rate, workoutIds, weeks: Array.from({ length: weeks }, (_, index) => ({ deload: $("#mesocycleDeload").checked && index === weeks - 1, completed: false })), sessions: [], archived: false };
  state.strength.mesocycles.push(meso); state.strength.activeMesocycleId = meso.id; strengthWeek = 0; saveState("strength"); $("#mesocycleDialog").close(); renderStrength(); toast(restart ? "Mesocycle saved and restarted." : "Mesocycle created.");
}

function addTemplateExerciseRow(item = null) {
  const row = document.createElement("div"); row.className = "strength-template-row"; row.dataset.exerciseId = item?.id || uid();
  row.innerHTML = `<span class="strength-template-drag-handle" data-template-drag-handle role="button" tabindex="0" aria-label="Reorder ${escapeHtml(item?.name || "exercise")}" title="Drag to reorder">${icon("grip-vertical", "⋮")}</span><label class="template-exercise-field template-exercise-name"><span>Exercise</span><input data-template-exercise type="text" maxlength="60" required placeholder="e.g. Bench press" value="${escapeHtml(item?.name || "")}" /></label><label class="template-exercise-field template-exercise-muscle"><span>Muscle group</span><input data-template-muscle type="text" maxlength="40" required placeholder="e.g. Chest" value="${escapeHtml(item?.muscleGroup || "")}" /></label><label class="template-exercise-field template-exercise-sets"><span>Sets</span><input data-template-sets type="number" inputmode="numeric" min="1" max="20" value="${item?.sets || 3}" /></label><label class="template-exercise-field template-exercise-reps"><span>Reps</span><input data-template-reps type="number" inputmode="numeric" min="0" max="999" value="${item?.reps ?? 8}" /></label><label class="template-exercise-field template-exercise-load"><span>Load (lb)</span><input data-template-load type="number" inputmode="decimal" min="0" step="0.1" value="${item?.load || 0}" /></label><button type="button" data-remove-template-exercise aria-label="Remove exercise">${icon("trash-2", "Delete")}</button>`; $("#strengthTemplateRows").append(row);
  return row;
}

function clearPendingTemplateExerciseDeletions() {
  pendingTemplateExerciseDeletions.forEach(item => clearTimeout(item.timer));
  pendingTemplateExerciseDeletions.clear();
}

function stageTemplateExerciseDeletion(row) {
  const id = row.dataset.exerciseId;
  if (!id || pendingTemplateExerciseDeletions.has(id)) return;
  row.hidden = true;
  const placeholder = document.createElement("div");
  placeholder.className = "strength-template-undo-row";
  placeholder.dataset.exerciseId = id;
  const name = $("[data-template-exercise]", row).value.trim() || "exercise";
  placeholder.innerHTML = `<button type="button" data-undo-template-exercise>${icon("undo-2", "Undo")}Undo removing <strong>${escapeHtml(name)}</strong></button>`;
  row.after(placeholder);
  const timer = setTimeout(() => {
    row.remove(); placeholder.remove(); pendingTemplateExerciseDeletions.delete(id);
  }, 5000);
  pendingTemplateExerciseDeletions.set(id, { row, placeholder, timer });
}

function undoTemplateExerciseDeletion(id) {
  const pending = pendingTemplateExerciseDeletions.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.placeholder.remove();
  pending.row.hidden = false;
  pendingTemplateExerciseDeletions.delete(id);
  requestAnimationFrame(() => $("[data-remove-template-exercise]", pending.row)?.focus());
}

function openStrengthTemplateDialog(template = null) {
  clearPendingTemplateExerciseDeletions(); $("#strengthTemplateForm").reset(); $("#editStrengthTemplateId").value = template?.id || ""; $("#strengthTemplateDialogTitle").textContent = template ? "Edit workout" : "Add a workout"; $("#strengthTemplateName").value = template?.name || ""; $("#strengthTemplateRows").innerHTML = ""; (template?.exercises || [null]).forEach(addTemplateExerciseRow); $("#strengthTemplateFormError").textContent = ""; $("#strengthTemplateDialog").showModal();
}
function saveStrengthTemplate(event) {
  event.preventDefault(); const items = $$(".strength-template-row:not([hidden])", $("#strengthTemplateRows")).map(row => ({ id: row.dataset.exerciseId || uid(), name: $("[data-template-exercise]", row).value.trim(), muscleGroup: $("[data-template-muscle]", row).value.trim(), sets: Number($("[data-template-sets]", row).value), reps: Number($("[data-template-reps]", row).value), load: Number($("[data-template-load]", row).value) }));
  if (!$("#strengthTemplateName").value.trim() || !items.length || items.some(item => !item.name || !item.muscleGroup || !Number.isInteger(item.sets) || item.sets < 1 || item.reps < 0 || item.load < 0)) { $("#strengthTemplateFormError").textContent = "Give the workout a name and complete every exercise field."; return; }
  const existing = state.strength.workouts.find(workout => workout.id === $("#editStrengthTemplateId").value); const values = { name: $("#strengthTemplateName").value.trim(), exercises: items };
  if (existing) Object.assign(existing, values); else state.strength.workouts.push({ id: uid(), ...values }); clearPendingTemplateExerciseDeletions(); saveState("strength"); $("#strengthTemplateDialog").close(); renderStrength(); renderWorkoutLibrary(); toast(existing ? "Workout updated." : "Workout added.");
}

function deleteStrengthWorkout(id) {
  const workout = state.strength.workouts.find(item => item.id === id);
  if (!workout) return;
  openDeleteConfirmation(`Delete “${workout.name}”?`, "The workout will be removed from your library. Past logged sessions will be kept.", () => {
    state.strength.workouts = state.strength.workouts.filter(item => item.id !== id);
    state.strength.mesocycles.forEach(meso => { meso.workoutIds = meso.workoutIds.filter(workoutId => workoutId !== id); });
    saveState("strength"); renderStrength(); renderWorkoutLibrary(); toast("Workout deleted.");
  });
}

function deleteStrengthSession(id) {
  const meso = activeMesocycle();
  const session = meso?.sessions.find(item => item.id === id);
  if (!meso || !session) return;
  openDeleteConfirmation(`Delete “${session.name}”?`, "This workout session and its logged sets will be permanently removed.", () => {
    meso.sessions = meso.sessions.filter(item => item.id !== id);
    if (!meso.sessions.some(item => item.weekIndex === session.weekIndex)) meso.weeks[session.weekIndex].completed = false;
    if (activeStrengthSessionId === id) activeStrengthSessionId = null;
    saveState("strength"); renderStrength(); toast("Workout session deleted.");
  });
}

function startStrengthWorkout(templateId) {
  const meso = activeMesocycle(); const template = state.strength.workouts.find(item => item.id === templateId); if (!meso || !template) return;
  const pending = state.strength.mesocycles.flatMap(block => block.sessions.map(session => ({ block, session }))).find(item => item.session.status === "in-progress");
  if (pending) {
    if (pending.block.id !== meso.id || pending.session.templateId !== template.id) { toast(`“${pending.session.name}” is already in progress. Finish it before starting “${template.name}”.`); return; }
    activeStrengthSessionId = pending.session.id; showView("workoutSessionView"); return;
  }
  const previousSessions = state.strength.mesocycles.flatMap(block => block.sessions).filter(session => session.templateId === template.id && session.status === "completed").sort((a, b) => b.createdAt - a.createdAt);
  const exercises = template.exercises.map((item, index) => {
    const snapshot = sessionExerciseSnapshot(item, index);
    const priorExercise = previousSessions.map(session => session.exercises.find(exercise => exercise.exerciseId === item.id || exercise.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase())).find(Boolean);
    if (priorExercise?.sets?.length) snapshot.sets = priorExercise.sets.map(set => ({ ...set, id: uid(), completed: false }));
    return snapshot;
  });
  const session = { id: uid(), templateId: template.id, name: template.name, weekIndex: strengthWeek, date: dayKey(), createdAt: Date.now(), status: "in-progress", unit: "lb", exercises };
  meso.sessions.push(session); activeStrengthSessionId = session.id; saveState("strength"); showView("workoutSessionView");
}

function closeStrengthWorkout() { activeStrengthSessionId = null; showView("strengthView"); }
function finishStrengthWorkout() {
  const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId); if (!session) return;
  session.status = "completed"; saveState("strength"); activeStrengthSessionId = null; showView("strengthView"); toast("Workout saved.");
}

function completeStrengthWeek() {
  const meso = activeMesocycle(); const week = meso?.weeks[strengthWeek]; if (!meso || !week || week.completed) return;
  if (meso.sessions.some(session => session.weekIndex === strengthWeek && session.status === "in-progress")) { toast("Finish the in-progress workout before completing this week."); return; }
  const completedWeek = strengthWeek; week.completed = true; strengthWeek = Math.min(strengthWeek + 1, meso.weeks.length - 1); saveState("strength"); renderStrength(); toast(`Week ${completedWeek + 1} completed.`);
}

$("#timerGrid").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const card = button.closest(".timer-card"); const id = card.dataset.id; const action = button.dataset.action;
  if (action === "menu") { const menu = $(".menu", card); $$(".menu.open").filter(m => m !== menu).forEach(m => m.classList.remove("open")); menu.classList.toggle("open"); }
  else $(".menu", card).classList.remove("open");
  if (action === "toggle") toggleTimer(id);
  if (action === "reset") resetTimer(id);
  if (action === "edit") openDialog(state.timers.find(t => t.id === id));
  if (action === "delete") deleteTimer(id);
});

$("#habitGrid").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const card = button.closest(".habit-card"); const id = card.dataset.id; const action = button.dataset.action;
  if (action === "widget-menu") { const menu = $(".menu", card); $$(".menu.open").filter(item => item !== menu).forEach(item => item.classList.remove("open")); menu.classList.toggle("open"); }
  if (action === "increment") changeWidgetValue(id, 1);
  if (action === "decrement") changeWidgetValue(id, -1);
  if (action === "toggle-widget") changeWidgetValue(id, 1);
  if (action === "edit-widget") openWidgetDialog(state.widgets.find(widget => widget.id === id));
  if (action === "delete-widget") deleteWidget(id);
});

$("#weeklyChart").addEventListener("click", event => {
  const day = event.target.closest("button[data-date]");
  if (!day || day.disabled || day.dataset.date > dayKey()) return;
  visibleDay = day.dataset.date;
  renderTimers();
});

$("#habitGrid").addEventListener("pointerdown", event => {
  const handle = event.target.closest(".drag-handle");
  if (handle) handle.closest(".habit-card").draggable = true;
});

$("#habitGrid").addEventListener("pointerup", event => {
  if (!draggedWidgetId) event.target.closest(".habit-card")?.setAttribute("draggable", "false");
});

$("#habitGrid").addEventListener("keydown", event => {
  const handle = event.target.closest(".drag-handle");
  if (!handle || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const id = handle.closest(".habit-card").dataset.id;
  const currentIndex = state.widgets.findIndex(widget => widget.id === id);
  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  const nextIndex = Math.max(0, Math.min(state.widgets.length - 1, currentIndex + direction));
  if (currentIndex === nextIndex) return;
  const [widget] = state.widgets.splice(currentIndex, 1);
  state.widgets.splice(nextIndex, 0, widget);
  saveState("habits");
  renderTimers();
  requestAnimationFrame(() => $(`#habitGrid [data-id="${id}"] .drag-handle`)?.focus());
});

$("#habitGrid").addEventListener("dragstart", event => {
  const card = event.target.closest(".habit-card");
  if (!card || !card.draggable) { event.preventDefault(); return; }
  draggedWidgetId = card.dataset.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedWidgetId);
  requestAnimationFrame(() => card.classList.add("dragging"));
});

$("#habitGrid").addEventListener("dragover", event => {
  if (!draggedWidgetId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const grid = $("#habitGrid");
  const dragged = grid.querySelector(`[data-id="${draggedWidgetId}"]`);
  const target = event.target.closest(".habit-card");
  if (!dragged || target === dragged) return;
  if (target) {
    const cards = [...grid.querySelectorAll(".habit-card")];
    if (cards.indexOf(dragged) < cards.indexOf(target)) target.after(dragged);
    else target.before(dragged);
  } else {
    const lastCard = grid.querySelector(".habit-card:last-child");
    if (lastCard && event.clientY > lastCard.getBoundingClientRect().bottom) grid.append(dragged);
  }
});

$("#habitGrid").addEventListener("drop", event => event.preventDefault());

$("#habitGrid").addEventListener("dragend", event => {
  const grid = $("#habitGrid");
  const card = event.target.closest(".habit-card");
  if (card) { card.classList.remove("dragging"); card.draggable = false; }
  const widgetsById = new Map(state.widgets.map(widget => [widget.id, widget]));
  state.widgets = [...grid.querySelectorAll(".habit-card")].map(item => widgetsById.get(item.dataset.id)).filter(Boolean);
  draggedWidgetId = null;
  saveState("habits");
  renderTimers();
});

$("#timerGrid").addEventListener("pointerdown", event => {
  const handle = event.target.closest(".drag-handle");
  if (handle) handle.closest(".timer-card").draggable = true;
});

$("#timerGrid").addEventListener("pointerup", event => {
  if (!draggedTimerId) event.target.closest(".timer-card")?.setAttribute("draggable", "false");
});

$("#timerGrid").addEventListener("keydown", event => {
  const handle = event.target.closest(".drag-handle");
  if (!handle || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const id = handle.closest(".timer-card").dataset.id;
  const currentIndex = state.timers.findIndex(timer => timer.id === id);
  const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  const nextIndex = Math.max(0, Math.min(state.timers.length - 1, currentIndex + direction));
  if (currentIndex === nextIndex) return;
  const [timer] = state.timers.splice(currentIndex, 1);
  state.timers.splice(nextIndex, 0, timer);
  saveState("timers");
  renderTimers();
  requestAnimationFrame(() => $(`[data-id="${id}"] .drag-handle`)?.focus());
});

$("#timerGrid").addEventListener("dragstart", event => {
  const card = event.target.closest(".timer-card");
  if (!card || !card.draggable) { event.preventDefault(); return; }
  draggedTimerId = card.dataset.id;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedTimerId);
  requestAnimationFrame(() => card.classList.add("dragging"));
});

$("#timerGrid").addEventListener("dragover", event => {
  if (!draggedTimerId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const grid = $("#timerGrid");
  const dragged = grid.querySelector(`[data-id="${draggedTimerId}"]`);
  const target = event.target.closest(".timer-card");
  if (!dragged || target === dragged) return;
  if (target) {
    const cards = [...grid.querySelectorAll(".timer-card")];
    const draggedIndex = cards.indexOf(dragged);
    const targetIndex = cards.indexOf(target);
    if (draggedIndex < targetIndex) target.after(dragged);
    else target.before(dragged);
  } else {
    const lastCard = grid.querySelector(".timer-card:last-child");
    if (lastCard && event.clientY > lastCard.getBoundingClientRect().bottom) grid.append(dragged);
  }
});

$("#timerGrid").addEventListener("drop", event => event.preventDefault());

$("#timerGrid").addEventListener("dragend", event => {
  const grid = $("#timerGrid");
  const card = event.target.closest(".timer-card");
  if (card) { card.classList.remove("dragging"); card.draggable = false; }
  const timersById = new Map(state.timers.map(timer => [timer.id, timer]));
  state.timers = [...grid.querySelectorAll(".timer-card")].map(item => timersById.get(item.dataset.id)).filter(Boolean);
  draggedTimerId = null;
  saveState("timers");
  renderTimers();
});

document.addEventListener("click", event => { if (!event.target.closest(".menu-button,.menu")) $$(".menu.open").forEach(m => m.classList.remove("open")); });
document.addEventListener("pointerdown", primeAudio, { once: true });
$("#newTimerButton").addEventListener("click", () => openDialog());
$("#newHabitButton").addEventListener("click", () => openWidgetDialog());
$("#replayWalkthroughButton").addEventListener("click", replayWalkthroughs);
$("#skipWalkthroughButton").addEventListener("click", () => finishWalkthrough("dismissed"));
$("#previousWalkthroughButton").addEventListener("click", () => showWalkthroughStep(walkthroughStepIndex - 1));
$("#nextWalkthroughButton").addEventListener("click", () => walkthroughStepIndex === activeWalkthroughSteps.length - 1 ? finishWalkthrough("completed") : showWalkthroughStep(walkthroughStepIndex + 1));
document.addEventListener("keydown", handleWalkthroughKeydown, true);
$("#sleepContent").addEventListener("click", event => {
  if (event.target.closest("[data-sleep-connect]")) connectSleep();
  if (event.target.closest("[data-sleep-goal]")) openSleepGoalDialog();
});
$("#sleepGoalForm").addEventListener("submit", saveSleepGoal);
$("#financeHoldingForm").addEventListener("submit", addFinanceHolding);
$("#financeHoldingType").addEventListener("change", updateFinanceHoldingFields);
$("#financeEditHoldingForm").addEventListener("submit", saveFinanceHolding);
$("#financeEditHoldingType").addEventListener("change", updateFinanceEditHoldingFields);
$("#allocationCategoryForm").addEventListener("submit", saveAllocationCategory);
$("#openAllocationLibraryButton").addEventListener("click", () => showView("allocationLibraryView"));
$("#backToFinancesButton").addEventListener("click", () => showView("financesView"));
$("#newAllocationCategoryButton").addEventListener("click", () => openAllocationCategoryDialog());
$("#allocationLibraryGrid").addEventListener("click", event => {
  if (event.target.closest("[data-new-allocation-category]")) { openAllocationCategoryDialog(); return; }
  const card = event.target.closest("[data-allocation-category-id]");
  const action = event.target.closest("[data-allocation-action]")?.dataset.allocationAction;
  if (!card || !action) return;
  const category = financeData?.allocation?.categories?.find(item => String(item.id) === card.dataset.allocationCategoryId);
  if (!category) return;
  if (action === "menu") { const menu = $(".food-menu", card); $$(".menu.open").filter(item => item !== menu).forEach(item => item.classList.remove("open")); menu.classList.toggle("open"); }
  if (action === "edit") openAllocationCategoryDialog(category);
  if (action === "delete") deleteAllocationCategory(category);
});
$("#allocationLibraryGrid").addEventListener("keydown", event => {
  const handle = event.target.closest("[data-allocation-drag-handle]");
  if (!handle || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const card = handle.closest("[data-allocation-category-id]");
  const cards = $$("[data-allocation-category-id]", $("#allocationLibraryGrid"));
  const currentIndex = cards.indexOf(card);
  const nextIndex = Math.max(0, Math.min(cards.length - 1, currentIndex + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1)));
  if (currentIndex === nextIndex) return;
  if (nextIndex < currentIndex) cards[nextIndex].before(card); else cards[nextIndex].after(card);
  saveAllocationCategoryOrder($$("[data-allocation-category-id]", $("#allocationLibraryGrid")).map(item => Number(item.dataset.allocationCategoryId)), Number(card.dataset.allocationCategoryId));
});
$("#allocationLibraryGrid").addEventListener("pointerdown", event => {
  const handle = event.target.closest("[data-allocation-drag-handle]");
  if (handle) handle.closest("[data-allocation-category-id]").draggable = true;
});
$("#allocationLibraryGrid").addEventListener("pointerup", event => {
  if (!draggedAllocationCategoryId) event.target.closest("[data-allocation-category-id]")?.setAttribute("draggable", "false");
});
$("#allocationLibraryGrid").addEventListener("dragstart", event => {
  const card = event.target.closest("[data-allocation-category-id]");
  if (!card || !card.draggable) { event.preventDefault(); return; }
  draggedAllocationCategoryId = card.dataset.allocationCategoryId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedAllocationCategoryId);
  requestAnimationFrame(() => card.classList.add("dragging"));
});
$("#allocationLibraryGrid").addEventListener("dragover", event => {
  if (!draggedAllocationCategoryId) return;
  event.preventDefault(); event.dataTransfer.dropEffect = "move";
  const grid = $("#allocationLibraryGrid");
  const dragged = $(`[data-allocation-category-id="${draggedAllocationCategoryId}"]`, grid);
  const target = event.target.closest("[data-allocation-category-id]");
  if (!dragged || target === dragged) return;
  if (target) {
    const cards = $$("[data-allocation-category-id]", grid);
    if (cards.indexOf(dragged) < cards.indexOf(target)) target.after(dragged); else target.before(dragged);
  }
});
$("#allocationLibraryGrid").addEventListener("drop", event => { if (draggedAllocationCategoryId) event.preventDefault(); });
$("#allocationLibraryGrid").addEventListener("dragend", event => {
  const grid = $("#allocationLibraryGrid");
  const card = event.target.closest("[data-allocation-category-id]");
  if (card) { card.classList.remove("dragging"); card.draggable = false; }
  const ids = $$("[data-allocation-category-id]", grid).map(item => Number(item.dataset.allocationCategoryId));
  draggedAllocationCategoryId = null;
  if (ids.length) saveAllocationCategoryOrder(ids);
});
$("#financesContent").addEventListener("click", event => {
  if (event.target.closest("[data-finance-add]")) { openFinanceHoldingDialog(); return; }
  if (event.target.closest("[data-finance-allocation-library]")) { showView("allocationLibraryView"); return; }
  const action = event.target.closest("[data-finance-action]")?.dataset.financeAction;
  const row = event.target.closest("[data-finance-holding-id]");
  if (!row || !action) return;
  if (action === "edit") openFinanceEditHoldingDialog(row);
  if (action === "delete") deleteFinanceHolding(row);
});
$("#financesContent").addEventListener("keydown", event => {
  const carousel = event.target.closest(".finance-summary-grid");
  if (!carousel || !["ArrowLeft", "ArrowRight"].includes(event.key) || !window.matchMedia("(max-width: 600px)").matches) return;
  event.preventDefault();
  const card = $(".cardio-summary-card", carousel);
  carousel.scrollBy({ left: (event.key === "ArrowRight" ? 1 : -1) * ((card?.offsetWidth || carousel.clientWidth) + 12), behavior: "smooth" });
});
$("#settingsFinanceCurrency").addEventListener("change", changeFinanceCurrency);
$("#cardioContent").addEventListener("click", event => {
  const stepCell = event.target.closest("[data-cardio-step-hour]");
  if (stepCell) { selectCardioStepHour(stepCell); return; }
  if (event.target.closest("[data-cardio-connect]")) { connectGoogleHealth(); return; }
  if (event.target.closest("[data-cardio-steps-refresh]")) { refreshCardioSteps(); return; }
  if (event.target.closest("[data-cardio-steps-goal]")) { openCardioStepsGoalDialog(); return; }
  if (event.target.closest("[data-cardio-zone2-goal]")) { openCardioZone2GoalDialog(); return; }
  const calendarAction = event.target.closest("[data-cardio-calendar]")?.dataset.cardioCalendar;
  if (calendarAction === "previous") { changeCardioCalendarMonth(-1); return; }
  if (calendarAction === "next") { changeCardioCalendarMonth(1); return; }
  if (calendarAction === "today") { cardioCalendarMonth = dayKey().slice(0, 7); renderCardio(); return; }
  const sessionButton = event.target.closest("[data-cardio-session-id]");
  if (sessionButton) selectCardioSession(sessionButton.dataset.cardioSessionId);
});
$("#cardioContent").addEventListener("change", event => {
  if (event.target.id === "cardioRestingRange") cardioRestingRange = event.target.value;
  else return;
  renderCardio();
});
$("#cardioZone2GoalForm").addEventListener("submit", saveCardioZone2Goal);
$("#cardioStepsGoalForm").addEventListener("submit", saveCardioStepsGoal);
$("#backToCardioButton").addEventListener("click", () => { selectedCardioSessionId = null; selectedCardioSession = null; showView("cardioView"); });
$("#deleteCardioSessionButton").addEventListener("click", deleteSelectedCardioSession);
$$('[data-view-link]').forEach(link => link.addEventListener("click", event => { event.preventDefault(); const targetView = link.dataset.viewLink; if (link.closest(".app-nav")) navigateToPrimaryView(targetView); else showView(targetView); }));
$(".app-nav").addEventListener("keydown", event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const tabs = $$('[data-view-link]', event.currentTarget);
  const focusedIndex = tabs.indexOf(document.activeElement);
  if (focusedIndex < 0) return;
  event.preventDefault();
  tabs[(focusedIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].focus();
});
installMetroPager();
$$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
$("#mesocycleForm").addEventListener("submit", saveMesocycle);
$("#strengthTemplateForm").addEventListener("submit", saveStrengthTemplate);
$("#strengthTemplateButton").addEventListener("click", () => showView("workoutLibraryView"));
$("#editMesocycleButton").addEventListener("click", () => openMesocycleDialog(activeMesocycle()));
$("#newMesocycleButton").addEventListener("click", () => openMesocycleDialog());
$("#backToStrengthButton").addEventListener("click", () => showView("strengthView"));
$("#backToStrengthFromWorkout").addEventListener("click", closeStrengthWorkout);
$("#workoutSessionDate").addEventListener("change", event => {
  const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId);
  const date = event.target.value;
  if (!session || !validDateKey(date) || date > dayKey()) {
    event.target.value = session?.date || dayKey();
    toast("Choose today or an earlier valid date.");
    return;
  }
  session.date = date; saveState("strength");
});
$("#finishWorkoutButton").addEventListener("click", finishStrengthWorkout);
$("#newWorkoutButton").addEventListener("click", () => openStrengthTemplateDialog());
$("#workoutLibrarySearch").addEventListener("input", renderWorkoutLibrary);
$("#workoutLibraryGrid").addEventListener("click", event => {
  const card = event.target.closest("[data-workout-id]"); const action = event.target.closest("[data-workout-action]")?.dataset.workoutAction;
  if (!card || !action) return;
  if (action === "menu") { const menu = $(".food-menu", card); $$(".menu.open").filter(item => item !== menu).forEach(item => item.classList.remove("open")); menu.classList.toggle("open"); }
  if (action === "edit") openStrengthTemplateDialog(state.strength.workouts.find(workout => workout.id === card.dataset.workoutId));
  if (action === "delete") deleteStrengthWorkout(card.dataset.workoutId);
});
$("#addTemplateExercise").addEventListener("click", () => {
  const row = addTemplateExerciseRow();
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  requestAnimationFrame(() => $("[data-template-exercise]", row)?.focus());
});
$("#strengthTemplateRows").addEventListener("click", event => {
  const undo = event.target.closest("[data-undo-template-exercise]");
  if (undo) { undoTemplateExerciseDeletion(undo.closest("[data-exercise-id]").dataset.exerciseId); return; }
  const remove = event.target.closest("[data-remove-template-exercise]");
  if (remove) stageTemplateExerciseDeletion(remove.closest(".strength-template-row"));
});
$("#strengthTemplateRows").addEventListener("keydown", event => {
  const handle = event.target.closest("[data-template-drag-handle]");
  if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const row = handle.closest(".strength-template-row");
  const rows = $$(".strength-template-row:not([hidden])", $("#strengthTemplateRows"));
  const index = rows.indexOf(row); const target = rows[index + (event.key === "ArrowUp" ? -1 : 1)];
  if (!target) return;
  if (event.key === "ArrowUp") target.before(row); else target.after(row);
  handle.focus();
});
$("#strengthTemplateRows").addEventListener("pointerdown", event => {
  const handle = event.target.closest("[data-template-drag-handle]");
  if (handle) handle.closest(".strength-template-row").draggable = true;
});
$("#strengthTemplateRows").addEventListener("pointerup", event => {
  if (!draggedTemplateExerciseId) event.target.closest(".strength-template-row")?.setAttribute("draggable", "false");
});
$("#strengthTemplateRows").addEventListener("dragstart", event => {
  const row = event.target.closest(".strength-template-row");
  if (!row || !row.draggable) { event.preventDefault(); return; }
  draggedTemplateExerciseId = row.dataset.exerciseId;
  event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", draggedTemplateExerciseId); row.classList.add("dragging");
});
$("#strengthTemplateRows").addEventListener("dragover", event => {
  if (!draggedTemplateExerciseId) return;
  const target = event.target.closest(".strength-template-row:not([hidden])");
  const dragged = $(`.strength-template-row[data-exercise-id="${draggedTemplateExerciseId}"]`, $("#strengthTemplateRows"));
  if (!target || !dragged || target === dragged) return;
  event.preventDefault(); event.dataTransfer.dropEffect = "move";
  const after = event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
  if (after) target.after(dragged); else target.before(dragged);
});
$("#strengthTemplateRows").addEventListener("drop", event => event.preventDefault());
$("#strengthTemplateRows").addEventListener("dragend", event => {
  const row = event.target.closest(".strength-template-row");
  if (row) { row.classList.remove("dragging"); row.draggable = false; }
  draggedTemplateExerciseId = null;
});
$("#strengthContent").addEventListener("click", event => {
  const week = event.target.closest("[data-strength-week]"); if (week) { strengthWeek = Number(week.dataset.strengthWeek); activeStrengthSessionId = null; renderStrength(); return; }
  const button = event.target.closest("[data-strength-action]"); if (!button) return; const action = button.dataset.strengthAction; const templateId = button.closest("[data-template-id]")?.dataset.templateId; const sessionId = button.closest("[data-session-id]")?.dataset.sessionId;
  if (action === "new-mesocycle") openMesocycleDialog();
  if (action === "new-template") openStrengthTemplateDialog();
  if (action === "open-workout-library") showView("workoutLibraryView");
  if (action === "edit-template") openStrengthTemplateDialog(state.strength.workouts.find(workout => workout.id === templateId));
  if (action === "start-workout") startStrengthWorkout(templateId);
  if (action === "open-session") { activeStrengthSessionId = sessionId; showView("workoutSessionView"); }
  if (action === "delete-session") deleteStrengthSession(sessionId);
  if (action === "complete-week") completeStrengthWeek();
});
$("#workoutSessionContent").addEventListener("click", async event => {
  const timerButton = event.target.closest("[data-workout-timer-action]");
  if (timerButton) { handleWorkoutCountdownAction(timerButton.dataset.workoutTimerAction, timerButton.closest("#workoutCountdown")); return; }
  const button = event.target.closest("[data-strength-action]"); if (!button) return; const action = button.dataset.strengthAction;
  if (action !== "add-set" && action !== "remove-set") return;
  const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId); const exercise = session?.exercises.find(item => item.id === button.closest("[data-session-exercise-id]")?.dataset.sessionExerciseId); if (!exercise) return;
  if (action === "add-set") {
    const last = exercise.sets.at(-1) || { reps: 8, load: 0 }, set = { ...last, id: uid(), completed: false };
    exercise.sets.push(set); renderStrengthLogger();
    try { const saved=await window.tempoServer.addStrengthSet(exercise.id,{...set,sortOrder:exercise.sets.indexOf(set)});set.id=String(saved.id);renderStrengthLogger(); }
    catch(error){exercise.sets=exercise.sets.filter(item=>item!==set);renderStrengthLogger();window.dispatchEvent(new CustomEvent("tempo:save-error",{detail:{message:error.message}}));}
  } else {
    const setId = button.closest("[data-set-id]")?.dataset.setId, index=exercise.sets.findIndex(set=>String(set.id)===setId);if(index<0)return;const [removed]=exercise.sets.splice(index,1);renderStrengthLogger();
    if(/^\d+$/.test(setId))try{await window.tempoServer.deleteStrengthSet(setId);}catch(error){exercise.sets.splice(index,0,removed);renderStrengthLogger();window.dispatchEvent(new CustomEvent("tempo:save-error",{detail:{message:error.message}}));}
  }
});
$("#workoutSessionContent").addEventListener("input", event => {
  const field = event.target.closest("[data-workout-timer-field]");
  if (field) {
    const panel = field.closest("#workoutCountdown");
    const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId);
    if (!panel || !session || panel.dataset.sessionKey !== workoutCountdownKey(session)) return;
    const countdown = workoutCountdownFor(session);
    if (countdown.running) return;
    countdown.durationMs = configuredWorkoutCountdownMs(panel);
    countdown.remainingMs = countdown.durationMs;
    countdown.endAt = null;
    countdown.notified = false;
    saveWorkoutCountdownPreference(countdown.durationMs);
    updateWorkoutCountdownUI(session);
    return;
  }
  const setField = event.target.closest('[data-set-field="load"],[data-set-field="reps"]'); if (!setField) return;
  const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId); const exercise = session?.exercises.find(item => item.id === setField.closest("[data-session-exercise-id]")?.dataset.sessionExerciseId); const set = exercise?.sets.find(item => String(item.id) === setField.closest("[data-set-id]")?.dataset.setId); if (!set) return;
  set[setField.dataset.setField] = Math.max(0, Number(setField.value) || 0);
  updateWorkoutVolumeProjection();
});
$("#workoutSessionContent").addEventListener("change", async event => {
  const field = event.target.closest("[data-set-field]"); if (!field) return; const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId); const exercise = session?.exercises.find(item => item.id === field.closest("[data-session-exercise-id]")?.dataset.sessionExerciseId); const set = exercise?.sets.find(item => item.id === field.closest("[data-set-id]")?.dataset.setId); if (!set) return;
  const value = field.type === "checkbox" ? field.checked : Math.max(0, Number(field.value) || 0);
  set[field.dataset.setField] = value;
  if (field.type === "checkbox") field.closest(".set-row")?.classList.toggle("completed", field.checked);
  else field.value = value;
  if(/^\d+$/.test(String(set.id)))try{await window.tempoServer.updateStrengthSet(set.id,set);}catch(error){window.dispatchEvent(new CustomEvent("tempo:save-error",{detail:{message:error.message}}));}
});
function selectProgressSummary(tab) { progressSummaryTab = tab; hoveredRingItemId = null; selectedRingItemId = null; renderDailyRings(); }
$("#habitProgressTab").addEventListener("click", () => selectProgressSummary("habits"));
$("#nutritionProgressTab").addEventListener("click", () => selectProgressSummary("nutrition"));
$("#momentumTabs").addEventListener("click", event => { const button = event.target.closest("[data-momentum-filter]"); if (button) { momentumFilter = button.dataset.momentumFilter; renderWeeklyChart(); } });
$("#timerForm").addEventListener("submit", saveTimer);
$("#trackCompletions").addEventListener("change", updateTimerTargetVisibility);
$("#timerPomodoro").addEventListener("change", updatePomodoroVisibility);
$("#deleteConfirmationDialog").addEventListener("close", () => { pendingDeleteAction = null; });
$("#deleteConfirmationForm").addEventListener("submit", event => {
  event.preventDefault();
  const action = pendingDeleteAction;
  pendingDeleteAction = null;
  $("#deleteConfirmationDialog").close();
  action?.();
});
$("#widgetForm").addEventListener("submit", saveWidget);
$("#foodForm").addEventListener("submit", saveFood);
$("#librarySearchInput").addEventListener("input", renderFoodLibrary);
$("#foodsLibraryTab").addEventListener("click", () => { libraryTab = "foods"; $("#librarySearchInput").value = ""; renderFoodLibrary(); });
$("#mealsLibraryTab").addEventListener("click", () => { libraryTab = "meals"; $("#librarySearchInput").value = ""; renderFoodLibrary(); });
$("#exportFoodsButton").addEventListener("click", exportFoodLibrary);
$("#importFoodsButton").addEventListener("click", () => $("#foodCsvInput").click());
$("#foodCsvInput").addEventListener("change", event => importFoodLibrary(event.target.files?.[0]));
$("#foodLibraryGrid").addEventListener("click", event => {
  const foodCard = event.target.closest("[data-food-id]"); const foodAction = event.target.closest("[data-food-action]")?.dataset.foodAction;
  const mealCard = event.target.closest("[data-meal-id]"); const mealAction = event.target.closest("[data-meal-action]")?.dataset.mealAction;
  const card = foodCard || mealCard; const action = foodAction || mealAction; if (!card || !action) return;
  if (action === "menu") { const menu = $(".food-menu", card); $$(".menu.open").filter(item => item !== menu).forEach(item => item.classList.remove("open")); menu.classList.toggle("open"); }
  if (foodCard && action === "edit") openFoodDialog(state.foods.find(food => food.id === foodCard.dataset.foodId));
  if (foodCard && action === "delete") deleteFood(foodCard.dataset.foodId);
  if (mealCard && action === "edit") openMealDialog(state.meals.find(meal => meal.id === mealCard.dataset.mealId));
  if (mealCard && action === "delete") deleteMeal(mealCard.dataset.mealId);
});
$("#mealForm").addEventListener("submit", saveMeal);
$("#addMealItemButton").addEventListener("click", () => addMealItemRow());
$("#mealItems").addEventListener("input", event => {
  const row = event.target.closest(".meal-item-row"); if (!row) return;
  if (event.target.matches("[data-meal-food]")) { const food = state.foods.find(item => String(item.id) === event.target.value); if (food) { $("[data-meal-serving]", row).value = food.servingSize; $("[data-meal-unit]", row).textContent = food.servingUnit; event.target.closest("label").nextElementSibling.querySelector("input").setAttribute("aria-label", `${food.title} serving`); } }
  renderMealPreview();
});
$("#mealItems").addEventListener("click", event => { const remove = event.target.closest("[data-remove-meal-item]"); if (!remove) return; remove.closest(".meal-item-row").remove(); renderMealPreview(); });
$("#foodSearchInput").addEventListener("input", renderFoodSearchResults);
$("#foodSearchInput").addEventListener("focus", renderFoodSearchResults);
$("#foodSearchInput").addEventListener("keydown", event => {
  const first = $("#foodSearchResults [data-quick-food-id],#foodSearchResults [data-quick-meal-id]");
  if (event.key === "Enter" && first) { event.preventDefault(); first.dataset.quickFoodId ? addFoodToLog(first.dataset.quickFoodId) : addMealToLog(first.dataset.quickMealId); }
  if (event.key === "ArrowDown" && first) { event.preventDefault(); first.focus(); }
  if (event.key === "Escape") $("#foodSearchResults").hidden = true;
});
$("#foodSearchResults").addEventListener("click", event => { const button = event.target.closest("[data-quick-food-id],[data-quick-meal-id]"); if (button?.dataset.quickFoodId) addFoodToLog(button.dataset.quickFoodId); if (button?.dataset.quickMealId) addMealToLog(button.dataset.quickMealId); });
$("#foodSearchResults").addEventListener("keydown", event => {
  const button = event.target.closest("[data-quick-food-id],[data-quick-meal-id]"); if (!button) return;
  if (event.key === "ArrowDown") { event.preventDefault(); (button.nextElementSibling || button.parentElement.firstElementChild)?.focus(); }
  if (event.key === "ArrowUp") { event.preventDefault(); (button.previousElementSibling || $("#foodSearchInput"))?.focus(); }
});
$("#recentFoods").addEventListener("click", event => { const foodId = event.target.closest("[data-recent-food-id]")?.dataset.recentFoodId; const mealId = event.target.closest("[data-recent-meal-id]")?.dataset.recentMealId; if (foodId) addFoodToLog(foodId, false); if (mealId) addMealToLog(mealId, false); if (event.target.closest("[data-go-library]")) showView("foodLibraryView"); });
$("#foodLogList").addEventListener("click", event => {
  const row = event.target.closest("[data-entry-id]"); const action = event.target.closest("[data-log-action]")?.dataset.logAction; if (!row || !action) return;
  if (action === "edit") openServingDialog(row.dataset.entryId);
  else if (action === "undo") undoFoodLogDeletion(row.dataset.entryId);
  else stageFoodLogDeletion(row.dataset.entryId);
});
$("#foodLogDate").addEventListener("change", event => { if (event.target.value) { const bounds = foodLogDateBounds(); foodLogDay = event.target.value < bounds.min ? bounds.min : event.target.value > bounds.max ? bounds.max : event.target.value; renderFoodLog(); } });
$("#previousLogDay").addEventListener("click", () => { const bounds = foodLogDateBounds(); const date = addCalendarDays(foodLogDay, -1); foodLogDay = date < bounds.min ? bounds.min : date; renderFoodLog(); });
$("#nextLogDay").addEventListener("click", () => { const bounds = foodLogDateBounds(); const date = addCalendarDays(foodLogDay, 1); foodLogDay = date > bounds.max ? bounds.max : date; renderFoodLog(); });
$("#todayLogDay").addEventListener("click", () => { foodLogDay = dayKey(); renderFoodLog(); });
$("#servingForm").addEventListener("submit", saveServing);
$("#nutritionGoalSetupButton").addEventListener("click", openNutritionGoalDialog);
$("#settingsNutritionGoalButton").addEventListener("click", openNutritionGoalDialog);
$("#settingsCardioGoalButton").addEventListener("click", openCardioZone2GoalDialog);
$("#settingsStepsGoalButton").addEventListener("click", openCardioStepsGoalDialog);
$("#settingsSleepGoalButton").addEventListener("click", openSleepGoalDialog);
$("#copyPrivateAreaUrlButton").addEventListener("click", copyPrivateAreaUrl);
$("#quickAddNewFoodButton").addEventListener("click", () => openFoodDialog());
$("#openFoodLibraryButton").addEventListener("click", () => showView("foodLibraryView"));
$("#backToNutritionButton").addEventListener("click", () => showView("foodLogView"));
$("#newLibraryItemButton").addEventListener("click", () => libraryTab === "foods" ? openFoodDialog() : openMealDialog());
$("#nutritionGoalForm").addEventListener("submit", saveNutritionGoal);
document.addEventListener("click", event => { if (!event.target.closest(".food-search-wrap")) $("#foodSearchResults").hidden = true; });
$$('input[name="widgetType"]').forEach(input => input.addEventListener("change", updateWidgetTypeFields));
$("#dailyRings").addEventListener("pointermove", updateRingTooltip);
$("#dailyRings").addEventListener("pointerleave", () => { $("#ringTooltip").hidden = true; hoveredRingItemId = null; updateRingHighlight(); });
$("#dailyRings").addEventListener("click", event => { const hit = ringHitFromPointer(event); if (hit) { selectedRingItemId = selectedRingItemId === hit.item.id ? null : hit.item.id; updateRingHighlight(); } });
$("#ringsLegend").addEventListener("pointerover", event => { const row = event.target.closest("[data-ring-item-id]"); if (row && hoveredRingItemId !== row.dataset.ringItemId) { hoveredRingItemId = row.dataset.ringItemId; updateRingHighlight(); } });
$("#ringsLegend").addEventListener("pointerleave", () => { hoveredRingItemId = null; updateRingHighlight(); });
$("#ringsLegend").addEventListener("focusin", event => { const row = event.target.closest("[data-ring-item-id]"); if (row) { hoveredRingItemId = row.dataset.ringItemId; updateRingHighlight(); } });
$("#ringsLegend").addEventListener("focusout", event => { if (!$("#ringsLegend").contains(event.relatedTarget)) { hoveredRingItemId = null; updateRingHighlight(); } });
$("#ringsLegend").addEventListener("click", event => { const row = event.target.closest("[data-ring-item-id]"); if (row) { selectedRingItemId = selectedRingItemId === row.dataset.ringItemId ? null : row.dataset.ringItemId; updateRingHighlight(); } });
window.addEventListener("resize", renderDailyRings);

async function showRouteFromLocation() {
  const route = routeFromLocation(privateBasePath, location.pathname, location.hash);
  if (route.viewId === "cardioSessionView") {
    if (!route.detailId || route.detailId === "current") { showView("cardioView", false); return; }
    await selectCardioSession(route.detailId, false);
    return;
  }
  if (route.viewId === "workoutSessionView") {
    const sessions = state.strength.mesocycles.flatMap(mesocycle => mesocycle.sessions || []);
    activeStrengthSessionId = route.detailId === "current" ? sessions.find(session => session.status === "in-progress")?.id || null : route.detailId;
    if (!sessions.some(session => String(session.id) === String(activeStrengthSessionId))) { activeStrengthSessionId = null; showView("strengthView", false); return; }
  } else activeStrengthSessionId = null;
  if (route.viewId !== "cardioSessionView") { selectedCardioSessionId = null; selectedCardioSession = null; }
  showView(route.viewId, false);
}

updateViewLinkPaths();
const timerDayReset = resetTimerCountsForCurrentDay();
syncTimers();
if (timerDayReset) saveState("timers");
renderTimers();
renderFoodLibrary();
renderFoodLog();
renderStrength();
renderWorkoutLibrary();
const initialRoute = routeFromLocation(privateBasePath, location.pathname, location.hash);
await showRouteFromLocation();
if (location.hash) history.replaceState(null, "", `${pathForView(privateBasePath, initialRoute.viewId, initialRoute.detailId)}${location.search}`);
window.addEventListener("popstate", () => { showRouteFromLocation(); });
pageWalkthroughReady = true;
if (window.__TEMPO_BOOTSTRAP__?.walkthrough?.status === "pending") startWalkthrough();
else schedulePageWalkthrough(initialRoute.viewId);
const googleHealthResult = new URLSearchParams(location.search).get("google_health");
if (googleHealthResult) {
  toast(googleHealthResult === "connected" ? `Google Health connected. ${initialRoute.viewId === "sleepView" ? "Sleep" : "Cardio"} is syncing automatically.` : googleHealthResult === "denied" ? "Google Health connection was cancelled." : "Google Health connection failed. Try again.");
  const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete("google_health"); history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}
refreshLucideIcons();
setInterval(() => {
  const currentDay = dayKey();
  const dayChanged = currentDay !== currentDayKey;
  if (dayChanged) {
    const wasViewingToday = visibleDay === currentDayKey;
    currentDayKey = currentDay;
    if (wasViewingToday) visibleDay = currentDay;
    foodLogDay = currentDay;
    if (resetTimerCountsForCurrentDay(currentDay)) saveState("timers");
  }
  const changed = syncTimers();
  updateTimeLeft();
  if ((dayChanged || changed) && !draggedTimerId && !draggedWidgetId) renderTimers();
}, 500);
setInterval(() => {
  workoutCountdowns.forEach(countdown => syncWorkoutCountdown(countdown));
  if (activeView !== "workoutSessionView" || !activeStrengthSessionId) return;
  const session = activeMesocycle()?.sessions.find(item => item.id === activeStrengthSessionId);
  if (session) updateWorkoutCountdownUI(session);
}, 250);
window.addEventListener("tempo:saved-state", event => {
  const activeSession = state.strength.mesocycles.flatMap(meso => meso.sessions || []).find(session => session.id === activeStrengthSessionId);
  Object.entries(event.detail).forEach(([section, data]) => mergeSection(state, section, data));
  state = migrateState(state);
  if (activeSession) {
    const savedSession = state.strength.mesocycles.flatMap(meso => meso.sessions || []).find(session => session.createdAt === activeSession.createdAt && session.name === activeSession.name);
    activeStrengthSessionId = savedSession?.id || null;
    if (activeView === "workoutSessionView" && activeStrengthSessionId) history.replaceState(null, "", `${pathForView(privateBasePath, activeView, activeStrengthSessionId)}${location.search}`);
  }
  renderTimers(); renderHabits(); renderFoodLibrary(); renderFoodLog(); renderStrength(); renderWorkoutLibrary(); renderDailyRings(); renderWeeklyChart();
  if (activeView === "workoutSessionView" && activeStrengthSessionId) renderStrengthLogger();
});
window.addEventListener("tempo:saved", () => {
  persistencePending = false;
  if (queuedPersistenceToast) { const message = queuedPersistenceToast; queuedPersistenceToast = ""; toast(message); }
});
window.addEventListener("tempo:save-error", event => {
  persistencePending = false; queuedPersistenceToast = "";
  if (event.detail?.conflict) showConflictToast();
  else toast(event.detail?.message || "Tempo could not save that change.");
});
window.addEventListener("tempo:conflict", event => {
  state = migrateState(event.detail);
  activeStrengthSessionId = null;
  renderTimers(); renderHabits(); renderFoodLibrary(); renderFoodLog(); renderStrength(); renderWorkoutLibrary(); renderDailyRings(); renderWeeklyChart();
  showConflictToast();
});
