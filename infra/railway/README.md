# Railway deployment

Deployment configuration for running this fork of OpenAthlete on [Railway](https://railway.com).
Everything in this directory is deployment packaging only — no application behaviour is changed.

## Deployed environment

| Environment | Service | URL                                        |
| ----------- | ------- | ------------------------------------------ |
| production  | `web`   | https://ultracully.up.railway.app          |
| production  | `api`   | https://ultracully-api.up.railway.app      |

The Railway-generated subdomains were renamed to `ultracully*`; renaming the `api` domain requires a
`web` rebuild because `VITE_API_BASE_URL` is baked in at build time.

## Service topology (per environment)

| Railway service | Source                                      | Public | Notes                                              |
| --------------- | ------------------------------------------- | ------ | -------------------------------------------------- |
| `postgres`      | Docker image `pgvector/pgvector:pg16`       | no     | Volume at `/var/lib/postgresql/data`; `vector` extension is required by the Prisma migrations |
| `redis`         | Docker image `redis:7-alpine`               | no     | Volume at `/data`; used for BullMQ queues and the Socket.IO adapter |
| `api`           | This repo, `apps/api/Dockerfile`            | yes    | Runs `prisma migrate deploy` on boot, then the NestJS server; deploy health check on `/health/ready` (readiness: probes Postgres + Redis). `/health` stays as the plain liveness endpoint |
| `web`           | This repo, `apps/web/Dockerfile`            | yes    | nginx serving the built SPA on port `80`            |
| `backup`        | This repo, `infra/railway/backup/Dockerfile` | no    | Daily cron: dumps Postgres to the project bucket. See `BACKUP-RESTORE.md` |

The API and web services read their build/deploy settings from config as code:

- `infra/railway/api.railway.json`
- `infra/railway/web.railway.json`
- `infra/railway/backup.railway.json`

Set each service's *Config-as-code file path* (Settings → Config as code) to the matching file.

## Networking

- `api` and `web` each get a Railway domain (`*.up.railway.app`) with automatic HTTPS.
- `postgres` and `redis` are private only, reachable over Railway's private network at
  `<service>.railway.internal`.
- The SPA talks to the API directly over its public domain, so `web` needs
  `VITE_API_BASE_URL` **at build time** (Railway injects service variables as Docker build args;
  `apps/web/Dockerfile` already declares the matching `ARG`).
- `web` serves nginx on port 80, so the service sets `PORT=80` and its domain targets port 80.

## Variables

Use Railway variable references so every environment (production, staging, PR previews) resolves
its own values:

**api**

```
DATABASE_URL   = ${{postgres.DATABASE_URL}}
REDIS_URL      = ${{redis.REDIS_URL}}
APP_URL        = https://${{web.RAILWAY_PUBLIC_DOMAIN}}
FRONTEND_URL   = https://${{web.RAILWAY_PUBLIC_DOMAIN}}
CORS_ORIGINS   = https://${{web.RAILWAY_PUBLIC_DOMAIN}}
```

**web**

```
PORT               = 80
VITE_API_BASE_URL  = https://${{api.RAILWAY_PUBLIC_DOMAIN}}
```

The remaining variables are the ones validated by `libs/shared/src/types/config/environments/api.environment.ts`.
See `variables.env.example` for the full list. Secrets live in Railway only — never in this repo.

## Migrations

`apps/api/scripts/docker-entrypoint.sh` runs `prisma migrate deploy` before starting the server, so
every deployment migrates the database it is pointed at. No manual step is required.

## Pull request previews

PR environments are enabled on the `staging` environment, so previews inherit staging's variables and
get their own Postgres and Redis instances. Railway destroys the environment when the PR is merged or
closed.

Inheriting from `staging` is not by itself a guarantee that a preview holds no production
credential — it only means the preview gets whatever `staging` holds, and `staging` was duplicated
from `production` (issue #47). The invariant is enforced separately, by the
`Railway purge non-production secrets` workflow; see `OPERATIONS.md`.

## Related docs

- `OPERATIONS.md` — environments, local development, monitoring, recreating the project, troubleshooting.
- `BACKUP-RESTORE.md` — the nightly dump, the restore drill and disaster recovery.
- `../../.github/workflows/deployment-smoke.yml` — CI that builds both production images, runs the
  migrations and smoke-tests signup/login before a PR can merge.
