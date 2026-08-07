const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hourCycle: "h23"
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function validTimeZone(value: string): boolean {
  try { formatter(value).format(0); return true; } catch { return false; }
}

export function localDateInfo(epochMs: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(epochMs);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: weekdays[get("weekday")] ?? 0 };
}

export function nextLocalDateBoundary(from: number, timeZone: string): number {
  const current = localDateInfo(from, timeZone).date;
  let low = from + 1;
  let high = from + 30 * 60 * 60 * 1000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDateInfo(mid, timeZone).date === current) low = mid + 1;
    else high = mid;
  }
  return low;
}
