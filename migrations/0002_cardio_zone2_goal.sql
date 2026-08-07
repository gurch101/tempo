ALTER TABLE spaces
ADD COLUMN cardio_zone2_goal_minutes INTEGER
CHECK (cardio_zone2_goal_minutes IS NULL OR cardio_zone2_goal_minutes BETWEEN 1 AND 10080);
