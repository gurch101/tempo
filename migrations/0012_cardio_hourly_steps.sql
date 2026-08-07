CREATE TABLE cardio_hourly_steps (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  hour_start INTEGER NOT NULL,
  step_count INTEGER NOT NULL CHECK (step_count >= 0),
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, hour_start)
);
