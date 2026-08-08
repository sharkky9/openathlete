# Operating this fork

How this fork is deployed, how to work on it, and what to do when something breaks. Deployment
details of the individual services are in `README.md`; backups are in `BACKUP-RESTORE.md`.

## Environments

| Environment | Web | API | Deploys from |
| ----------- | --- | --- | ------------ |
| production  | `ultracully.up.railway.app` | `ultracully-api.up.railway.app` | `main` |
| staging     | `web-staging-8be9.up.railway.app` | `api-staging-9005.up.railway.app` | `main` (or a branch you point it at) |
| PR preview  | `web-openathlete-pr-<n>.up.railway.app` | `api-openathlete-pr-<n>.up.railway.app` | the PR branch |

Each environment has its own `postgres`, `redis`, secrets and domains. Previews are created from
the **staging** environment, so they never see production credentials, and Railway deletes them
when the PR closes. Production and staging Postgres have volumes; preview databases are disposable.

## Local development

```sh
nvm use && corepack enable
pnpm install --frozen-lockfile
docker compose up -d postgres redis          # pgvector + redis
cp .env.example .env                         # then fill in the values below
pnpm database run db:generate
pnpm database run db:deploy                  # apply migrations
pnpm dev                                     # api on :3000, web on :5173
```

The API validates its whole environment at boot (`libs/shared/src/types/config/environments/api.environment.ts`).
Third-party integrations (Strava, Polar, Brevo, OpenAI, Stripe…) are required *variables*, not
required *accounts*: inert placeholder values are enough to boot, the corresponding features simply
stay dark. Optional URL variables must be omitted entirely rather than set to an empty string —
the Zod URL validator rejects `""`.

## Making a change

1. Branch, commit, push, open a PR against `main`.
2. The required workflows must pass: `Lint` (`pnpm lint`), `Type Check` (`pnpm tsc:check`),
   `Build` (API and web builds), `Tests` (the apps/api Jest suite) and
   `Deployment smoke test` (builds both images, runs migrations against pgvector, exercises signup
   and login, checks the SPA and its fallback route, and runs the Playwright golden path).
   See `doc/merge-policy.md` for the exact list of required status checks.
3. Railway builds a preview environment for the PR. Its URLs are posted on the PR by the Railway
   GitHub app; use them to test the change against a throwaway database.
4. Merge. Railway deploys `main` to production automatically; the API entrypoint runs
   `prisma migrate deploy` before the server starts.

Note that a preview only redeploys when the push touches a service's `watchPatterns`
(`infra/railway/api.railway.json`, `web.railway.json`). Deploy the service manually from the
Railway UI to pick up a change outside those paths.

## Monitoring

- **Health checks** — Railway polls `/health` on `api` and `/` on `web`; a deployment that fails
  its health check is not promoted, and the previous one keeps serving.
- **Logs** — build, deploy and runtime logs per service in the Railway UI (project → service →
  Deployments), or `railway logs`.
- **Metrics** — CPU, memory, network and disk per service on the project's Observability tab.
- **Alerts** — a workspace notification rule emails on `Deployment.failed` and
  `Deployment.crashed` for this project, excluding ephemeral (preview) environments. A failed
  nightly backup surfaces the same way, because the cron service exits non-zero.
  Threshold monitors on CPU/RAM require Railway's Pro plan; add a project webhook
  (Settings → Webhooks) if you want alerts routed to Slack or Discord instead of email.

## Recreating the project from scratch

1. Create a Railway project and connect the GitHub repo.
2. `postgres`: image `pgvector/pgvector:pg16`, volume on `/var/lib/postgresql/data`, variables
   `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`.
3. `redis`: image `redis:7-alpine`, volume on `/data`, start command
   `sh -c 'exec redis-server --bind :: --appendonly yes --dir /data --requirepass "$REDIS_PASSWORD"'`
   (Railway runs the command without a shell, so `redis-server --requirepass "$REDIS_PASSWORD"`
   alone would pass the literal string).
4. `api` and `web`: deploy from this repo, set *Config as code* to `infra/railway/api.railway.json`
   and `infra/railway/web.railway.json`, then set the variables from `variables.env.example`.
   `api` needs `PORT=3000`; `web` needs `PORT=80`.
5. Generate a domain for `api` and `web`.
6. `backup`: deploy from this repo with config `infra/railway/backup.railway.json` and the
   variables in `BACKUP-RESTORE.md`.
7. Duplicate the environment to create `staging`, replace every secret in it, and enable PR
   environments (project Settings → Environments) with `staging` as the base.

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| Deployment fails immediately with `service config at '…' not found` | The branch being deployed does not contain that config file — rebase the branch on `main`. |
| `web` crashes on boot with `host not found in upstream "api"` | nginx is resolving the API host at startup; `apps/web/Dockerfile` must keep `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1` and `nginx.conf` must proxy through a variable. |
| API healthy in logs but the domain 502s | The service's target port does not match `PORT`. The API listens on 3000, the web nginx on 80. |
| `api` boot fails validating the environment | A required variable is missing, or an optional URL variable is set to an empty string — remove it instead. |
| Redis `NOAUTH`/auth failures | The start command must be wrapped in `sh -c` so `$REDIS_PASSWORD` expands. |
| Build rejected for a vulnerable dependency | Railway's build scanner blocks known CVEs; bump the dependency (this is why `apps/website` pins a patched `next`). |
