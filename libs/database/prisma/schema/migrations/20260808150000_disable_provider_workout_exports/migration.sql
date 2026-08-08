-- OpenAthlete no longer writes planned workouts to external providers. Keep
-- existing accounts and newly-created Intervals.icu accounts aligned with that
-- product decision even if a stale listener or job reaches the database.
ALTER TABLE "provider_account"
ALTER COLUMN "export_workouts_enabled" SET DEFAULT false;

UPDATE "provider_account"
SET "export_workouts_enabled" = false
WHERE "export_workouts_enabled" = true;
