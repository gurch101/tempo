import { describe, expect, it } from "vitest";
import { pathForView, routeFromLocation } from "../public/routes.js";

describe("private page routes", () => {
  const base = `/p/${"a".repeat(43)}`;

  it("maps app pages to stable private-space paths", () => {
    expect(pathForView(base, "timersView")).toBe(base);
    expect(pathForView(base, "foodLogView")).toBe(`${base}/nutrition`);
    expect(pathForView(base, "foodLibraryView")).toBe(`${base}/nutrition/library`);
    expect(pathForView(base, "allocationLibraryView")).toBe(`${base}/finances/allocation`);
    expect(pathForView(base, "workoutSessionView", "session 1")).toBe(`${base}/strength/session/session%201`);
    expect(pathForView(base, "cardioSessionView", 42)).toBe(`${base}/cardio/session/42`);
  });

  it("restores page and detail state from paths", () => {
    expect(routeFromLocation(base, `${base}/finances`)).toEqual({ viewId: "financesView", detailId: null });
    expect(routeFromLocation(base, `${base}/finances/allocation`)).toEqual({ viewId: "allocationLibraryView", detailId: null });
    expect(routeFromLocation(base, `${base}/strength/session/session%201`)).toEqual({ viewId: "workoutSessionView", detailId: "session 1" });
    expect(routeFromLocation(base, `${base}/cardio/session/42`)).toEqual({ viewId: "cardioSessionView", detailId: "42" });
  });

  it("converts legacy hashes to their routed pages", () => {
    expect(routeFromLocation(base, base, "#nutrition")).toEqual({ viewId: "foodLogView", detailId: null });
    expect(routeFromLocation(base, base, "#cardio-session/42")).toEqual({ viewId: "cardioSessionView", detailId: "42" });
  });
});
