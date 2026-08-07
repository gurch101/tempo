ALTER TABLE timers ADD COLUMN pomodoro INTEGER NOT NULL DEFAULT 0 CHECK (pomodoro IN (0,1));
ALTER TABLE timers ADD COLUMN rest_duration_seconds INTEGER NOT NULL DEFAULT 300 CHECK (rest_duration_seconds > 0);
ALTER TABLE timers ADD COLUMN phase TEXT NOT NULL DEFAULT 'work' CHECK (phase IN ('work','rest'));
ALTER TABLE timers ADD COLUMN countdown_beeps INTEGER NOT NULL DEFAULT 0 CHECK (countdown_beeps IN (0,1));
