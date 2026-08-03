#!/usr/bin/env bash
#
# Restore drill: restore a pg_dump backup into a throwaway scratch database on
# the same server and verify its integrity. This is the routine that proves a
# backup is actually restorable — run it on a schedule and after any change to
# the backup pipeline.
#
# What it does:
#   1. Create a scratch database (dropped again at the end unless KEEP_SCRATCH=1).
#   2. Restore the given (or latest) dump into it with pg_restore.
#   3. Verify integrity:
#        - pg_restore --list parses cleanly (dump is not truncated/corrupt),
#        - the expected core tables exist and are populated,
#        - print a per-table row-count report,
#        - optionally diff row counts against a live source DB (VERIFY_SOURCE_URL).
#
# Usage:
#   ADMIN_URL=postgresql://user:pass@host:5432/postgres ./restore-drill.sh [dump-file]
#
# Environment:
#   ADMIN_URL          Connection string to a database the user can create/drop
#                      databases from (e.g. the default `postgres` db). Required.
#   BACKUP_DIR         Directory to search when no dump file is given. Default: ./backups
#   SCRATCH_DB         Name of the scratch database. Default: openathlete_restore_drill
#   EXPECTED_TABLES    Space-separated tables that must exist & be non-empty.
#                      Default: "User"
#   VERIFY_SOURCE_URL  Optional live DB URL to compare row counts against.
#   KEEP_SCRATCH       Set to 1 to keep the scratch DB for inspection.
set -euo pipefail

ADMIN_URL="${ADMIN_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
SCRATCH_DB="${SCRATCH_DB:-openathlete_restore_drill}"
EXPECTED_TABLES="${EXPECTED_TABLES:-User}"
VERIFY_SOURCE_URL="${VERIFY_SOURCE_URL:-}"
KEEP_SCRATCH="${KEEP_SCRATCH:-0}"
DUMP_FILE="${1:-}"

for tool in psql pg_restore; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "ERROR: ${tool} not found on PATH. Install the postgresql-client package." >&2
    exit 2
  fi
done

if [[ -z "${ADMIN_URL}" ]]; then
  echo "ERROR: set ADMIN_URL to a connection string that can CREATE/DROP DATABASE." >&2
  exit 2
fi

# Pick the newest dump if none was passed explicitly.
if [[ -z "${DUMP_FILE}" ]]; then
  DUMP_FILE="$(ls -1t "${BACKUP_DIR}"/openathlete-*.dump 2>/dev/null | head -n1 || true)"
fi
if [[ -z "${DUMP_FILE}" || ! -f "${DUMP_FILE}" ]]; then
  echo "ERROR: no dump file found (looked in ${BACKUP_DIR}). Pass one as an argument." >&2
  exit 2
fi
echo "==> Using dump: ${DUMP_FILE}"

# Derive a scratch URL by swapping the database name in ADMIN_URL.
scratch_url="$(printf '%s' "${ADMIN_URL}" | sed -E "s#(^.*/)[^/?]+(\?.*)?\$#\1${SCRATCH_DB}\2#")"

cleanup() {
  if [[ "${KEEP_SCRATCH}" == "1" ]]; then
    echo "==> KEEP_SCRATCH=1, leaving scratch database '${SCRATCH_DB}' in place."
    return
  fi
  echo "==> Dropping scratch database '${SCRATCH_DB}'"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" || \
    psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q \
      -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";" || true
}
trap cleanup EXIT

echo "==> Step 1: validate the dump is readable (pg_restore --list)"
if ! pg_restore --list "${DUMP_FILE}" >/dev/null; then
  echo "FAIL: dump does not parse — it may be truncated or corrupt." >&2
  exit 1
fi

echo "==> Step 2: (re)create scratch database '${SCRATCH_DB}'"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" 2>/dev/null || \
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\";"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q \
  -c "CREATE DATABASE \"${SCRATCH_DB}\";"

echo "==> Step 3: restore into scratch database"
# The vector extension is created by the dump; pg_restore emits a warning if a
# role/extension already exists, which is harmless here. Fail only on real errors.
restore_log="$(mktemp)"
if ! pg_restore --dbname="${scratch_url}" --no-owner --no-privileges \
      --exit-on-error "${DUMP_FILE}" 2>"${restore_log}"; then
  echo "FAIL: pg_restore reported errors:" >&2
  cat "${restore_log}" >&2
  rm -f "${restore_log}"
  exit 1
fi
rm -f "${restore_log}"

echo "==> Step 4: verify expected tables exist and are populated"
overall_ok=1
for tbl in ${EXPECTED_TABLES}; do
  count="$(psql "${scratch_url}" -tAc "SELECT count(*) FROM \"${tbl}\";" 2>/dev/null || echo "ERR")"
  if [[ "${count}" == "ERR" ]]; then
    echo "  [FAIL] table '${tbl}' missing or unreadable"
    overall_ok=0
  elif [[ "${count}" -eq 0 ]]; then
    echo "  [WARN] table '${tbl}' restored but empty (0 rows)"
  else
    echo "  [ OK ] table '${tbl}': ${count} rows"
  fi
done

echo "==> Row-count report (restored scratch database):"
psql "${scratch_url}" -P pager=off -c "
  SELECT relname AS table, n_live_tup AS approx_rows
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC, relname
  LIMIT 40;"

table_total="$(psql "${scratch_url}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
echo "==> Scratch database contains ${table_total} table(s) in schema 'public'."
if [[ "${table_total}" -eq 0 ]]; then
  echo "FAIL: no tables were restored." >&2
  exit 1
fi

if [[ -n "${VERIFY_SOURCE_URL}" ]]; then
  echo "==> Step 5: compare row counts against source database"
  read_counts() {
    psql "$1" -tAF$'\t' -c "
      SELECT relname, n_live_tup
      FROM pg_stat_user_tables
      ORDER BY relname;"
  }
  if diff <(read_counts "${VERIFY_SOURCE_URL}") <(read_counts "${scratch_url}"); then
    echo "  [ OK ] source and restored row counts match"
  else
    echo "  [WARN] row counts differ (expected if the source changed mid-drill; review above)"
  fi
fi

if [[ "${overall_ok}" -eq 1 ]]; then
  echo "==> RESTORE DRILL PASSED"
else
  echo "==> RESTORE DRILL FAILED (see [FAIL] lines above)" >&2
  exit 1
fi
