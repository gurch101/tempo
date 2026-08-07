CREATE TABLE cardio_daily_zone2 (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  recorded_date TEXT NOT NULL,
  moderate_seconds REAL NOT NULL CHECK (moderate_seconds >= 0),
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, recorded_date)
);
