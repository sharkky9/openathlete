# Postgres backup & restore scripts

Portable, connection-string-driven helpers for backing up and restore-drilling
the OpenAthlete Postgres database. They work the same against the Railway
`postgres` service, Scaleway Managed RDB, and the local docker-compose stack —
all they need is `postgresql-client` (`pg_dump` / `pg_restore` / `psql`) and a
`DATABASE_URL`.

| Script             | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `pg-backup.sh`     | Take a compressed `pg_dump` custom-format backup, prune old ones. |
| `restore-drill.sh` | Restore a backup into a scratch DB and verify its integrity.   |

Full procedure, scheduling, retention and step-by-step restore instructions live
in the runbook: [`../railway/BACKUP-RESTORE.md`](../railway/BACKUP-RESTORE.md).
The scheduled automation is `.github/workflows/db-backup.yml`.
