CREATE INDEX idx_food_logs_recent_food
ON food_log_entries(space_id, food_id, logged_at DESC)
WHERE meal_id IS NULL AND food_id IS NOT NULL;

CREATE INDEX idx_food_logs_recent_meal
ON food_log_entries(space_id, meal_id, logged_at DESC)
WHERE meal_id IS NOT NULL;

PRAGMA optimize;
