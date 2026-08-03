#!/bin/sh
# Restore a dump produced by backup.sh into TARGET_DATABASE_URL.
#
#   BACKUP_KEY=production/20260803T040000Z.dump \
#   TARGET_DATABASE_URL=postgresql://... \
#     /usr/local/bin/restore.sh
#
# BACKUP_KEY defaults to the newest dump for BACKUP_PREFIX.
# The target database is dropped and recreated (pg_restore --clean --if-exists),
# so never point this at production without meaning to.
set -eu

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${BUCKET_ENDPOINT:?BUCKET_ENDPOINT is required}"
: "${BUCKET_NAME:?BUCKET_NAME is required}"
: "${BUCKET_ACCESS_KEY_ID:?BUCKET_ACCESS_KEY_ID is required}"
: "${BUCKET_SECRET_ACCESS_KEY:?BUCKET_SECRET_ACCESS_KEY is required}"

REGION="${BUCKET_REGION:-auto}"
PREFIX="${BACKUP_PREFIX:-${RAILWAY_ENVIRONMENT_NAME:-production}}"
case "${BUCKET_URL_STYLE:-virtual-host}" in
  path) BASE_URL="${BUCKET_ENDPOINT}/${BUCKET_NAME}" ;;
  *) BASE_URL="${BUCKET_ENDPOINT%%://*}://${BUCKET_NAME}.${BUCKET_ENDPOINT#*://}" ;;
esac

s3() {
  method="$1"
  key="$2"
  shift 2
  curl --fail --silent --show-error \
    --aws-sigv4 "aws:amz:${REGION}:s3" \
    --user "${BUCKET_ACCESS_KEY_ID}:${BUCKET_SECRET_ACCESS_KEY}" \
    --request "$method" \
    "$@" \
    "${BASE_URL}${key}"
}

# Restore drills target a scratch database that does not exist yet.
if [ "${CREATE_TARGET_DB:-0}" = "1" ]; then
  TARGET_DB="${TARGET_DATABASE_URL##*/}"
  TARGET_DB="${TARGET_DB%%\?*}"
  ADMIN_URL="${TARGET_DATABASE_URL%/*}/postgres"
  echo "Recreating scratch database ${TARGET_DB}"
  psql --quiet --dbname="$ADMIN_URL" --command="DROP DATABASE IF EXISTS \"${TARGET_DB}\""
  psql --quiet --dbname="$ADMIN_URL" --command="CREATE DATABASE \"${TARGET_DB}\""
fi

KEY="${BACKUP_KEY:-$(s3 GET "/${PREFIX}/latest")}"
echo "Restoring s3://${BUCKET_NAME}/${KEY}"
s3 GET "/${KEY}" --output /tmp/restore.dump

pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$TARGET_DATABASE_URL" /tmp/restore.dump
rm -f /tmp/restore.dump

echo "Restored contents:"
psql --quiet --dbname="$TARGET_DATABASE_URL" --command="
  SELECT relname AS table, n_live_tup AS rows
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC, relname
  LIMIT 15"

echo "Restore complete"
