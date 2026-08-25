CREATE TABLE trend_sync_state (
  space_id INTEGER PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  reset_cursor INTEGER NOT NULL DEFAULT 0 CHECK (reset_cursor >= 0),
  fingerprint TEXT NOT NULL,
  meta_json TEXT NOT NULL CHECK (json_valid(meta_json))
);

CREATE TABLE trend_points (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  series TEXT NOT NULL,
  point_date TEXT NOT NULL CHECK (point_date GLOB '????-??-??'),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_cursor INTEGER NOT NULL CHECK (updated_cursor >= 0),
  PRIMARY KEY (space_id, series, point_date)
);

CREATE TABLE trend_change_log (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor > 0),
  series TEXT NOT NULL,
  point_date TEXT NOT NULL CHECK (point_date GLOB '????-??-??'),
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  PRIMARY KEY (space_id, cursor, series, point_date)
);

CREATE INDEX idx_trend_change_log_since ON trend_change_log(space_id, cursor);
