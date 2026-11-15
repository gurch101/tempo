// Combine the server's streak through yesterday with one day's local record.
// This keeps edits instant without loading or scanning older history.
export function habitStreak(widget, record, previous, date, today, scheduled) {
  if (!scheduled) return previous;
  const complete = widget.type === "counter"
    ? (record.value || 0) >= (record.goal > 0 ? record.goal : widget.goal)
    : record.done === true;
  return complete ? previous + 1 : date === today ? previous : 0;
}
