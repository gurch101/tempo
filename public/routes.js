const STATIC_VIEW_ROUTES = {
  timersView: "",
  foodLogView: "/nutrition",
  foodLibraryView: "/nutrition/library",
  strengthView: "/strength",
  workoutLibraryView: "/strength/library",
  cardioView: "/cardio",
  sleepView: "/sleep",
  financesView: "/finances",
  allocationLibraryView: "/finances/allocation",
  settingsView: "/settings"
};

export function pathForView(basePath, viewId, detailId = null) {
  if (viewId === "workoutSessionView") return `${basePath}/strength/session/${encodeURIComponent(detailId || "current")}`;
  if (viewId === "cardioSessionView") return `${basePath}/cardio/session/${encodeURIComponent(detailId || "current")}`;
  return `${basePath}${STATIC_VIEW_ROUTES[viewId] ?? ""}`;
}

export function routeFromLocation(basePath, pathname, hash = "") {
  if (hash) {
    const cardio = /^#cardio-session\/(.+)$/.exec(hash);
    if (cardio) return { viewId: "cardioSessionView", detailId: decodeURIComponent(cardio[1]) };
    const legacy = { "#home":"timersView", "#nutrition":"foodLogView", "#food-log":"foodLogView", "#food-library":"foodLibraryView", "#strength":"strengthView", "#workout-library":"workoutLibraryView", "#workout":"workoutSessionView", "#cardio":"cardioView", "#sleep":"sleepView", "#finances":"financesView", "#allocation-library":"allocationLibraryView", "#settings":"settingsView" };
    if (legacy[hash]) return { viewId: legacy[hash], detailId: null };
  }
  const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length).replace(/\/$/, "") : "";
  const workout = /^\/strength\/session\/([^/]+)$/.exec(relative);
  if (workout) return { viewId: "workoutSessionView", detailId: decodeURIComponent(workout[1]) };
  const cardio = /^\/cardio\/session\/([^/]+)$/.exec(relative);
  if (cardio) return { viewId: "cardioSessionView", detailId: decodeURIComponent(cardio[1]) };
  const routeViews = Object.fromEntries(Object.entries(STATIC_VIEW_ROUTES).map(([view, route]) => [route, view]));
  return { viewId: routeViews[relative] || "timersView", detailId: null };
}
