CREATE TABLE cardio_session_exclusions (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  google_data_point_name TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, google_data_point_name)
);
