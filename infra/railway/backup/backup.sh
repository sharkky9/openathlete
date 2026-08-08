#!/bin/sh
# Dump the Postgres service and upload the dump to S3-compatible object storage.
#
# Required environment (see infra/railway/BACKUP-RESTORE.md):
#   DATABASE_URL            connection string of the database to dump
#   BUCKET_ENDPOINT         S3 endpoint, e.g. https://storage.railway.app
#   BUCKET_NAME             bucket to upload into
#   BUCKET_ACCESS_KEY_ID    S3 access key id
#   BUCKET_SECRET_ACCESS_KEY
# Optional:
#   BUCKET_REGION           default "auto"
#   BUCKET_URL_STYLE        "virtual-host" (default) or "path"
#   BACKUP_PREFIX           key prefix, default "$RAILWAY_ENVIRONMENT_NAME"
#   BACKUP_RETENTION_DAYS   delete older dumps, default 14 (0 disables pruning)
#   BACKUP_HEARTBEAT_URL    Better Stack heartbeat URL; unset disables the ping
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BUCKET_ENDPOINT:?BUCKET_ENDPOINT is required}"
: "${BUCKET_NAME:?BUCKET_NAME is required}"
: "${BUCKET_ACCESS_KEY_ID:?BUCKET_ACCESS_KEY_ID is required}"
: "${BUCKET_SECRET_ACCESS_KEY:?BUCKET_SECRET_ACCESS_KEY is required}"

REGION="${BUCKET_REGION:-auto}"
PREFIX="${BACKUP_PREFIX:-${RAILWAY_ENVIRONMENT_NAME:-production}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
case "${BUCKET_URL_STYLE:-virtual-host}" in
  path) BASE_URL="${BUCKET_ENDPOINT}/${BUCKET_NAME}" ;;
  *) BASE_URL="${BUCKET_ENDPOINT%%://*}://${BUCKET_NAME}.${BUCKET_ENDPOINT#*://}" ;;
esac
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="/tmp/${PREFIX}-${STAMP}.dump"

# curl's config parser treats \ and " inside a quoted value as escapes.
CURL_USER="$(printf '%s:%s' "$BUCKET_ACCESS_KEY_ID" "$BUCKET_SECRET_ACCESS_KEY" |
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"

s3() {
  # s3 <method> <key> [curl args...]
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

echo "Dumping database to ${DUMP}"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
echo "Dump size: $(du -h "$DUMP" | cut -f1)"

echo "Uploading s3://${BUCKET_NAME}/${PREFIX}/${STAMP}.dump"
s3 PUT "/${PREFIX}/${STAMP}.dump" --upload-file "$DUMP" >/dev/null
rm -f "$DUMP"

# Keep a pointer to the newest dump so restores don't have to list the bucket.
printf '%s' "${PREFIX}/${STAMP}.dump" >/tmp/latest
s3 PUT "/${PREFIX}/latest" --upload-file /tmp/latest >/dev/null

if [ "$RETENTION_DAYS" -gt 0 ]; then
  CUTOFF="$(date -u -d "@$(($(date -u +%s) - RETENTION_DAYS * 86400))" +%Y%m%dT%H%M%SZ)"
  echo "Pruning dumps older than ${CUTOFF}"
  # Listed separately so a failed listing fails the run instead of silently
  # pruning nothing.
  s3 GET "?list-type=2&prefix=${PREFIX}/" >/tmp/listing
  tr '<' '\n' </tmp/listing | sed -n 's|^Key>||p' |
    while read -r key; do
      key="${key#/}"
      name="${key##*/}"
      case "$name" in
        *.dump)
          if [ "${name%.dump}" \< "$CUTOFF" ]; then
            s3 DELETE "/${key}" >/dev/null
            echo "deleted ${key}"
          fi
          ;;
      esac
    done
fi

# A successful run pings a dead-man's switch. Keep this on the success path in
# backup.sh: BACKUP_ENABLED=0 exits before this script, so disabling or losing
# the cron is correctly detected as a missing heartbeat. A flaky monitoring
# endpoint does not invalidate an otherwise usable database backup.
HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-}"
if [ -n "$HEARTBEAT_URL" ]; then
  if curl --silent --show-error --fail --max-time 10 --retry 3 --retry-delay 2 \
    -o /dev/null "$HEARTBEAT_URL"; then
    echo "Heartbeat sent"
  else
    echo "Warning: backup succeeded but the heartbeat ping failed" >&2
  fi
fi

echo "Backup complete"
