# Backup and restore

Railway's managed volume backups are not available on this workspace's plan, so the database is
backed up logically: a Railway **cron service** dumps Postgres once a day and uploads the dump to
the project's Railway bucket (S3-compatible object storage).

Everything lives in `infra/railway/backup/`. The same image performs backups and restores.

## The `backup` service

| Setting              | Value                                    |
| -------------------- | ---------------------------------------- |
| Source               | this repo, `infra/railway/backup/Dockerfile` |
| Config as code       | `infra/railway/backup.railway.json`      |
| Schedule             | `0 4 * * *` (daily, 04:00 UTC)           |
| Restart policy       | `NEVER` (a cron run is expected to exit) |

Cron services start on schedule, run once, and exit. A successful run exits `0`; a failed run is
reported as a crashed deployment in Railway and triggers the deployment-failure notification.

### Variables (production)

```
DATABASE_URL             = ${{postgres.DATABASE_URL}}
BUCKET_ENDPOINT          = https://t3.storageapi.dev      # from the bucket's Credentials tab
BUCKET_NAME              = <bucket name from the same tab>
BUCKET_REGION            = auto
BUCKET_URL_STYLE         = virtual-host
BUCKET_ACCESS_KEY_ID     = <secret>
BUCKET_SECRET_ACCESS_KEY = <secret>
BACKUP_PREFIX            = production
BACKUP_RETENTION_DAYS    = 14
```

Staging and PR previews have no bucket of their own and set `BACKUP_ENABLED=0`, which makes the
entrypoint exit `0` immediately instead of failing a nightly run.

### What a run does

1. `pg_dump --format=custom --compress=9` of `DATABASE_URL` into `/tmp`.
2. `PUT s3://<bucket>/<prefix>/<UTC timestamp>.dump`.
3. `PUT s3://<bucket>/<prefix>/latest` containing the key of the dump just written, so a restore
   never has to list the bucket.
4. Deletes dumps whose timestamp is older than `BACKUP_RETENTION_DAYS`.

Uploads use `curl --aws-sigv4` with the credentials passed through a config on stdin, so no S3 SDK
is needed in the image and the keys never appear in `argv`.

## Restore

The restore path is the same image with `MODE=restore`. It downloads a dump and runs
`pg_restore --clean --if-exists` into `TARGET_DATABASE_URL`.

| Variable              | Meaning                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `MODE=restore`        | run `restore.sh` instead of `backup.sh`                              |
| `TARGET_DATABASE_URL` | database to restore **into** (required)                              |
| `BACKUP_KEY`          | key to restore, e.g. `production/20260803T040000Z.dump`; defaults to the newest dump for `BACKUP_PREFIX` |
| `CREATE_TARGET_DB=1`  | drop and recreate the target database first (used for drills)        |

`pg_restore --clean` **destroys the contents of the target database**. Never point it at the live
database unless that is exactly what you intend.

### Restore drill (quarterly, and after any change to these scripts)

Restores into a scratch database next to the live one, so production is untouched:

1. In the Railway `backup` service (production), set:
   ```
   MODE                = restore
   CREATE_TARGET_DB    = 1
   TARGET_DATABASE_URL = <postgres DATABASE_URL with the database name replaced by restore_drill>
   ```
2. Deploy the service (Deployments → Redeploy). The run prints the key it restored and the row
   counts of the 15 largest tables — this is the evidence the drill worked.
3. Remove `MODE`, `CREATE_TARGET_DB` and `TARGET_DATABASE_URL` so the nightly backup resumes.
4. Drop the scratch database: `psql "$ADMIN_URL" -c 'DROP DATABASE restore_drill'`.

The same drill runs locally against any Postgres:

```sh
docker build -f infra/railway/backup/Dockerfile -t oa-backup .
docker run --rm \
  -e MODE=restore -e CREATE_TARGET_DB=1 \
  -e TARGET_DATABASE_URL='postgresql://user:pass@host:5432/restore_drill' \
  -e BUCKET_ENDPOINT=... -e BUCKET_NAME=... -e BUCKET_REGION=auto \
  -e BUCKET_ACCESS_KEY_ID=... -e BUCKET_SECRET_ACCESS_KEY=... \
  -e BACKUP_PREFIX=production \
  oa-backup
```

### Real disaster recovery

To restore production itself (data loss, bad migration):

1. Stop writes: scale the `api` service to 0 replicas.
2. Run the restore with `TARGET_DATABASE_URL = ${{postgres.DATABASE_URL}}` and the `BACKUP_KEY` you
   want (omit `CREATE_TARGET_DB`; `--clean --if-exists` replaces the objects in place).
3. Redeploy `api`. Its entrypoint runs `prisma migrate deploy`, so a dump taken on an older schema
   is migrated forward automatically.
4. Verify by signing in and checking recent data, then scale `api` back up.

Recovery point objective is 24 hours (the cron interval); recovery time objective is a few minutes
for a dump of this size.

## Verifying backups exist

Bucket contents are browsable in Railway (project → the bucket → Files), or from any machine with
the credentials:

```sh
printf 'user = "%s:%s"\n' "$BUCKET_ACCESS_KEY_ID" "$BUCKET_SECRET_ACCESS_KEY" |
  curl --config - --aws-sigv4 "aws:amz:auto:s3" \
    "https://$BUCKET_NAME.t3.storageapi.dev/?list-type=2&prefix=production/"
```

A missing dump for the current day means the nightly run failed — check the `backup` service's
deployment logs.

## Last verified

2026-08-03, on Railway against production:

```
04:45:08  Dumping database to /tmp/production-20260803T044508Z.dump
04:45:08  Dump size: 200.0K
04:45:08  Uploading s3://…/production/20260803T044508Z.dump
04:45:08  Pruning dumps older than 20260720T044508Z
04:45:08  Backup complete

04:50:24  Recreating scratch database restore_drill
04:50:24  Restoring s3://…/production/20260803T044508Z.dump
04:50:25  _prisma_migrations 73 | training_zone 10 | athlete 2 | user 2
04:50:25  Restore complete
```

The scratch database was dropped afterwards.
