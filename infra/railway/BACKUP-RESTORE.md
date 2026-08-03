# Postgres backup & restore runbook

How OpenAthlete's Postgres database is backed up, how long backups are kept, and
exactly how to restore one — including a restore drill you can run to prove a
backup is good **before** you need it in anger.

There are two places this project runs Postgres, and they are backed up
differently:

| Environment              | Postgres                                   | Backup mechanism |
| ------------------------ | ------------------------------------------ | ---------------- |
| Scaleway (managed infra) | `scaleway_rdb_instance` (Managed RDB, PG16) | **Scaleway managed automated backups** (Terraform) |
| Railway / self-hosted    | `pgvector/pgvector:pg16` container          | **Scheduled logical `pg_dump`** (`.github/workflows/db-backup.yml`) |

Both paths use the same portable scripts in [`../backup/`](../backup/) for manual
backups and for the restore drill:

- `infra/backup/pg-backup.sh` — take a compressed `pg_dump` custom-format backup and prune old ones.
- `infra/backup/restore-drill.sh` — restore a backup into a scratch database and verify integrity.

All they need is `postgresql-client` (`pg_dump` / `pg_restore` / `psql`, version
16 to match the server) and a `DATABASE_URL`.

---

## 1. How backups are taken & scheduled

### Scaleway Managed RDB (Terraform)

Managed backups are enabled directly on the instance in
[`../rdb.tf`](../rdb.tf):

```hcl
resource "scaleway_rdb_instance" "db" {
  # ...
  disable_backup            = false
  backup_schedule_frequency = var.db_backup_schedule_frequency # hours, default 24
  backup_schedule_retention = var.db_backup_schedule_retention # days,  default 7
  backup_same_region        = var.db_backup_same_region        # default true
}
```

Scaleway snapshots the whole instance on the schedule and automatically deletes
snapshots older than the retention window. Change the cadence/retention via the
`db_backup_schedule_frequency` / `db_backup_schedule_retention` variables (see
`../variables.tf`), then `tofu apply` (or `terraform apply`). For off-region
disaster-recovery copies, set `db_backup_same_region = false`.

You can also trigger and export backups on demand from the Scaleway console or
CLI (`scw rdb backup create` / `scw rdb backup export`).

### Railway / self-hosted (scheduled logical backup)

Railway's Postgres is a plain container with no managed backup service, so
logical dumps are taken by a scheduled GitHub Actions workflow:
[`../../.github/workflows/db-backup.yml`](../../.github/workflows/db-backup.yml).

- Runs **daily at 03:00 UTC** (`schedule`) and on demand (`workflow_dispatch`).
- Dumps the database, runs the restore drill against it, and uploads the dump as
  a workflow artifact retained for 7 days.
- **Skips cleanly** (does not fail) when the connection-string secret is absent,
  so it is safe to have enabled before the secret is configured.

Required repository secrets for the scheduled job to actually run:

| Secret                | Value |
| --------------------- | ----- |
| `BACKUP_DATABASE_URL` | Connection string to the production database, reachable from GitHub Actions. Railway's private `*.railway.internal` host is **not** reachable externally — use a Railway **TCP proxy** endpoint (Postgres service → Settings → Networking → TCP Proxy) or the `DATABASE_PUBLIC_URL` Railway exposes. |
| `BACKUP_ADMIN_URL`    | *(optional)* Same server, pointing at the `postgres` database, used by the in-workflow restore drill. Omit to skip the drill step. |

> Production-grade retention: GitHub artifacts are convenient and self-contained
> but capped at 90 days and not encrypted at rest by you. For long-term/off-site
> retention, add an upload step that pushes the dump to object storage
> (Scaleway Object Storage / any S3-compatible bucket) after the backup step.

### Manual / local backup

Against any environment (or the local docker-compose stack):

```bash
# Uses ./backups and 7-day pruning by default.
DATABASE_URL='postgresql://user:pass@host:5432/openathlete' \
  bash infra/backup/pg-backup.sh
```

Override the destination and retention with `BACKUP_DIR` and `RETENTION_DAYS`
(`RETENTION_DAYS=0` disables pruning). The script prints the path of the dump it
created on its last line.

---

## 2. Retention

| Backup type                 | Default retention | Where to change |
| --------------------------- | ----------------- | --------------- |
| Scaleway managed snapshots  | 7 days            | `db_backup_schedule_retention` in `../variables.tf` |
| Scheduled logical dumps     | 7 days (artifact) | `retention-days` in `db-backup.yml` |
| Manual/local `pg-backup.sh` | 7 days            | `RETENTION_DAYS` env var |

---

## 3. Restore procedure (step by step)

> Restoring **replaces data**. Restore into a fresh database first, verify, then
> cut over — never restore straight over a live database unless you have already
> accepted the data loss.

### From a Scaleway managed backup

1. In the Scaleway console (or CLI), pick the backup/snapshot to restore.
2. Restore it to a **new** RDB instance (`scw rdb backup restore` / console
   "Restore to a new instance"). This leaves the current instance untouched.
3. Verify the new instance (see the drill in §4, pointing `ADMIN_URL` at it).
4. Cut over by updating `DATABASE_URL` (the Terraform-managed Secret Manager
   value / the Railway variable) to the restored instance, then redeploy the API
   so it migrates/points at the restored database.

### From a logical dump (`.dump` file) — Railway / self-hosted / local

Prerequisite: `postgresql-client` v16 and the target connection string.

1. **Get the dump.** For a scheduled backup, download the artifact from the
   `Database backup` workflow run. For a manual backup, use the file
   `pg-backup.sh` produced.

2. **Create a fresh target database** on the server (do not drop the live one):

   ```bash
   psql "$ADMIN_URL" -c 'CREATE DATABASE openathlete_restored;'
   #   ADMIN_URL points at the server's default `postgres` database, e.g.
   #   postgresql://user:pass@host:5432/postgres
   ```

3. **Restore the dump** into it:

   ```bash
   pg_restore \
     --dbname='postgresql://user:pass@host:5432/openathlete_restored' \
     --no-owner --no-privileges --exit-on-error \
     openathlete-openathlete-<timestamp>.dump
   ```

   The dumps are `pg_dump` custom format (`-Fc`), so `pg_restore` can also
   restore selectively (`--table`, `--schema-only`, `--data-only`) and in
   parallel (`--jobs=N`).

4. **Verify** the restored database (row counts, key tables, app boot) — the
   restore drill in §4 automates exactly this.

5. **Cut over**: point `DATABASE_URL` at `openathlete_restored` (or rename the
   databases) and redeploy the API. On boot the entrypoint runs
   `prisma migrate deploy`, so the schema is reconciled automatically.

---

## 4. Restore drill (verify a backup is actually restorable)

Run this on a schedule and after any change to the backup pipeline. It restores a
dump into a throwaway scratch database **on the same server**, checks the dump
parses, confirms the expected tables exist and are populated, prints a row-count
report, and (optionally) diffs row counts against a live source database. The
scratch database is dropped again automatically (`KEEP_SCRATCH=1` to keep it).

```bash
# Drill the latest dump in ./backups against the local docker-compose Postgres:
ADMIN_URL='postgresql://openathlete:openathlete_dev_password@localhost:5433/postgres' \
EXPECTED_TABLES='User' \
  bash infra/backup/restore-drill.sh

# Or drill a specific dump, comparing against the live database:
ADMIN_URL='postgresql://user:pass@host:5432/postgres' \
VERIFY_SOURCE_URL='postgresql://user:pass@host:5432/openathlete' \
  bash infra/backup/restore-drill.sh path/to/openathlete-....dump
```

The `drill-selftest` job in `db-backup.yml` runs this end to end on every PR that
touches the backup tooling — it seeds an ephemeral Postgres, backs it up, and
restore-drills it, with **no secrets required** — so the scripts can never
silently rot.

### Example: a passing drill

Backing up a seeded database (5 `User` rows, 20 `Activity` rows) and drilling the
result:

```
==> Running pg-backup.sh
==> Backing up database 'openathlete' -> .../openathlete-openathlete-<ts>.dump
==> Backup complete (8.0K)
==> Running restore-drill.sh
==> Step 1: validate the dump is readable (pg_restore --list)
==> Step 2: (re)create scratch database 'openathlete_restore_drill'
==> Step 3: restore into scratch database
==> Step 4: verify expected tables exist and are populated
  [ OK ] table 'User': 5 rows
  [ OK ] table 'Activity': 20 rows
==> Scratch database contains 2 table(s) in schema 'public'.
==> Step 5: compare row counts against source database
  [ OK ] source and restored row counts match
==> RESTORE DRILL PASSED
```
