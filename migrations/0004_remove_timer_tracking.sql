PRAGMA defer_foreign_keys = ON;

DROP TABLE timer_schedule_days;
DROP TABLE timer_daily_logs;
DROP INDEX idx_timers_space_sort_active;

CREATE TABLE timers_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  remaining_seconds INTEGER NOT NULL CHECK (remaining_seconds >= 0),
  color TEXT NOT NULL,
  running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0,1)),
  checkpoint_at INTEGER,
  track_completions INTEGER NOT NULL DEFAULT 0 CHECK (track_completions IN (0,1)),
  daily_target INTEGER NOT NULL DEFAULT 1 CHECK (daily_target > 0),
  completed_today INTEGER NOT NULL DEFAULT 0 CHECK (completed_today >= 0),
  completion_date TEXT,
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);

INSERT INTO timers_next (id,space_id,name,duration_seconds,remaining_seconds,color,running,checkpoint_at,sort_order,deleted_at)
SELECT id,space_id,name,duration_seconds,remaining_seconds,color,running,checkpoint_at,sort_order,deleted_at FROM timers;

DROP TABLE timers;
ALTER TABLE timers_next RENAME TO timers;
CREATE UNIQUE INDEX idx_timers_space_sort_active ON timers(space_id, sort_order) WHERE deleted_at IS NULL;

PRAGMA optimize;
