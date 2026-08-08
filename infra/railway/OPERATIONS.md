# Operating this fork

How this fork is deployed, how to work on it, and what to do when something breaks. Deployment
details of the individual services are in `README.md`; backups are in `BACKUP-RESTORE.md`.

## Environments

| Environment | Web                                     | API                                     | Deploys from                         |
| ----------- | --------------------------------------- | --------------------------------------- | ------------------------------------ |
| production  | `ultracully.up.railway.app`             | `ultracully-api.up.railway.app`         | `main`                               |
| staging     | `web-staging-8be9.up.railway.app`       | `api-staging-9005.up.railway.app`       | `main` (or a branch you point it at) |
| PR preview  | `web-openathlete-pr-<n>.up.railway.app` | `api-openathlete-pr-<n>.up.railway.app` | the PR branch                        |

Each environment has its own `postgres`, `redis`, secrets and domains. Previews are created from
the **staging** environment and Railway deletes them when the PR closes. Production and staging
Postgres have volumes; preview databases are disposable.

**Invariant: a non-production environment holds no production credential.** Inheriting from
`staging` does not establish that on its own — it only means a preview gets whatever `staging`
happens to hold. `staging` was originally duplicated from `production` (step 7 of _Recreating the
project from scratch_), and the "replace every secret in it" half of that step was never done for
the third-party integrations, so staging and every preview built from it carried byte-identical
copies of the live production credentials (issue #47). Copies of a live secret cannot be rotated in
place, so they are deleted outright — see
[_Purging production credentials from non-production_](#purging-production-credentials-from-non-production)
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
that _are_ supplied are still format-checked, so a typo in a URL or an email is still caught at boot.

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

## Running Railway operations from CI

`.github/workflows/railway-ops.yml` ("Railway ops") runs Railway CLI operations from GitHub
Actions using the `RAILWAY_TOKEN` repository secret, so routine operations do not require anyone
to hold the Railway token on their laptop. It is **manual only** (`workflow_dispatch`) — it is an
operator tool, not a merge gate, and nothing about it runs on a push or a pull request.

Run it from **Actions → Railway ops → Run workflow**, or with the GitHub CLI:

```sh
gh workflow run railway-ops.yml -f operation=status -f environment=staging -f service=api
gh workflow run railway-ops.yml -f operation=list-variables -f environment=staging -f service=api
gh workflow run railway-ops.yml -f operation=redeploy -f environment=production -f service=api \
  -f confirm=production
```

| Input         | Values                                                 | Meaning                                                     |
| ------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `operation`   | `status`, `list-variables`, `set-variable`, `redeploy` | What to do. `status` and `list-variables` are read-only.    |
| `environment` | `staging`, `production`                                | Railway environment to act on. Defaults to `staging`.       |
| `service`     | `api`, `web`, `backup`, `postgres`, `redis`            | Railway service to act on. Defaults to `api`.               |
| `key`         | variable name                                          | `set-variable` only. Must match `^[A-Za-z_][A-Za-z0-9_]*$`. |
| `value`       | variable value                                         | `set-variable` only. Never printed — see below.             |
| `confirm`     | `production`                                           | Required to change production.                              |

Each operation maps to one Railway CLI command (verified against CLI `5.33.0`, which the workflow
pins):

| Operation        | Command                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `status`         | `railway status --environment <env>`                                                                        |
| `list-variables` | `railway variable list --service <svc> --environment <env> --json`, of which only the **names** are printed |
| `set-variable`   | `railway variable set <KEY> --stdin --service <svc> --environment <env>`                                    |
| `redeploy`       | `railway redeploy --service <svc> --environment <env> --yes`                                                |

### The production confirmation

Anything that can change an environment — `set-variable` and `redeploy` — refuses to run against
`production` unless the `confirm` input is typed as exactly `production`. A mis-selected dropdown
therefore cannot quietly change production: the run fails validation before the Railway CLI is even
installed. The read-only operations (`status`, `list-variables`) need no confirmation, and
`staging` needs none either.

### What the workflow will not print

- The `value` input is passed to the CLI **on stdin** (`--stdin`), so it never appears in a command
  line, a shell trace or an error message.
- The value is also registered with `::add-mask::`, but that is defence in depth, not the control:
  the workflow simply never prints it. `set-variable` confirms `Set <KEY> on <service> in <env>`
  and nothing more. The CLI's own output is shown only when it does not contain the value.
- `list-variables` prints names only. `--json` and `--kv` both emit raw values, so the CLI output
  goes to a file under `RUNNER_TEMP` that is deleted at the end of the step and never displayed;
  the names are read out of it with `jq`. If the names cannot be parsed, the step fails rather than
  dumping the file.
- The job declares `permissions: {}` — it needs no `GITHUB_TOKEN` scope at all — and does not check
  the repository out. The Railway token is set only on the steps that call the CLI, so an `npm`
  install script cannot see it.
- Dispatch inputs are passed to the scripts as environment variables and never interpolated into a
  shell command, so a crafted `key`/`value` cannot inject one.

**The `value` box is not a secret channel.** GitHub records dispatch inputs with the workflow run
and does not treat them as secrets. Use it for ordinary configuration; set genuinely sensitive
values (database URLs, API keys) in the Railway dashboard, or add them as repository secrets and
reference them from the workflow.

### Limits worth knowing

- A Railway **project token** — which is what the CLI reads `RAILWAY_TOKEN` as — is scoped to a
  single environment in a single project. The `environment` dropdown cannot escape that scope: if
  the secret holds a `staging` token, `environment: production` will fail at the API, which is a
  useful safety property but also means covering both environments needs a token per environment
  (or a workspace token in `RAILWAY_API_TOKEN`, which the workflow does not currently read).
- Setting a variable triggers a redeployment of that service; the workflow does not pass
  `--skip-deploys`. Use `redeploy` afterwards only if you skipped it deliberately.
- Service names are case-sensitive and must match the Railway project exactly (`api`, `web`,
  `postgres`, `redis`, `backup`).
- The CLI version is pinned in the workflow's `RAILWAY_CLI_VERSION`. Bump it deliberately and
  re-check the flags above, which come from `railway <command> --help` at that version.
- To require a second pair of eyes, create a GitHub Environment named `production` with required
  reviewers and add `environment: ${{ inputs.environment }}` to the job.

## Monitoring

- **Health checks** — Railway polls `/health/ready` on `api` and `/` on `web`; a deployment that
  fails its health check is not promoted, and the previous one keeps serving. `/health/ready` is
  the deploy gate: it returns 200 only once Postgres and Redis both answer, so a build that boots
  but cannot reach its dependencies never takes over from a working one. `/health` remains the
  plain liveness endpoint ("the process is up and serving HTTP") and is what the CI smoke tests
  poll. Readiness answers `{"status":"ok"}` / `{"status":"error"}` and nothing else — which
  dependency failed is in the API logs (`readiness check failed`), not in the response body.
- **Logs** — build, deploy and runtime logs per service in the Railway UI (project → service →
  Deployments), or `railway logs`.
- **Metrics** — CPU, memory, network and disk per service on the project's Observability tab.
- **Alerts** — a workspace notification rule emails on `Deployment.failed` and
  `Deployment.crashed` for this project, excluding ephemeral (preview) environments. A failed
  nightly backup surfaces the same way, because the cron service exits non-zero.
  Better Stack independently polls the production API's `/health/ready` and the production web
  root every three minutes, and emails when either stays unavailable. It also runs a daily backup
  heartbeat with a three-hour grace period, so a cron that silently stops running alerts even when
  Railway has no failed deployment to report.
  Threshold monitors on CPU/RAM require Railway's Pro plan; add a project webhook
  (Settings → Webhooks) if you want alerts routed to Slack or Discord instead of email.

The desired Better Stack resources are reconciled by a dependency-free script. Dry-run is safe and
needs no credentials:

```sh
API_URL=https://ultracully-api.up.railway.app \
WEB_URL=https://ultracully.up.railway.app \
node scripts/monitoring/apply-better-stack-monitors.mjs --dry-run
```

To apply, create a Better Stack Uptime API token (the Logs/Error Tracking source token is not
accepted), export it as `BETTER_STACK_UPTIME_API_TOKEN`, and run with `--apply`. Set
`BACKUP_HEARTBEAT_URL_OUTPUT` to a private local path to capture the heartbeat ping URL with mode
`0600`; the URL is deliberately never printed. Copy it to the production `backup` service as the
secret `BACKUP_HEARTBEAT_URL`. The default alert channel is account email; opt into SMS, calls, or
push with the documented environment variables in the script header. Do not create monitors for
staging or preview environments.

## Purging production credentials from non-production

**Invariant: no non-production Railway environment holds a production third-party credential.**
`staging` and every PR preview built from it should hold either their own sandbox credentials or
nothing at all. Nothing is _required_ — PR #44 made every third-party credential optional, so an
environment without them boots fine and simply keeps those features dark.

The `Railway purge non-production secrets` workflow
(`.github/workflows/railway-purge-nonprod-secrets.yml`) enforces and verifies this. It runs
`infra/railway/purge-nonprod-secrets.mjs`, a dependency-free Node script that talks to Railway's
public GraphQL API (`https://backboard.railway.com/graphql/v2`) and deletes exactly seven variables:

`BREVO_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `STRAVA_CLIENT_SECRET`,
`STRAVA_WEBHOOK_TOKEN`, `POLAR_CLIENT_SECRET`, `POLAR_WEBHOOK_SECRET_KEY`.

These are _deleted_, not rotated: staging held byte-identical copies of the production values, and a
copy of a live secret cannot be rotated in place.

**How to dispatch.** Actions → _Railway purge non-production secrets_ → _Run workflow_:

| Input          | Default   | Meaning                                                                                                         |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `dry_run`      | `true`    | Report what would be deleted and change nothing.                                                                |
| `environments` | `staging` | Comma-separated environment names. `production` is always refused.                                              |
| `project_id`   | _(blank)_ | Railway project id. Takes precedence over the `RAILWAY_PROJECT_ID` repository variable; blank falls back to it. |

**Dry run first, always.** The default is a dry run on purpose. Read the plan it prints, confirm the
variable names are the ones you expect, then dispatch again with `dry_run` unticked. The job log is
the audit record.

Two guards are compiled into the script and **cannot be turned off from the workflow inputs**:

1. **Production is never touched.** Any target that resolves to `production` (or `prod`/`prd`, in
   any case, with any surrounding whitespace) aborts the entire run before anything is deleted. The
   check runs twice — once on the requested names, before the script even authenticates, and again
   on the names Railway itself returns, so a rename or an alias cannot slip past it.
2. **Only those seven names, and never `INTERVALS_ICU*`.** Deletion requires an exact match against
   the seven-name allow-list _and_ a miss against an `INTERVALS_ICU` prefix deny-list (that
   credential belongs to another workstream). The two checks are independent, and both are
   re-asserted immediately before each delete call.

The script never prints a variable **value** — only names — because the job log must stay safe to
share and the repo's `Secret scan` check treats these as live credentials. It is idempotent:
deleting an already-absent variable is a logged no-op, so re-running it is harmless. After the purge
it re-queries Railway and prints the full variable-name listing per environment plus a `PASS`/`FAIL`
verdict, exiting non-zero if any of the seven survived.

It needs a `RAILWAY_TOKEN` repository secret — an account, workspace or project token with access to
this project. The script accepts either header shape (`Authorization: Bearer` for account/workspace
tokens, `Project-Access-Token` for project tokens) and probes for the right one.

**The project id has to be supplied.** The first real dispatch (run `31241554634`, a dry run against
`staging`) established that the token authenticates fine — `me` answers — but Railway's root
`projects` query then returns an empty list, which is what it looks like when the project belongs to
a workspace rather than to the token owner directly. The script now tries a workspace-scoped query
as a fallback, but that is best-effort and may find nothing. Treat supplying the id as the normal
path: paste it into the `project_id` dispatch input, or set it once as the `RAILWAY_PROJECT_ID`
repository variable (Settings → Secrets and variables → Actions → Variables). The input wins over the
variable, and either one skips discovery entirely. The id is in the Railway project URL and under
project Settings → General. Nothing was read or deleted in that run; the purge itself has still never
executed against Railway.

## Recreating the project from scratch

1. Create a Railway project and connect the GitHub repo.
2. `postgres`: image `pgvector/pgvector:pg16`, volume on `/var/lib/postgresql/data`, variables
   `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`.
3. `redis`: image `redis:7-alpine`, volume on `/data`, start command
   `sh -c 'exec redis-server --bind :: --appendonly yes --dir /data --requirepass "$REDIS_PASSWORD"'`
   (Railway runs the command without a shell, so `redis-server --requirepass "$REDIS_PASSWORD"`
   alone would pass the literal string).
4. `api` and `web`: deploy from this repo, set _Config as code_ to `infra/railway/api.railway.json`
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

| Symptom                                                             | Cause / fix                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment fails immediately with `service config at '…' not found` | The branch being deployed does not contain that config file — rebase the branch on `main`.                                                                                                                                                                                                                                               |
| `web` crashes on boot with `host not found in upstream "api"`       | nginx is resolving the API host at startup; `apps/web/Dockerfile` must keep `NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1` and `nginx.conf` must proxy through a variable.                                                                                                                                                                         |
| API healthy in logs but the domain 502s                             | The service's target port does not match `PORT`. The API listens on 3000, the web nginx on 80.                                                                                                                                                                                                                                           |
| `api` boot fails validating the environment                         | One of the five required variables (`ENV`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET_KEY`, `HASH_PEPPER`) is missing or malformed, or `APP_URL`/`FRONTEND_URL`/`REDIS_URL` is set to an empty string — those three still reject `""`, so remove them instead. A missing third-party credential is never the cause; those are all optional. |
| Redis `NOAUTH`/auth failures                                        | The start command must be wrapped in `sh -c` so `$REDIS_PASSWORD` expands.                                                                                                                                                                                                                                                               |
| Build rejected for a vulnerable dependency                          | Railway's build scanner blocks known CVEs; bump the dependency (this is why `apps/website` pins a patched `next`).                                                                                                                                                                                                                       |
