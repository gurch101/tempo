import { describe, expect, it } from "vitest";
import { createCalendar } from "../public/calendar.js";

describe("private-area browser calendar", () => {
  it("uses the configured timezone rather than the device calendar", () => {
    const instant = new Date("2026-08-08T06:30:00Z");
    expect(createCalendar("America/Vancouver").dayKey(instant)).toBe("2026-08-07");
    expect(createCalendar("Asia/Tokyo").dayKey(instant)).toBe("2026-08-08");
  });

  it("uses timezone midnight across DST and calendar weekdays", () => {
    const calendar = createCalendar("America/Vancouver");
    expect(new Date(calendar.nextDayBoundary(Date.parse("2026-03-08T08:30:00Z"))).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(calendar.weekdayForKey("2026-03-08")).toBe(0);
    expect(calendar.addCalendarDays("2026-03-08", 1)).toBe("2026-03-09");
  });
});
