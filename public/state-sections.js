export const sectionOrder = ["timers", "habits", "habitLogs", "foods", "meals", "foodLogs", "nutritionGoal", "strength"];

export function sectionValue(state, section) {
  if (section === "habits") return state.widgets;
  if (section === "habitLogs") return state.logs;
  if (section === "foodLogs") return { foodLogs: state.foodLogs };
  return state[section];
}

export function mergeSection(state, section, data) {
  if (section === "habits") state.widgets = data;
  else if (section === "habitLogs") state.logs = data;
  else if (section === "foodLogs") Object.assign(state, data);
  else state[section] = data;
  return state;
}

export function replaceIdEverywhere(value, oldId, newId) {
  if (Array.isArray(value)) return value.map(item => replaceIdEverywhere(item, oldId, newId));
  if (!value || typeof value !== "object") return String(value) === String(oldId) ? newId : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key.endsWith(`:${oldId}`) ? `${key.slice(0, key.length - String(oldId).length)}${newId}` : key,
    replaceIdEverywhere(item, oldId, newId)
  ]));
}

export function reconcileIds(target, before, after) {
  if (!target || !before || !after || typeof before !== "object" || typeof after !== "object") return target;
  if (before.id != null && after.id != null && String(before.id) !== String(after.id)) target = replaceIdEverywhere(target, before.id, after.id);
  if (Array.isArray(before) && Array.isArray(after)) before.forEach((item, index) => { target = reconcileIds(target, item, after[index]); });
  else if (!Array.isArray(before) && !Array.isArray(after)) Object.keys(before).forEach(key => { target = reconcileIds(target, before[key], after[key]); });
  return target;
}
