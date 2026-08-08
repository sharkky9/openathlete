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
the **staging** environment and Railway deletes them when the PR closes. Production and staging
Postgres have volumes; preview databases are disposable.

**Invariant: a non-production environment holds no production credential.** Inheriting from
`staging` does not establish that on its own — it only means a preview gets whatever `staging`
happens to hold. `staging` was originally duplicated from `production` (step 7 of *Recreating the
project from scratch*), and the "replace every secret in it" half of that step was never done for
the third-party integrations, so staging and every preview built from it carried byte-identical
copies of the live production credentials (issue #47). Copies of a live secret cannot be rotated in
place, so they are deleted outright — see
[*Purging production credentials from non-production*](#purging-production-credentials-from-non-production)
below, which both enforces and verifies the invariant.

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
Only five variables are genuinely required: `ENV`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET_KEY`
(at least 32 characters) and `HASH_PEPPER`. `PORT` defaults to `3000`.

Every third-party credential (Strava, Polar, Garmin, Suunto, Brevo, OpenAI, Google Generative AI,
Stripe, Firebase, Better Stack…) is **optional**, as of PR #44. Leave one out and the API still
boots; the feature it powers stays dark and reports a clear error at request time. Placeholder
values are not needed and should not be used — an unset credential is the supported state. Values
that *are* supplied are still format-checked, so a typo in a URL or an email is still caught at boot.

PR #44 also added an `optional()` helper that treats an empty string as "not set" (`''` is coerced
to `undefined` before validation), because container runtimes routinely inject `VAR=` for a variable
nobody defined. So for every variable that helper wraps — the integration credentials and their
redirect/webhook URLs, `BREVO_FROM_EMAIL`, `FIREBASE_FUNCTIONS_URL`, `BETTER_STACK_DSN` — blank and
absent are equivalent. Three URL variables are the exception: `APP_URL`, `FRONTEND_URL` and
`REDIS_URL` still use a bare `.url().optional()`, so those must be omitted entirely rather than set
to `""`.

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

## Purging production credentials from non-production

**Invariant: no non-production Railway environment holds a production third-party credential.**
`staging` and every PR preview built from it should hold either their own sandbox credentials or
nothing at all. Nothing is *required* — PR #44 made every third-party credential optional, so an
environment without them boots fine and simply keeps those features dark.

The `Railway purge non-production secrets` workflow
(`.github/workflows/railway-purge-nonprod-secrets.yml`) enforces and verifies this. It runs
`infra/railway/purge-nonprod-secrets.mjs`, a dependency-free Node script that talks to Railway's
public GraphQL API (`https://backboard.railway.com/graphql/v2`) and deletes exactly seven variables:

`BREVO_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `STRAVA_CLIENT_SECRET`,
`STRAVA_WEBHOOK_TOKEN`, `POLAR_CLIENT_SECRET`, `POLAR_WEBHOOK_SECRET_KEY`.

These are *deleted*, not rotated: staging held byte-identical copies of the production values, and a
copy of a live secret cannot be rotated in place.

**How to dispatch.** Actions → *Railway purge non-production secrets* → *Run workflow*:

| Input | Default | Meaning |
| ----- | ------- | ------- |
| `dry_run` | `true` | Report what would be deleted and change nothing. |
| `environments` | `staging` | Comma-separated environment names. `production` is always refused. |

**Dry run first, always.** The default is a dry run on purpose. Read the plan it prints, confirm the
variable names are the ones you expect, then dispatch again with `dry_run` unticked. The job log is
the audit record.

Two guards are compiled into the script and **cannot be turned off from the workflow inputs**:

1. **Production is never touched.** Any target that resolves to `production` (or `prod`/`prd`, in
   any case, with any surrounding whitespace) aborts the entire run before anything is deleted. The
   check runs twice — once on the requested names, before the script even authenticates, and again
   on the names Railway itself returns, so a rename or an alias cannot slip past it.
2. **Only those seven names, and never `INTERVALS_ICU*`.** Deletion requires an exact match against
   the seven-name allow-list *and* a miss against an `INTERVALS_ICU` prefix deny-list (that
   credential belongs to another workstream). The two checks are independent, and both are
   re-asserted immediately before each delete call.

The script never prints a variable **value** — only names — because the job log must stay safe to
share and the repo's `Secret scan` check treats these as live credentials. It is idempotent:
deleting an already-absent variable is a logged no-op, so re-running it is harmless. After the purge
it re-queries Railway and prints the full variable-name listing per environment plus a `PASS`/`FAIL`
verdict, exiting non-zero if any of the seven survived.

It needs a `RAILWAY_TOKEN` repository secret — an account, workspace or project token with access to
this project. The script accepts either header shape (`Authorization: Bearer` for account/workspace
tokens, `Project-Access-Token` for project tokens) and probes for the right one. If the token can see
more than one Railway project it refuses to guess and asks for a `RAILWAY_PROJECT_ID` repository
variable.

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
7. Duplicate the environment to create `staging`, then **replace or delete every secret it
   inherited** — duplicating copies production's values verbatim, and skipping this step is exactly
   how issue #47 happened. Third-party credentials may simply be deleted; only `JWT_SECRET_KEY` and
   `HASH_PEPPER` must be replaced with fresh non-production values. Run the
   `Railway purge non-production secrets` workflow afterwards to confirm none survived. Then enable
   PR environments (project Settings → Environments) with `staging` as the base.

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| Deployment fails immediately with `service config at '…' not found` | The branch being deployed does not contain that config file — rebase the branch on `main`. |
| `web` crashes on boot with `host not found in upstream "api"` | nginx is resolving the API host at startup; `apps/web/Dockerfile` must keep `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1` and `nginx.conf` must proxy through a variable. |
| API healthy in logs but the domain 502s | The service's target port does not match `PORT`. The API listens on 3000, the web nginx on 80. |
| `api` boot fails validating the environment | One of the five required variables (`ENV`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET_KEY`, `HASH_PEPPER`) is missing or malformed, or `APP_URL`/`FRONTEND_URL`/`REDIS_URL` is set to an empty string — those three still reject `""`, so remove them instead. A missing third-party credential is never the cause; those are all optional. |
| Redis `NOAUTH`/auth failures | The start command must be wrapped in `sh -c` so `$REDIS_PASSWORD` expands. |
| Build rejected for a vulnerable dependency | Railway's build scanner blocks known CVEs; bump the dependency (this is why `apps/website` pins a patched `next`). |
