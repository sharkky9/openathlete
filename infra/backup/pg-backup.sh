#!/usr/bin/env bash
#
# Take a logical backup of a PostgreSQL database and prune old backups.
#
# Portable across every place this repo runs Postgres: the Railway
# `postgres` service, Scaleway Managed RDB, and the local docker-compose
# stack. It only needs `pg_dump` on PATH and a connection string.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./pg-backup.sh
#   ./pg-backup.sh "postgresql://user:pass@host:5432/db"
#
# Environment:
#   DATABASE_URL     Connection string (or pass it as $1).
#   BACKUP_DIR       Where dumps are written. Default: ./backups
#   RETENTION_DAYS   Delete dumps older than this many days. Default: 7
#                    Set to 0 to disable pruning.
#
# Output:
#   $BACKUP_DIR/openathlete-<db>-<UTC timestamp>.dump   (pg_dump custom format)
#   The path of the dump just created is printed on the last stdout line.
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-${1:-}}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

if [[ -z "${DATABASE_URL}" ]]; then
  echo "ERROR: set DATABASE_URL (env var or first argument)." >&2
  exit 2
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on PATH. Install the postgresql-client package." >&2
  exit 2
fi

# Derive the database name from the URL for a friendly file name (default: db).
db_name="$(printf '%s' "${DATABASE_URL}" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
db_name="${db_name:-db}"

mkdir -p "${BACKUP_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
outfile="${BACKUP_DIR}/openathlete-${db_name}-${timestamp}.dump"

echo "==> Backing up database '${db_name}' -> ${outfile}"
# -Fc  custom format: compressed and restorable selectively with pg_restore.
# --no-owner / --no-privileges keeps the dump portable across users/roles,
# which matters when restoring into a scratch database owned by another role.
pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${outfile}"

size="$(du -h "${outfile}" | cut -f1)"
echo "==> Backup complete (${size})"

if [[ "${RETENTION_DAYS}" -gt 0 ]]; then
  echo "==> Pruning backups older than ${RETENTION_DAYS} day(s) in ${BACKUP_DIR}"
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'openathlete-*.dump' \
    -mtime "+${RETENTION_DAYS}" -print -delete || true
fi

# Machine-readable last line: the created dump path.
echo "${outfile}"
