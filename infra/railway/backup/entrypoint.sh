#!/bin/sh
# Dispatch between the scheduled backup and an on-demand restore drill.
# Set MODE=restore (plus TARGET_DATABASE_URL) on the Railway service to run a
# restore instead of a backup on the next deploy.
set -eu

case "${MODE:-backup}" in
  # A restore is always explicitly requested, so BACKUP_ENABLED does not gate it.
  restore) exec /usr/local/bin/restore.sh ;;
  *)
    # Environments without their own bucket (staging, PR previews) opt out of the
    # nightly run entirely rather than failing it.
    if [ "${BACKUP_ENABLED:-1}" != "1" ]; then
      echo "BACKUP_ENABLED=${BACKUP_ENABLED:-1}; nothing to do in ${RAILWAY_ENVIRONMENT_NAME:-this environment}"
      exit 0
    fi
    exec /usr/local/bin/backup.sh
    ;;
esac
