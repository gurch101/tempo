ALTER TABLE google_health_connections ADD COLUMN sync_kind TEXT CHECK (sync_kind IN ('cardio','sleep'));
ALTER TABLE google_health_connections ADD COLUMN cardio_last_sync_at INTEGER;
ALTER TABLE google_health_connections ADD COLUMN cardio_last_sync_error TEXT;
ALTER TABLE google_health_connections ADD COLUMN sleep_last_sync_at INTEGER;
ALTER TABLE google_health_connections ADD COLUMN sleep_last_sync_error TEXT;

UPDATE google_health_connections
SET cardio_last_sync_at=last_sync_at,
    sleep_last_sync_at=last_sync_at;
