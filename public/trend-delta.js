export function periodDelta(points, valueFor = point => point?.value) {
  if (!points?.length) return null;
  const firstValue = Number(valueFor(points[0]));
  const lastValue = Number(valueFor(points.at(-1)));
  if (!Number.isFinite(firstValue) || !Number.isFinite(lastValue)) return null;
  const change = lastValue - firstValue;
  return { change, percent: firstValue === 0 ? null : change / firstValue * 100 };
}

export function deltaPoints(points, { excludeDate = null, excludeLatest = false } = {}) {
  const eligible = excludeDate ? points.filter(point => point.date !== excludeDate) : [...points];
  return excludeLatest ? eligible.slice(0, -1) : eligible;
}
