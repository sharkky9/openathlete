---
name: testing-api-health-and-observability
description: How to boot the OpenAthlete API locally and runtime-test the health/readiness endpoints, the Better Stack log drain and the web nginx /healthz, without any third-party credentials.
---

# Testing the OpenAthlete API health / observability surface

## Booting the API locally (no third-party keys needed)

1. `source ~/.nvm/nvm.sh && nvm use 22` — the repo pins node 22.x / pnpm 9.15.9.
   `corepack enable` may fail with `Cannot find matching keyid` (corepack signature check against
   the npm registry). Workaround: `npm i -g pnpm@9.15.9`.
2. `pnpm install && pnpm shared run build && pnpm database run db:generate`
   (`@openathlete/shared` must be built or the API cannot resolve `@openathlete/shared`).
3. `docker compose up -d postgres redis` — **Postgres is on host port 5433**, Redis on 6379.
4. The API validates every env var via `ApiEnvSchema` and refuses to boot if one is missing.
   The quickest complete set is the one in `.github/workflows/deployment-smoke.yml`
   ("Start API container" step); just change `DATABASE_URL` to port 5433. Keep it in a file you can
   `source` (`export KEY=value` lines).
5. Run it: `pnpm api start`, or for repeatable restarts build once (`pnpm api build`) and then
   `setsid nohup node -r dotenv/config dist/main > /tmp/api.log 2>&1 &` from `apps/api`.
   Gotchas: plain `nohup ... &` inside a one-shot shell tool call often gets killed with the call —
   use `setsid`, and never `pkill` + start in the *same* command (the new process gets killed too).
   Boot takes ~25–40 s. Migrations are not required for `/health*`, but unmigrated tables cause
   noisy background Prisma errors in the log.

Endpoints (no global `/api` prefix): `GET /health`, `GET /health/ready`, Swagger at `/docs`.

The readiness response is intentionally **status-only** (`{"status":"ok"}` / `{"status":"error"}`);
per-dependency detail is logs-only, so assert on the HTTP code plus the *absence* of host/port/
dependency names in the body, and grep the API stdout for `readiness check failed` to confirm the
detail was moved to the logs rather than lost. Readiness is also cached (~5 s) and concurrent callers
share one in-flight check, so **poll** after `docker stop`/`start` instead of asserting on the first
response.

## Simulating dependency outages

`docker stop openathlete-redis` / `docker stop openathlete-postgres`, then re-hit
`/health/ready`. Always assert the **HTTP status code** (curl `-w "%{http_code}"`), not just the
body — the browser shows the JSON but not the 503.

Known behaviours to re-check on any change to `apps/api/src/modules/health/*`:
- The **first** readiness call after boot may return a spurious 503
  (`Stream isn't writeable and enableOfflineQueue options is false`) because the health Redis client
  uses `lazyConnect: true` + `enableOfflineQueue: false`. Poll twice before concluding.
- Readiness may **never recover** after Redis restarts (`Connection is closed.` forever) if the
  client sets `retryStrategy: () => null`. Verify recovery explicitly, and if it is stuck, restart
  the API to confirm the client — not Redis — is the cause.
- **Fire ~10 parallel readiness requests as the very first traffic after a cold boot**, not just one.
  A lazily connected Redis client can serve the first request fine and fail the rest with
  `Stream isn't writeable...` while the socket is still `connecting`; a single sequential request
  will not reveal it.
- The API **exits during boot if Redis is down** (QueueModule retries then terminates), so a
  Redis-down readiness test must stop Redis *after* a successful boot.
- Watch for empty log details: an ioredis `AggregateError [ECONNREFUSED]` has an empty `.message`, so
  a naive `error.message` logger prints `Redis readiness check failed:` with nothing after it. Check
  with `grep -A3 ... | cat -A` — the `[ioredis] Unhandled error event` lines that follow are a
  separate stderr dump, not the service's log record.

## Testing the Better Stack log drain without a real token

No real Better Stack credentials exist. Run a fake ingest instead:

1. `mkdir -p /tmp/ingest && openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/ingest/key.pem -out /tmp/ingest/cert.pem -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"`
   (the helpers below read the certs from `/tmp/ingest`, overridable with `INGEST_CERT_DIR`)
2. A small `https.createServer` on `127.0.0.1:8443` that logs method/path/`authorization`/body.
3. Boot the API with `BETTER_STACK_SOURCE_TOKEN=test-token`,
   `BETTER_STACK_INGESTING_HOST=127.0.0.1:8443`, `BETTER_STACK_SERVICE_NAME=...` and
   `NODE_TLS_REJECT_UNAUTHORIZED=0` (the shipper always POSTs to `https://<host>`).

Assert: JSON array batches (up to 100 events), `Authorization: Bearer <token>`, each event with
`dt/level/message/context/service/environment`. Point the host at a dead port (`127.0.0.1:9`) to
prove failures are swallowed. Also check `kill -TERM <pid>` both flushes **and** actually exits —
the shipper registers a `SIGTERM` listener, which can suppress Node's default terminate behaviour.

Useful techniques:
- Give the fake ingest a `DELAY_MS` env knob and respond slowly (1.5–2 s). Without it the 2 s flush
  timer empties the buffer before you can signal, and shutdown-drain tests silently pass with nothing
  to drain. With it you can prove multiple post-signal POSTs (e.g. 100 + 100 + 2 events).
- For memory/backpressure claims, import the **compiled** shipper from `apps/api/dist/common/logging`
  in a standalone `.mjs`, enqueue several thousand events synchronously against the slow ingest, and
  read `shipper.buffer.length` directly — it must stay at the cap (1000) and retain the *newest*
  events. Same trick with a stub `{ enqueue }` shipper isolates logger formatting (e.g. proving no
  event ships `"stack":"undefined"`).
- To test shutdown **bounds** (a drain must not outlive the platform's stop grace), point the shipper
  at a TLS "black-hole" server that accepts the request and never responds
  (`https.createServer(opts, (req) => req.resume()).listen(8444)`), fill the buffer to its cap, and
  time `await shipper.shutdown()`. Without a black hole you only exercise the fast-failure path
  (`ECONNREFUSED` returns immediately) and a missing deadline looks fine. Also check the opposite
  direction — a reachable-but-slow ingest must still get its batches, i.e. the deadline must not
  truncate a healthy drain.
- To prove new logs cannot stall shutdown, run a `setInterval` that keeps enqueueing while
  `shutdown()` is awaited, then assert every shipped event predates the shutdown (tag the messages).
- Level filtering: construct the logger, call `setLogLevels(['log','warn','error','fatal'])`, emit one
  record per level and assert `debug`/`verbose` reach neither the console nor the shipper.
- Blank-vs-absent credentials matter: test `BETTER_STACK_SOURCE_TOKEN=""` together with a
  `BETTER_STACK_DSN=https://<token>@<host>/1` and assert the ingest sees `Bearer <dsn-token>`, never
  a bare `Bearer `.
- If `main.ts` initialises the logger lazily (after Sentry's instrument hook), re-check that the very
  first shipped event is still `Starting Nest application...` — boot logs are easy to lose there.

Ready-made probes live in `helpers/` next to this file (run with node 22 after `pnpm api run build`;
they resolve `apps/api/dist` relative to the repo, override with `OA_API_DIST`):

| helper | what it proves |
|---|---|
| `blackhole.mjs` | TLS ingest on :8444 that never responds — forces the request-timeout path |
| `shutdown-probe.mjs <bounded\|flood> <host:port>` | fills the buffer to its cap and times `shutdown()`; `flood` keeps enqueueing during shutdown |
| `shipper-probe.mjs` | buffer cap / oldest-dropped under a slow ingest, plus `stack` formatting |
| `level-probe.mjs` | which levels are shipped with and without `setLogLevels()` |

## Testing web `/healthz` cheaply (no Vite build)

```
docker run -d --name oa-web-test -p 8080:80 \
  -e NGINX_ENVSUBST_FILTER='^(API_UPSTREAM|NGINX_LOCAL_RESOLVERS)$' \
  -e NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 -e API_UPSTREAM='http://127.0.0.1:3000' \
  -v $PWD/apps/web/nginx.conf:/etc/nginx/templates/default.conf.template:ro \
  -v /tmp/webroot:/usr/share/nginx/html:ro nginx:alpine
```
(`/tmp/webroot/index.html` can be a stub.) Then check `/healthz`, `/`, and an arbitrary SPA route.

## Monitors script

`API_URL=... WEB_URL=... node scripts/monitoring/apply-better-stack-monitors.mjs --dry-run`
needs no token; the non-dry-run path needs `BETTER_STACK_UPTIME_API_TOKEN`.

## Devin Secrets Needed

- `BETTER_STACK_SOURCE_TOKEN` + `BETTER_STACK_INGESTING_HOST` (or `BETTER_STACK_DSN`) — only to
  prove logs actually land in Better Stack; the fake-ingest approach above covers the wire contract.
- `BETTER_STACK_UPTIME_API_TOKEN` — only to test creating/patching real uptime monitors.
