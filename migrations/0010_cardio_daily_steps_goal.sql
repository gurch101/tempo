ALTER TABLE spaces
ADD COLUMN cardio_daily_steps_goal INTEGER
CHECK (cardio_daily_steps_goal IS NULL OR cardio_daily_steps_goal BETWEEN 1 AND 1000000);
