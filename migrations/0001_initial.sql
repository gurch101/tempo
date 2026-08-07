PRAGMA foreign_keys = ON;

CREATE TABLE spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_key_hash TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  write_token TEXT NOT NULL DEFAULT '',
  write_token_at INTEGER,
  timezone TEXT NOT NULL,
  strength_unit TEXT NOT NULL DEFAULT 'lb' CHECK (strength_unit = 'lb'),
  active_mesocycle_id INTEGER REFERENCES mesocycles(id) ON DELETE SET NULL,
  nutrition_calories REAL CHECK (nutrition_calories IS NULL OR nutrition_calories >= 0),
  nutrition_carbs REAL CHECK (nutrition_carbs IS NULL OR nutrition_carbs >= 0),
  nutrition_protein REAL CHECK (nutrition_protein IS NULL OR nutrition_protein >= 0),
  nutrition_fats REAL CHECK (nutrition_fats IS NULL OR nutrition_fats >= 0),
  nutrition_fibre REAL CHECK (nutrition_fibre IS NULL OR nutrition_fibre >= 0),
  finance_display_currency TEXT NOT NULL DEFAULT 'CAD' CHECK (finance_display_currency GLOB '[A-Z][A-Z][A-Z]'),
  walkthrough_status TEXT NOT NULL DEFAULT 'completed' CHECK (walkthrough_status IN ('pending', 'completed', 'dismissed'))
);

CREATE TABLE timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  remaining_seconds INTEGER NOT NULL CHECK (remaining_seconds >= 0),
  daily_goal_seconds INTEGER NOT NULL DEFAULT 0 CHECK (daily_goal_seconds >= 0),
  color TEXT NOT NULL,
  running INTEGER NOT NULL DEFAULT 0 CHECK (running IN (0,1)),
  checkpoint_at INTEGER,
  track_completions INTEGER NOT NULL DEFAULT 1 CHECK (track_completions IN (0,1)),
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);
CREATE TABLE timer_schedule_days (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  timer_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY (space_id, timer_id, weekday),
  FOREIGN KEY (space_id, timer_id) REFERENCES timers(space_id, id) ON DELETE CASCADE
);
CREATE TABLE timer_daily_logs (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  timer_id INTEGER NOT NULL,
  log_date TEXT NOT NULL CHECK (log_date GLOB '????-??-??'),
  name_snapshot TEXT NOT NULL,
  color_snapshot TEXT NOT NULL,
  daily_goal_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (daily_goal_snapshot >= 0),
  spent_seconds INTEGER NOT NULL DEFAULT 0 CHECK (spent_seconds >= 0),
  completions INTEGER NOT NULL DEFAULT 0 CHECK (completions >= 0),
  PRIMARY KEY (space_id, log_date, timer_id),
  FOREIGN KEY (space_id, timer_id) REFERENCES timers(space_id, id)
);

CREATE TABLE habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('counter','toggle')),
  goal REAL NOT NULL CHECK (goal > 0),
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);
CREATE TABLE habit_schedule_days (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  habit_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY (space_id, habit_id, weekday),
  FOREIGN KEY (space_id, habit_id) REFERENCES habits(space_id, id) ON DELETE CASCADE
);
CREATE TABLE habit_daily_logs (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  habit_id INTEGER NOT NULL,
  log_date TEXT NOT NULL CHECK (log_date GLOB '????-??-??'),
  name_snapshot TEXT NOT NULL,
  color_snapshot TEXT NOT NULL,
  kind_snapshot TEXT NOT NULL CHECK (kind_snapshot IN ('counter','toggle')),
  goal_snapshot REAL NOT NULL CHECK (goal_snapshot > 0),
  value REAL NOT NULL DEFAULT 0 CHECK (value >= 0),
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  PRIMARY KEY (space_id, log_date, habit_id),
  FOREIGN KEY (space_id, habit_id) REFERENCES habits(space_id, id)
);
CREATE TABLE foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  serving_size REAL NOT NULL CHECK (serving_size > 0),
  serving_unit TEXT NOT NULL,
  calories REAL NOT NULL DEFAULT 0 CHECK (calories >= 0),
  carbs REAL NOT NULL DEFAULT 0 CHECK (carbs >= 0),
  protein REAL NOT NULL DEFAULT 0 CHECK (protein >= 0),
  fats REAL NOT NULL DEFAULT 0 CHECK (fats >= 0),
  fibre REAL NOT NULL DEFAULT 0 CHECK (fibre >= 0),
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);
CREATE TABLE meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);
CREATE TABLE meal_items (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  meal_id INTEGER NOT NULL,
  food_id INTEGER NOT NULL,
  serving_size REAL NOT NULL CHECK (serving_size > 0),
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (space_id, meal_id, sort_order),
  FOREIGN KEY (space_id, meal_id) REFERENCES meals(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, food_id) REFERENCES foods(space_id, id)
);
CREATE TABLE food_log_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL CHECK (log_date GLOB '????-??-??'),
  food_id INTEGER,
  meal_id INTEGER,
  serving_size REAL NOT NULL CHECK (serving_size > 0),
  logged_at INTEGER NOT NULL,
  meal_title_snapshot TEXT NOT NULL DEFAULT '',
  title_snapshot TEXT NOT NULL,
  serving_size_snapshot REAL NOT NULL CHECK (serving_size_snapshot > 0),
  serving_unit_snapshot TEXT NOT NULL,
  calories_snapshot REAL NOT NULL CHECK (calories_snapshot >= 0),
  carbs_snapshot REAL NOT NULL CHECK (carbs_snapshot >= 0),
  protein_snapshot REAL NOT NULL CHECK (protein_snapshot >= 0),
  fats_snapshot REAL NOT NULL CHECK (fats_snapshot >= 0),
  fibre_snapshot REAL NOT NULL CHECK (fibre_snapshot >= 0),
  FOREIGN KEY (space_id, food_id) REFERENCES foods(space_id, id),
  FOREIGN KEY (space_id, meal_id) REFERENCES meals(space_id, id)
);

CREATE TABLE workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);
CREATE TABLE workout_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  workout_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  muscle_group TEXT NOT NULL,
  planned_sets INTEGER NOT NULL CHECK (planned_sets > 0),
  planned_reps REAL NOT NULL CHECK (planned_reps >= 0),
  planned_load REAL NOT NULL CHECK (planned_load >= 0),
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id),
  FOREIGN KEY (space_id, workout_id) REFERENCES workouts(space_id, id) ON DELETE CASCADE
);
CREATE TABLE mesocycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  progression_rate REAL NOT NULL CHECK (progression_rate >= 0),
  sort_order INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, id)
);
CREATE TABLE mesocycle_workouts (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  mesocycle_id INTEGER NOT NULL,
  workout_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (space_id, mesocycle_id, sort_order),
  UNIQUE (space_id, mesocycle_id, workout_id),
  FOREIGN KEY (space_id, mesocycle_id) REFERENCES mesocycles(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, workout_id) REFERENCES workouts(space_id, id)
);
CREATE TABLE mesocycle_weeks (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  mesocycle_id INTEGER NOT NULL,
  week_index INTEGER NOT NULL CHECK (week_index >= 0),
  deload INTEGER NOT NULL DEFAULT 0 CHECK (deload IN (0,1)),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  PRIMARY KEY (space_id, mesocycle_id, week_index),
  FOREIGN KEY (space_id, mesocycle_id) REFERENCES mesocycles(space_id, id) ON DELETE CASCADE
);
CREATE TABLE workout_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  mesocycle_id INTEGER NOT NULL,
  workout_id INTEGER,
  name_snapshot TEXT NOT NULL,
  week_index INTEGER NOT NULL CHECK (week_index >= 0),
  session_date TEXT NOT NULL CHECK (session_date GLOB '????-??-??'),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in-progress','completed')),
  unit TEXT NOT NULL DEFAULT 'lb' CHECK (unit = 'lb'),
  sort_order INTEGER NOT NULL,
  UNIQUE (space_id, id),
  FOREIGN KEY (space_id, mesocycle_id) REFERENCES mesocycles(space_id, id),
  FOREIGN KEY (space_id, workout_id) REFERENCES workouts(space_id, id)
);
CREATE TABLE session_exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL,
  source_exercise_id INTEGER,
  name_snapshot TEXT NOT NULL,
  muscle_group_snapshot TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'external' CHECK (mode IN ('external','bodyweight')),
  bodyweight_factor REAL NOT NULL DEFAULT 1 CHECK (bodyweight_factor >= 0),
  sort_order INTEGER NOT NULL,
  UNIQUE (space_id, id),
  FOREIGN KEY (space_id, session_id) REFERENCES workout_sessions(space_id, id) ON DELETE CASCADE,
  FOREIGN KEY (space_id, source_exercise_id) REFERENCES workout_exercises(space_id, id)
);
CREATE TABLE session_exercise_allocations (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  session_exercise_id INTEGER NOT NULL,
  name_snapshot TEXT NOT NULL,
  share REAL NOT NULL CHECK (share >= 0),
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (space_id, session_exercise_id, sort_order),
  FOREIGN KEY (space_id, session_exercise_id) REFERENCES session_exercises(space_id, id) ON DELETE CASCADE
);
CREATE TABLE exercise_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  session_exercise_id INTEGER NOT NULL,
  reps REAL NOT NULL DEFAULT 0 CHECK (reps >= 0),
  load REAL NOT NULL DEFAULT 0 CHECK (load >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (space_id, session_exercise_id) REFERENCES session_exercises(space_id, id) ON DELETE CASCADE
);

CREATE TABLE google_health_connections (
  space_id INTEGER PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  sync_started_at INTEGER,
  last_sync_error TEXT
);
CREATE TABLE google_health_oauth_states (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL PRIMARY KEY,
  capability_ciphertext TEXT NOT NULL,
  capability_iv TEXT NOT NULL,
  redirect_origin TEXT NOT NULL,
  return_hash TEXT NOT NULL DEFAULT 'cardio',
  expires_at INTEGER NOT NULL
);
CREATE TABLE cardio_resting_heart_rates (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  recorded_date TEXT NOT NULL CHECK (recorded_date GLOB '????-??-??'),
  beats_per_minute INTEGER NOT NULL CHECK (beats_per_minute > 0),
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, recorded_date)
);
CREATE TABLE cardio_daily_steps (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  recorded_date TEXT NOT NULL CHECK (recorded_date GLOB '????-??-??'),
  step_count INTEGER NOT NULL CHECK (step_count >= 0),
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, recorded_date)
);
CREATE TABLE cardio_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  google_data_point_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL CHECK (end_time >= start_time),
  active_duration_seconds REAL NOT NULL CHECK (active_duration_seconds >= 0),
  average_heart_rate INTEGER CHECK (average_heart_rate IS NULL OR average_heart_rate > 0),
  minimum_heart_rate INTEGER CHECK (minimum_heart_rate IS NULL OR minimum_heart_rate > 0),
  maximum_heart_rate INTEGER CHECK (maximum_heart_rate IS NULL OR maximum_heart_rate > 0),
  calories_kcal REAL CHECK (calories_kcal IS NULL OR calories_kcal >= 0),
  distance_meters REAL CHECK (distance_meters IS NULL OR distance_meters >= 0),
  steps INTEGER CHECK (steps IS NULL OR steps >= 0),
  light_zone_seconds REAL NOT NULL DEFAULT 0 CHECK (light_zone_seconds >= 0),
  moderate_zone_seconds REAL NOT NULL DEFAULT 0 CHECK (moderate_zone_seconds >= 0),
  vigorous_zone_seconds REAL NOT NULL DEFAULT 0 CHECK (vigorous_zone_seconds >= 0),
  peak_zone_seconds REAL NOT NULL DEFAULT 0 CHECK (peak_zone_seconds >= 0),
  google_updated_at INTEGER,
  heart_rate_synced_at INTEGER,
  synced_at INTEGER NOT NULL,
  UNIQUE (space_id, google_data_point_name),
  UNIQUE (space_id, id)
);
CREATE TABLE cardio_heart_rate_chunks (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  samples_json TEXT NOT NULL CHECK (json_valid(samples_json)),
  PRIMARY KEY (space_id, session_id, chunk_index),
  FOREIGN KEY (space_id, session_id) REFERENCES cardio_sessions(space_id, id) ON DELETE CASCADE
);

CREATE TABLE sleep_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  google_data_point_name TEXT NOT NULL,
  sleep_date TEXT NOT NULL CHECK (sleep_date GLOB '????-??-??'),
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL CHECK (end_time >= start_time),
  minutes_asleep INTEGER NOT NULL CHECK (minutes_asleep >= 0),
  is_nap INTEGER NOT NULL DEFAULT 0 CHECK (is_nap IN (0, 1)),
  synced_at INTEGER NOT NULL,
  UNIQUE (space_id, google_data_point_name),
  UNIQUE (space_id, id)
);
CREATE TABLE sleep_stages (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL,
  stage_type TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL CHECK (end_time >= start_time),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  PRIMARY KEY (space_id, session_id, sort_order),
  FOREIGN KEY (space_id, session_id) REFERENCES sleep_sessions(space_id, id) ON DELETE CASCADE
);

CREATE TABLE finance_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('STOCK', 'CASH')),
  symbol TEXT,
  native_currency TEXT CHECK (native_currency IS NULL OR native_currency GLOB '[A-Z][A-Z][A-Z]'),
  display_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  CHECK ((asset_type = 'STOCK' AND symbol IS NOT NULL) OR (asset_type = 'CASH' AND symbol IS NULL AND native_currency IS NOT NULL))
);
CREATE TABLE finance_quotes (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  native_currency TEXT NOT NULL CHECK (native_currency GLOB '[A-Z][A-Z][A-Z]'),
  market_price REAL NOT NULL CHECK (market_price >= 0),
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, symbol)
);
CREATE TABLE finance_daily_prices (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  native_currency TEXT NOT NULL CHECK (native_currency GLOB '[A-Z][A-Z][A-Z]'),
  price_date TEXT NOT NULL CHECK (price_date GLOB '????-??-??'),
  close_price REAL NOT NULL CHECK (close_price >= 0),
  PRIMARY KEY (space_id, symbol, price_date)
);
CREATE TABLE finance_fx_quotes (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL CHECK (from_currency GLOB '[A-Z][A-Z][A-Z]'),
  to_currency TEXT NOT NULL CHECK (to_currency GLOB '[A-Z][A-Z][A-Z]'),
  exchange_rate REAL NOT NULL CHECK (exchange_rate > 0),
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, from_currency, to_currency)
);
CREATE TABLE finance_daily_fx_rates (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  from_currency TEXT NOT NULL CHECK (from_currency GLOB '[A-Z][A-Z][A-Z]'),
  to_currency TEXT NOT NULL CHECK (to_currency GLOB '[A-Z][A-Z][A-Z]'),
  rate_date TEXT NOT NULL CHECK (rate_date GLOB '????-??-??'),
  exchange_rate REAL NOT NULL CHECK (exchange_rate > 0),
  PRIMARY KEY (space_id, from_currency, to_currency, rate_date)
);

CREATE TABLE space_walkthrough_pages (
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page TEXT NOT NULL CHECK (page IN ('nutrition','strength','cardio','sleep','finances','settings')),
  status TEXT NOT NULL CHECK (status IN ('completed','dismissed')),
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, page)
);

CREATE TRIGGER spaces_active_mesocycle_insert_guard
BEFORE INSERT ON spaces
WHEN NEW.active_mesocycle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM mesocycles
    WHERE id = NEW.active_mesocycle_id AND space_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'active mesocycle must belong to the space');
END;

CREATE TRIGGER spaces_active_mesocycle_update_guard
BEFORE UPDATE OF active_mesocycle_id ON spaces
WHEN NEW.active_mesocycle_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM mesocycles
    WHERE id = NEW.active_mesocycle_id AND space_id = NEW.id
  )
BEGIN
  SELECT RAISE(ABORT, 'active mesocycle must belong to the space');
END;

CREATE TRIGGER mesocycles_space_update_guard
BEFORE UPDATE OF space_id ON mesocycles
WHEN NEW.space_id <> OLD.space_id
  AND EXISTS (
    SELECT 1 FROM spaces
    WHERE id = OLD.space_id AND active_mesocycle_id = OLD.id
  )
BEGIN
  SELECT RAISE(ABORT, 'active mesocycle cannot move to another space');
END;

CREATE UNIQUE INDEX idx_timers_space_sort_active ON timers(space_id, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_habits_space_sort_active ON habits(space_id, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_foods_space_sort_active ON foods(space_id, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_meals_space_sort_active ON meals(space_id, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_workouts_space_sort_active ON workouts(space_id, sort_order) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_mesocycles_space_sort_active ON mesocycles(space_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX idx_food_logs_space_date ON food_log_entries(space_id, log_date, logged_at, id);
CREATE INDEX idx_workout_exercises_space_order_active ON workout_exercises(space_id, workout_id, sort_order, id) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_space_order ON workout_sessions(space_id, mesocycle_id, sort_order, id);
CREATE INDEX idx_session_exercises_space_order ON session_exercises(space_id, session_id, sort_order, id);
CREATE INDEX idx_exercise_sets_space_order ON exercise_sets(space_id, session_exercise_id, sort_order, id);
CREATE INDEX idx_google_oauth_states_expiry ON google_health_oauth_states(expires_at);
CREATE INDEX idx_google_oauth_states_space ON google_health_oauth_states(space_id);
CREATE INDEX idx_cardio_sessions_space_start ON cardio_sessions(space_id, start_time DESC);
CREATE INDEX idx_sleep_sessions_space_order ON sleep_sessions(space_id, sleep_date, start_time, id);
CREATE UNIQUE INDEX idx_finance_holdings_unique_stock ON finance_holdings(space_id, symbol) WHERE asset_type = 'STOCK';
CREATE INDEX idx_finance_holdings_space_order ON finance_holdings(space_id, asset_type DESC, symbol, native_currency, id);
CREATE INDEX idx_spaces_active_mesocycle ON spaces(active_mesocycle_id) WHERE active_mesocycle_id IS NOT NULL;

PRAGMA optimize;
