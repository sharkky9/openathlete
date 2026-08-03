#!/bin/sh
# Dispatch between the scheduled backup and an on-demand restore drill.
# Set MODE=restore (plus TARGET_DATABASE_URL) on the Railway service to run a
# restore instead of a backup on the next deploy.
set -eu

# Environments without their own bucket (staging, PR previews) opt out entirely
# rather than failing a nightly run.
if [ "${BACKUP_ENABLED:-1}" != "1" ]; then
  echo "BACKUP_ENABLED=${BACKUP_ENABLED:-1}; nothing to do in ${RAILWAY_ENVIRONMENT_NAME:-this environment}"
  exit 0
fi

case "${MODE:-backup}" in
  restore) exec /usr/local/bin/restore.sh ;;
  *) exec /usr/local/bin/backup.sh ;;
esac
