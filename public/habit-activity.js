const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const arrowSteps = new Map([["ArrowLeft", -7], ["ArrowRight", 7], ["ArrowUp", -1], ["ArrowDown", 1]]);

function completedHabitNames(records = {}, habitId) {
  const candidates = habitId ? [records[habitId]] : Object.values(records);
  return candidates
    .filter(record => record && (record.type === "counter" ? record.value >= record.goal : record.done === true))
    .map(record => record.name || "Unnamed habit");
}

export function createHabitActivity(panel, { dayKey, addCalendarDays, weekdayForKey, dateFromKey }, getHabitLogs, getCurrentHabits) {
  const status = panel.querySelector("#habitActivityStatus");
  const filter = panel.querySelector("#habitActivityFilter");
  const calendar = panel.querySelector("#habitActivityCalendar");
  const footer = panel.querySelector("#habitActivityFooter");
  const details = panel.querySelector("#habitActivityDetails");
  const countLegend = panel.querySelector("#habitActivityCountLegend");
  const singleLegend = panel.querySelector("#habitActivitySingleLegend");
  let request = 0;
  let logs = {};
  let days = new Map();
  let pinnedDate;
  let shownDate;
  let latestDate;
  let tabStop;
  let initializedScroll = false;

  function updateFilter() {
    const selected = filter.value;
    const names = new Map();
    for (const date of Object.keys(logs).sort()) {
      for (const [id, record] of Object.entries(logs[date])) {
        if (record.name || !names.has(id)) names.set(id, record.name || "Unnamed habit");
      }
    }
    for (const [id, name] of getCurrentHabits()) names.set(id, name);
    const sorted = [...names].sort((left, right) => left[1].localeCompare(right[1]));
    filter.replaceChildren(...[["", "All habits"], ...sorted].map(([id, name]) => new Option(name, id)));
    filter.value = names.has(selected) ? selected : "";
    filter.disabled = names.size === 0;
  }

  function positionDetails() {
    const day = days.get(shownDate);
    if (!day) return;
    const cell = day.cell.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const scroller = calendar.getBoundingClientRect();
    const root = document.documentElement;
    const leftEdge = Math.max(scroller.left, 8);
    const rightEdge = Math.min(scroller.right, root.clientWidth - 8);
    const above = cell.top - 8;
    const below = root.clientHeight - cell.bottom - 8;
    details.hidden = cell.width === 0 || cell.right <= leftEdge || cell.left >= rightEdge
      || cell.bottom <= 0 || cell.top >= root.clientHeight;
    if (details.hidden) return;

    details.style.maxHeight = `${Math.min(240, Math.max(above, below))}px`;
    const { width, height } = details.getBoundingClientRect();
    const left = Math.max(leftEdge, Math.min(rightEdge - width, cell.left + (cell.width - width) / 2));
    const top = above >= height || above >= below ? cell.top - height : cell.bottom;
    details.style.left = `${left - panelBox.left - panel.clientLeft}px`;
    details.style.top = `${top - panelBox.top - panel.clientTop}px`;
  }

  function showDay(date = pinnedDate) {
    if (date === shownDate) return;
    days.get(shownDate)?.cell.removeAttribute("aria-describedby");
    shownDate = date;
    const day = days.get(date);
    if (!day) {
      details.hidden = true;
      return;
    }
    day.cell.setAttribute("aria-describedby", details.id);
    const heading = document.createElement("strong");
    heading.textContent = `${day.label} · ${day.summary}`;
    details.replaceChildren(heading);
    if (day.names.length) {
      const list = document.createElement("ul");
      for (const name of day.names) {
        const item = document.createElement("li");
        item.textContent = name;
        list.append(item);
      }
      details.append(list);
    }
    details.scrollTop = 0;
    positionDetails();
  }

  function dismissDetails() {
    days.get(pinnedDate)?.cell.setAttribute("aria-pressed", "false");
    pinnedDate = undefined;
    showDay();
  }

  function render(to) {
    const from = addCalendarDays(to, -364);
    const habitId = filter.value;
    countLegend.hidden = Boolean(habitId);
    singleLegend.hidden = !habitId;
    const oldScroll = calendar.scrollLeft;
    const focusedDate = calendar.contains(document.activeElement) ? document.activeElement.dataset.habitDate : null;
    const tabDate = tabStop?.dataset.habitDate;
    showDay(null);
    const firstWeekday = weekdayForKey(from);
    const grid = document.createElement("div");
    grid.className = "habit-activity-grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Daily habit completions. Use arrow keys to move between days.");
    grid.style.setProperty("--weeks", Math.ceil((365 + firstWeekday) / 7));
    days = new Map();
    for (const [label, row] of [["Mon", 3], ["Wed", 5], ["Fri", 7]]) {
      const weekday = document.createElement("span");
      weekday.className = "habit-activity-weekday";
      weekday.textContent = label;
      weekday.style.gridRow = row;
      grid.append(weekday);
    }
    for (let index = 0; index < 365; index++) {
      const date = addCalendarDays(from, index);
      const offset = index + firstWeekday;
      const column = Math.floor(offset / 7) + 2;
      if (date.endsWith("-01") || (index === 0 && Number(date.slice(-2)) <= 21)) {
        const month = document.createElement("span");
        month.className = "habit-activity-month";
        month.textContent = monthFormat.format(dateFromKey(date));
        month.style.gridColumn = column;
        grid.append(month);
      }
      const names = completedHabitNames(logs[date], habitId);
      const label = dayFormat.format(dateFromKey(date));
      const summary = habitId
        ? (names.length ? "Completed" : "No completion")
        : `${names.length} habit${names.length === 1 ? "" : "s"} completed`;
      const level = habitId && names.length ? 4 : Math.min(names.length, 4);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.tabIndex = -1;
      cell.dataset.habitDate = date;
      cell.className = `habit-activity-cell level-${level}`;
      cell.style.gridColumn = column;
      cell.style.gridRow = offset % 7 + 2;
      cell.setAttribute("aria-label", `${label}, ${summary}`);
      cell.setAttribute("aria-pressed", String(date === pinnedDate));
      days.set(date, { cell, names, label, summary });
      grid.append(cell);
    }
    latestDate = to;
    if (!days.has(pinnedDate)) pinnedDate = undefined;
    tabStop = (days.get(tabDate) || days.get(to)).cell;
    tabStop.tabIndex = 0;
    calendar.replaceChildren(grid);
    calendar.hidden = footer.hidden = false;
    if (calendar.clientWidth) {
      calendar.scrollLeft = initializedScroll ? oldScroll : calendar.scrollWidth;
      initializedScroll = true;
    }
    showDay();
    days.get(focusedDate)?.cell.focus({ preventScroll: true });
  }

  filter.addEventListener("change", () => render(latestDate));
  calendar.addEventListener("pointerover", event => {
    const date = event.target.dataset.habitDate;
    if (date && event.pointerType !== "touch") showDay(date);
  });
  calendar.addEventListener("pointerout", event => {
    if (event.target.dataset.habitDate && !event.relatedTarget?.dataset?.habitDate && !details.contains(event.relatedTarget)) showDay();
  });
  details.addEventListener("pointerout", event => {
    if (!details.contains(event.relatedTarget) && !event.relatedTarget?.dataset?.habitDate) showDay();
  });
  calendar.addEventListener("focusin", event => {
    const date = event.target.dataset.habitDate;
    if (!date) return;
    tabStop.tabIndex = -1;
    tabStop = event.target;
    tabStop.tabIndex = 0;
    showDay(date);
  });
  calendar.addEventListener("focusout", event => {
    if (!event.relatedTarget?.dataset?.habitDate) showDay();
  });
  calendar.addEventListener("click", event => {
    const date = event.target.dataset.habitDate;
    if (!date) return;
    if (pinnedDate === date) {
      dismissDetails();
      return;
    }
    days.get(pinnedDate)?.cell.setAttribute("aria-pressed", "false");
    pinnedDate = date;
    days.get(date).cell.setAttribute("aria-pressed", "true");
    showDay(date);
  });
  calendar.addEventListener("keydown", event => {
    const date = event.target.dataset.habitDate;
    const step = arrowSteps.get(event.key);
    if (!date || !step) return;
    event.preventDefault();
    days.get(addCalendarDays(date, step))?.cell.focus();
  });
  calendar.addEventListener("scroll", positionDetails);
  window.addEventListener("resize", positionDetails);
  document.addEventListener("click", event => {
    if (shownDate && !details.contains(event.target) && !event.target.closest?.("[data-habit-date]")) dismissDetails();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !details.hidden) dismissDetails();
  });

  return {
    async load() {
      const currentRequest = ++request;
      const to = dayKey();
      const from = addCalendarDays(to, -364);
      if (calendar.hidden) {
        status.textContent = "Loading habit activity…";
        status.hidden = false;
      }
      try {
        const loadedLogs = await getHabitLogs(from, to);
        if (currentRequest !== request) return;
        logs = loadedLogs;
        updateFilter();
        render(to);
        status.hidden = true;
      } catch {
        if (currentRequest !== request) return;
        status.textContent = "Could not refresh habit activity.";
        status.hidden = false;
      }
    }
  };
}
