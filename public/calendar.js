export function createCalendar(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayKey = (date = new Date()) => {
    if (date.tempoCalendarKey) return date.tempoCalendarKey;
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const dateFromKey = key => { const date = new Date(`${key}T12:00:00.000Z`); date.tempoCalendarKey = key; return date; };
  const calendarKey = date => date.toISOString().slice(0, 10);
  const validDateKey = key => /^\d{4}-\d{2}-\d{2}$/.test(key) && calendarKey(dateFromKey(key)) === key;
  const addCalendarDays = (key, count) => { const date = dateFromKey(key); date.setUTCDate(date.getUTCDate() + count); return calendarKey(date); };
  const weekdayForKey = key => dateFromKey(key).getUTCDay();
  const weekdayAt = date => weekdayForKey(dayKey(date));
  const formatCalendarDate = (key, options) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(dateFromKey(key));
  const nextDayBoundary = timestamp => {
    const current = dayKey(new Date(timestamp));
    let low = timestamp + 1, high = timestamp + 36 * 60 * 60 * 1000;
    while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (dayKey(new Date(middle)) === current) low = middle; else high = middle; }
    return high;
  };
  return { dayKey, dateFromKey, validDateKey, addCalendarDays, weekdayForKey, weekdayAt, formatCalendarDate, nextDayBoundary };
}
