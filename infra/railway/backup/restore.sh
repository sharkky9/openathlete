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

# curl's config parser treats \ and " inside a quoted value as escapes.
CURL_USER="$(printf '%s:%s' "$BUCKET_ACCESS_KEY_ID" "$BUCKET_SECRET_ACCESS_KEY" |
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"

s3() {
  # sh has no locals, so the prefixed names keep callers' variables intact.
  # Credentials go in through a config on stdin so they never reach argv.
  s3_method="$1"
  s3_key="$2"
  shift 2
  printf 'user = "%s"\n' "$CURL_USER" |
    curl --config - --fail --silent --show-error \
      --aws-sigv4 "aws:amz:${REGION}:s3" \
      --request "$s3_method" \
      "$@" \
      "${BASE_URL}${s3_key}"
}

# Restore drills target a scratch database that does not exist yet.
if [ "${CREATE_TARGET_DB:-0}" = "1" ]; then
  TARGET_DB="${TARGET_DATABASE_URL##*/}"
  TARGET_DB="${TARGET_DB%%\?*}"
  ADMIN_URL="${TARGET_DATABASE_URL%/*}/postgres"
  # The name is interpolated into DDL, so refuse anything that could end the identifier.
  case "$TARGET_DB" in
    '' | *[!A-Za-z0-9_-]*)
      echo "Refusing to create database '${TARGET_DB}': name must match [A-Za-z0-9_-]+" >&2
      exit 1
      ;;
  esac
  echo "Recreating scratch database ${TARGET_DB}"
  psql --quiet --dbname="$ADMIN_URL" --command="DROP DATABASE IF EXISTS \"${TARGET_DB}\""
  psql --quiet --dbname="$ADMIN_URL" --command="CREATE DATABASE \"${TARGET_DB}\""
fi

KEY="${BACKUP_KEY:-$(s3 GET "/${PREFIX}/latest")}"
echo "Restoring s3://${BUCKET_NAME}/${KEY}"
s3 GET "/${KEY}" --output /tmp/restore.dump

# --exit-on-error: pg_restore otherwise ignores failed statements and still exits 0,
# which would report a half-loaded database as a clean restore.
pg_restore --clean --if-exists --exit-on-error --no-owner --no-privileges \
  --dbname="$TARGET_DATABASE_URL" /tmp/restore.dump
rm -f /tmp/restore.dump

echo "Restored contents:"
psql --quiet --dbname="$TARGET_DATABASE_URL" --command="
  SELECT relname AS table, n_live_tup AS rows
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC, relname
  LIMIT 15"

echo "Restore complete"
