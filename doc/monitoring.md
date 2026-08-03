# Monitoring & observability runbook

How OpenAthlete is observed in production: health checks, log shipping to Better Stack,
and the alerting policy. Deployment/provisioning itself is covered by
[`infra/railway/README.md`](../infra/railway/README.md).

## Health checks

| Endpoint            | Service | Checks                                   | Status codes                      |
| ------------------- | ------- | ---------------------------------------- | --------------------------------- |
| `GET /health`       | `api`   | process is alive (no dependencies)       | `200 {"status":"ok"}`             |
| `GET /health/ready` | `api`   | Postgres (`SELECT 1`) and Redis (`PING`) | `200` when ready, `503` when not  |
| `GET /healthz`      | `web`   | nginx is serving (static response)       | `200 {"status":"ok"}`             |

- The platform health check for `api` points at `/health` (liveness). It intentionally does
  **not** hit dependencies: a Postgres blip should not make Railway kill and restart the API.
- `/health/ready` is what uptime monitoring and manual triage use to tell "process alive" from
  "able to serve traffic". Each dependency check has a 3 s timeout, and the response body names
  the failing dependency:

  ```json
  {
    "status": "error",
    "uptime": 412,
    "checks": {
      "database": { "status": "up" },
      "redis": { "status": "down", "error": "unreachable" }
    }
  }
  ```

  The endpoint is unauthenticated, so the `error` field is always the constant
  `"unreachable"`; the driver message (which names hosts, ports and database
  names) is written to the API logs instead, and shipped to Better Stack.

- The `web` container is a static nginx SPA; `/healthz` is answered by nginx directly so
  monitoring never depends on the JS bundle.

Implementation: `apps/api/src/modules/health/*`, `apps/web/nginx.conf`.

## Logs → Better Stack

`apps/api/src/common/logging/*` installs a Nest logger that writes to stdout **and** batches
records to the Better Stack HTTP ingestion API (batches of up to 100 events, flushed every 2 s,
flushed again on `SIGTERM`/`SIGINT`). Ingestion failures are dropped with a single warning —
logging can never take the API down. When no credentials are resolved, Nest's default console
logger is used and nothing else changes.

Credentials are resolved in this order (see `better-stack.config.ts`):

1. `BETTER_STACK_SOURCE_TOKEN` + `BETTER_STACK_INGESTING_HOST` — a dedicated Better Stack log
   source (Telemetry → Sources → Configure). **Preferred in production.**
2. `BETTER_STACK_DSN` — the Sentry-compatible DSN already used for error tracking
   (`https://<token>@<host>/<source-id>`); the token and host are taken from it.

Optional: `BETTER_STACK_SERVICE_NAME` (default `openathlete-api`) is attached to every event,
alongside `environment` (from `NODE_ENV`), `level`, `context` and `stack`.

Errors and stack traces keep going to Better Stack error tracking through
`apps/api/src/instrument.ts` (Sentry SDK) and the browser through
`apps/web/src/utils/error-monitoring.ts`.

### Verifying

```bash
# From the api container / a shell with the API env loaded
curl -fsS "$API_URL/health" && curl -sS -o /dev/null -w '%{http_code}\n' "$API_URL/health/ready"

# Direct ingestion smoke test
curl -X POST "https://$BETTER_STACK_INGESTING_HOST" \
  -H "Authorization: Bearer $BETTER_STACK_SOURCE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dt":"'"$(date -u +'%Y-%m-%d %T UTC')"'","message":"ingestion smoke test"}'
```

Then check Better Stack → Live tail. If logs appear in stdout but not in Better Stack, look for
the `[BetterStack] dropping log batch` warning in the platform logs.

## Alerting

Uptime monitors are declared in
[`infra/monitoring/better-stack-monitors.json`](../infra/monitoring/better-stack-monitors.json)
and applied with an idempotent script (monitors are matched by URL: existing ones are patched,
missing ones created, none deleted):

```bash
BETTER_STACK_UPTIME_API_TOKEN=<uptime api token> \
API_URL=https://api.example.com \
WEB_URL=https://app.example.com \
node scripts/monitoring/apply-better-stack-monitors.mjs        # add --dry-run to preview
```

| Monitor                | Target              | Frequency | Fires after                     |
| ---------------------- | ------------------- | --------- | ------------------------------- |
| API liveness           | `/health` keyword   | 60 s      | 60 s of failures                |
| API readiness          | `/health/ready` 200 | 180 s     | 180 s of failures (deps down)   |
| Web availability       | `/healthz` 200      | 180 s     | 180 s of failures               |

Notifications go to the team's Better Stack on-call policy (email + push; SMS/calls off by
default). Change `email`/`sms`/`call`/`push` or set `policy_id` in the JSON to route elsewhere.

**Log-based alerts cannot be provisioned through the Uptime API** — create them once in
Better Stack Telemetry → Alerts, using the thresholds recorded under `logAlerts` in the same
JSON file:

- **API error rate** — `level:error` on source `openathlete-api`, more than 10 events in 5 min.
- **API log silence** — fewer than 1 event in 15 min (catches a crash-looping or wedged API).
- **Readiness degraded** — `message:"readiness check failed"`, more than 3 events in 10 min.

## Triage

1. **Liveness alert** — the process is down or unreachable. Check the platform deploy logs for a
   crash loop; `/health` has no dependencies, so a failure is the process or the network.
2. **Readiness alert, liveness OK** — a dependency is down. `curl $API_URL/health/ready` and read
   `checks.database` / `checks.redis`, then check the Postgres/Redis services.
3. **Error-rate alert** — open Better Stack Live tail filtered on `level:error` and the matching
   Better Stack error tracking issue for the stack trace.
4. **Web availability alert with API healthy** — the SPA container or its domain, not the backend.

## Required variables

| Variable                          | Service | Required | Purpose                                     |
| --------------------------------- | ------- | -------- | ------------------------------------------- |
| `BETTER_STACK_DSN`                | `api`   | no       | Error tracking + log shipping fallback      |
| `BETTER_STACK_SOURCE_TOKEN`       | `api`   | no       | Dedicated log source token                  |
| `BETTER_STACK_INGESTING_HOST`     | `api`   | no       | Dedicated log source ingesting host         |
| `BETTER_STACK_SERVICE_NAME`       | `api`   | no       | Service label on shipped logs               |
| `BETTER_STACK_UPTIME_API_TOKEN`   | —       | no       | Only for running the monitor apply script   |

None of them are required to boot: with all of them unset, the API logs to stdout only.
