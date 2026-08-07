ALTER TABLE spaces
ADD COLUMN sleep_goal_minutes INTEGER
CHECK (sleep_goal_minutes IS NULL OR sleep_goal_minutes BETWEEN 1 AND 1440);

ALTER TABLE spaces
ADD COLUMN sleep_goal_start_time TEXT
CHECK (sleep_goal_start_time IS NULL OR sleep_goal_start_time GLOB '[0-2][0-9]:[0-5][0-9]');
