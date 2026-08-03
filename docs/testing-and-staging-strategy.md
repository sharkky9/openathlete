# Testing, test data and staging strategy

Status: **partly provisioned.** The deployed infrastructure this document used to *propose* now
exists — a persistent `staging` environment and PR preview environments for every pull request are
both live on Railway (verified against the Railway API on 2026-08-03; see §1). What remains a
proposal is the *testing* work itself (automated tests, seed/QA scripts, guardrails); those sections
are still marked **proposal**. One finding from verifying the live state needs the owner's attention
before anything else — see the box immediately below.

> ### ⚠️ Finding: staging and every PR preview run with production third-party credentials
>
> `staging` was created by duplicating `production`, and PR previews inherit `staging`'s variables.
> `HASH_PEPPER` and `JWT_SECRET_KEY` **were** regenerated (good — production JWTs are useless on
> staging). But the following are **byte-identical to production** on `staging` and therefore on
> every preview (verified on the `api` service of `production`, `staging`, and the live
> `openathlete-pr-13` preview): `BREVO_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
> `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_TOKEN`, `POLAR_CLIENT_SECRET`, `POLAR_WEBHOOK_SECRET_KEY`.
> The OAuth *client IDs* (`STRAVA_CLIENT_ID`, `POLAR_CLIENT_ID`) and `STRIPE_SECRET_KEY` are the
> documented `unconfigured` placeholders in both, so the connector authorization flows cannot
> complete — but the shared keys above are single-key credentials that **do** work: a publicly
> reachable `*.up.railway.app` preview can send real email through the production Brevo account,
> spend against the production OpenAI/Google keys, and validate webhooks with the production signing
> secrets. This contradicts the isolation rule in `infra/railway/variables.env.example`
> ("generate per environment, never reuse across environments"). It is tracked separately as its own
> issue; this document does not fix it.

## Why this exists

The Railway deployment (`infra/railway/`) began with a single `production` environment. End-to-end
validation of that first deployment was done by creating a real account and a real training event
**in the production database**, because there was nowhere else to do it. That gap is now largely
closed at the infrastructure layer: a `staging` environment and per-PR previews exist. What is still
missing is the *testing* on top of them — no browser-level automated tests, no unit/integration
tests, and no disciplined test-data lifecycle. This document describes the environments as they now
are and proposes the testing and guardrail work that should sit on them, grounded in what is
actually in this repo.

## 1. Current state (inventory)

### Deployment

The Railway project `openathlete` (`58b68b8d-c6f2-49d2-bbd6-e7eff26a7294`, a personal account, no
team) now has three kinds of environment. This was read from the Railway API on 2026-08-03:

| Environment | Kind | Services | Public URLs | Notes |
| --- | --- | --- | --- | --- |
| `production` | persistent | `web`, `api`, `postgres`, `redis`, **`backup`** | `ultracully.up.railway.app` (web), `ultracully-api.up.railway.app` (api) | The only environment with the `backup` service. |
| `staging` | persistent | `web`, `api`, `postgres`, `redis` | Railway-generated `*.up.railway.app` (see the Railway dashboard / the PR's `railway-app` deploy comment) | All four deploys green. `ENV=staging`. No `backup` service. Deploys `main`. |
| `openathlete-pr-<N>` | ephemeral | `web`, `api`, `postgres`, `redis` | Railway-generated per-PR `*.up.railway.app` | One per open PR. Own empty Postgres/Redis volumes. `ENV=staging` (inherited). No `backup`. Railway destroys it when the PR closes. |

Project flags: `prDeploys: true` and `botPrEnvironments: true`, with `staging` as the preview base —
so previews are on for **every** PR, Devin's included, not opt-in. At the time of writing the live
preview was `openathlete-pr-13`; an earlier `openathlete-pr-5-…` preview had already been created
and auto-destroyed (it lived ~67 minutes), confirming the teardown-on-close behaviour.

Other deployment plumbing (unchanged):

| Thing | Where | Notes |
| --- | --- | --- |
| Service config as code | `infra/railway/api.railway.json`, `infra/railway/web.railway.json` | Dockerfile builder, health checks, `watchPatterns` (docs-only pushes deploy as `SKIPPED`, no rebuild) |
| Migrations on boot | `apps/api/scripts/docker-entrypoint.sh` | `prisma migrate deploy` before the server starts |
| Local stack | `docker-compose.yml` | pgvector pg16 + redis 7 + api + web, dev secrets inline |

### CI (`.github/workflows/`)

| Workflow | Triggers | What it does |
| --- | --- | --- |
| `lint.yml` | push/PR to `main`, `develop` | `pnpm lint` |
| `type-check.yml` | push/PR to `main`, `develop` | `pnpm tsc:check` |
| `build.yml` | push/PR to `main`, `develop` | builds api + web |
| `deployment-smoke.yml` | push/PR to `main` | builds both **production** images, boots the API against ephemeral pgvector/redis services, asserts `/health`, asserts `Migrations completed successfully`, then `POST /user` + `POST /auth/login`; separately builds the web image and asserts the SPA and its history fallback are served |

### Automated tests

There are **zero** test files in the repo — no `*.spec.ts`, no `*.test.ts(x)`, no Playwright/Cypress
config. Despite that:

- `apps/api/package.json` already carries a full Jest config (`testRegex: .*\.spec\.ts$`,
  `ts-jest`, `@nestjs/testing`, `supertest`) but has **no `test` script**, so the
  `cd apps/api && pnpm test` instruction in `CONTRIBUTING.md` fails today.
- `apps/web` has no test runner at all (no Vitest / Testing Library).
- The only executable behavioural check in CI is the signup/login curl in `deployment-smoke.yml`.

### Test data / seeding

- `libs/database/scripts/seed-demo-month.ts`, run via `pnpm database run db:seed:demo-month`.
- It upserts `demo@openathlete.local` (+ two coached athletes `coached1+…`, `coached2+…`) and seeds
  September/October **2025** — the year and month are hard-coded constants.
- The demo user is created with `password: "demo-hash"`, which is not an Argon2 hash, so **you
  cannot log in as the seeded demo user**. It is a data-shape fixture, not a QA account.
- There is no `prisma.seed` entry, no teardown/reset path other than `db:reset`
  (`prisma migrate reset`, destructive), and nothing that identifies "test data" as such.
- The API does expose self-serve deletion: `DELETE /user`
  (`apps/api/src/modules/auth/controllers/user.controller.ts`), JWT-guarded, cascading to the
  athlete profile, events, training data, messages and relationships. That is the cleanup primitive
  we should build on.

### Guardrails

Still **none**, even though staging and previews are now live and publicly reachable. `ENV` accepts
`staging` (`libs/shared/src/types/config/environment.enum.ts`) and staging/previews correctly run
with `ENV=staging`, but nothing in the SPA reads it — the web build has no visible environment
marker, there is no `robots.txt` (`apps/web/public/` contains only icons and the manifest) and no
`X-Robots-Tag` in `apps/web/nginx.conf`. Signup is open on every environment, and the
`*.up.railway.app` staging/preview URLs are reachable by anyone who has the link with no basic-auth
or allowlist. The guardrail proposals in §5 are therefore now the most urgent part of this document,
not a future nicety.

## 2. Environments

### The three tiers (two now exist)

1. **Ephemeral CI (exists, extend it).** `deployment-smoke.yml` spins up real pg + redis and the
   real production images per PR. This is the cheapest, most isolated place to run functional and
   browser tests. **Most automated end-to-end testing should live here, not on a deployed
   environment.** Still to do: add the Playwright/integration jobs described in §4.
2. **Persistent `staging` Railway environment — exists.** A second environment in the same Railway
   project, duplicated from `production`, with its **own** `postgres` and `redis` services and
   volumes, its own regenerated `HASH_PEPPER`/`JWT_SECRET_KEY`, and `ENV=staging`. It serves
   its own Railway-generated `*.up.railway.app` domains (no custom domain) and
   tracks `main`. Purpose: manual/exploratory QA, demoing, verifying migrations against a database
   with history, and reproducing prod-like issues. **Caveat:** its third-party credentials are the
   production ones, not placeholders — see the finding at the top of this document.
3. **Railway PR previews on top of `staging` — exist, for every PR.** `prDeploys` and
   `botPrEnvironments` are both on, so opening any PR (including Devin's) creates an
   `openathlete-pr-<N>` environment that is a throwaway copy of `staging` with its own empty
   Postgres/Redis, and Railway destroys it when the PR closes. This is no longer opt-in; the old
   "previews only, by label" option (previously open decision Q2) has been decided in the direction
   of *all PRs*.

### How previews actually behave (verified, not predicted)

The earlier draft *predicted* three things about previews; all three are now confirmed against the
running `staging` and `openathlete-pr-13` environments:

- **`VITE_API_BASE_URL` is a build-time arg** (`apps/web/Dockerfile` `ARG VITE_API_BASE_URL`), so
  the `web` image must be built per environment once the api domain is known. Railway does build
  `web` and `api` separately per environment (each environment shows its own `web`/`api` deploy),
  and `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` resolves per environment — so it works, at the cost
  of a full `web`+`api` Docker build per new preview. Observed first-build times on staging were
  ~100 s (api) and ~55 s (web). This is a latency driver more than a money driver (see §Cost); note
  that `watchPatterns` mean a docs-only push deploys as `SKIPPED` with **no** rebuild.
- **Databases are self-hosted containers with volumes**, not a managed add-on. Each preview gets its
  own empty Postgres and Redis volume, so previews start with **no data** and only the schema that
  `prisma migrate deploy` creates on boot. Confirmed: `openathlete-pr-13` has its own `postgres` and
  `redis` service instances. Previews therefore have nothing to test against unless seeded (§3).
- **Secrets *are* inherited from production — and that is the finding.** Duplicating `production`
  into `staging` copied its variables. `HASH_PEPPER` and `JWT_SECRET_KEY` were regenerated (verified
  different from production), but `BREVO_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_TOKEN`, `POLAR_CLIENT_SECRET` and `POLAR_WEBHOOK_SECRET_KEY`
  were **not** — they are identical to production on staging and on the preview. Only the OAuth
  client IDs and `STRIPE_SECRET_KEY` remain at their `unconfigured`/`sk_test_unconfigured`
  placeholders. This is the opposite of what `variables.env.example` prescribes; see the box at the
  top and the dedicated issue.

### Isolation rules — intended vs. actual

"Actual" is what the Railway API reported for the `staging`/preview `api` service on 2026-08-03.
Rows where actual ≠ intended are the isolation gaps to close.

| Concern | production | staging / previews (intended) | staging / previews (**actual**) |
| --- | --- | --- | --- |
| Database / Redis | own services, volumes; `backup` service | separate services per environment, disposable, no backups | ✅ separate empty pg/redis per environment; no `backup` service |
| `ENV` | `production` | `staging` | ✅ `staging` |
| `HASH_PEPPER`, `JWT_SECRET_KEY` | unique | unique, different from prod | ✅ regenerated, different from prod |
| Strava / Polar | real credentials | `unconfigured` placeholders | ⚠️ client **IDs** are `unconfigured`, but `*_CLIENT_SECRET` / `*_WEBHOOK_*` secrets are **copied from production** |
| Garmin / Suunto / Coros | real credentials | unset placeholders | ✅ unset (schema-optional, left unset) |
| Stripe | live/real test key | `sk_test_unconfigured` | ✅ `sk_test_unconfigured` |
| Brevo (email) | real key | `unconfigured` | ⚠️ **copied from production** (real key) |
| OpenAI / Google GenAI | real keys | `unconfigured` | ⚠️ **copied from production** (real keys) |
| Search engines | indexable | `noindex` (see §5) | ❌ not implemented (no `noindex`, no `robots.txt`) |
| Public access | open signup | password-protected / allowlisted (see §5) | ❌ open, no basic-auth |
| Custom domain | `ultracully.up.railway.app` etc. | Railway-generated domain only | ✅ `*-staging-*.up.railway.app` / `*-openathlete-pr-N.up.railway.app` |

## Cost of staging and previews

Previews are on for every PR and each spins up four services, so the owner asked what the ceiling
is. Numbers below are derived from the Railway API on 2026-08-03 (steady-state usage over a clean
60-minute window) and Railway's metered rates (**memory $10/GB-month, vCPU $20/vCPU-month**, billed
per minute on *used*, not reserved, resources). Railway plans also carry a base fee (Hobby: $5/month
including $5 of usage; Pro: $20/month/seat plus usage) — the plan tier could not be read from the
project token, so treat the base fee separately.

**A full four-service environment is memory-bound and cheap at idle.** With no traffic, CPU is
effectively zero; memory dominates. Measured average resident memory per service on `staging`:

| Service | avg RAM (idle) | ≈ $/month if run continuously |
| --- | --- | --- |
| `api` | ~245 MB | ~$2.40 |
| `postgres` | ~70 MB | ~$0.70 |
| `web` (nginx) | ~43 MB | ~$0.42 |
| `redis` | ~11 MB | ~$0.18 |
| **total** | **~370 MB** | **~$3.7 / month continuous** |

So the always-on `staging` environment costs on the order of **$4/month** at current (near-zero)
traffic; `production` is similar plus its `backup` service.

**A preview only bills while its PR is open.** At the same idle footprint, one preview costs about
**$0.005/hour ≈ $0.12/day**. Concrete ceiling for the concurrency this repo is about to generate —
several sessions opening PRs at once — **seven concurrent previews left open for a full day is
≈ $0.85**, and they are billed only for the hours they actually exist (the earlier
`openathlete-pr-5` preview lived ~67 minutes before Railway tore it down on close). Build compute
adds ~2–3 minutes of builder time per new preview (one `api` + one `web` build), which is pennies;
docs-only pushes deploy as `SKIPPED` and rebuild nothing.

**Verdict.** At today's traffic the runtime cost of always-on staging + per-PR previews is a **few
dollars a month**, not a runaway — the dominant "cost" is build *latency* (~2–3 min per preview),
not money. The real risks to the ceiling are (a) previews that are left open indefinitely (mitigated
by Railway's teardown on PR close — keep it that way and close stale PRs), and (b) exhausting a
Hobby plan's $5 included usage if many previews run for long stretches. If cost does grow, the
cheapest mitigations, in order: **close/merge PRs promptly** so previews are torn down; **gate
previews behind a `preview` label** (turn `botPrEnvironments` opt-in) so docs-only or trivial PRs
skip the four-service spin-up; or **shrink the preview service set** (harder here, since the app
needs Postgres and Redis to boot). None of these are urgent at the current volume.

## 3. Test data

### Principles

1. **No human ever types QA data into production.** Manual QA happens on staging or a preview.
2. **All non-production test data is created by a script and removable by a script.**
3. **Test accounts are recognisable by convention**, so cleanup can be automated and audited.

### Convention for QA accounts

- Email pattern: `qa+<purpose>-<runid>@openathlete.test` (e.g. `qa+signup-1785730000@openathlete.test`).
  A dedicated `openathlete.test` / `qa+…` prefix makes a single `LIKE 'qa+%'` predicate sufficient
  to find every account a test created.
- The existing seed's `demo@openathlete.local` stays as the *fixture* account for demos, distinct
  from per-run QA accounts.
- Passwords for QA accounts come from a CI/Railway variable, never from the repo.

### Seeding

Fix and generalise the existing script rather than inventing a parallel mechanism:

1. Move the hard-coded `YEAR = 2025` / `MONTH = 9` in `libs/database/scripts/seed-demo-month.ts` to
   arguments/env vars defaulting to "the current month", so the demo data is never stale.
2. Make the demo user loginable: hash the password with Argon2 (same parameters the API uses) instead
   of the literal `"demo-hash"`, and read it from `SEED_DEMO_PASSWORD`. Today the seeded account
   cannot authenticate, which is why anyone doing QA reaches for a real signup.
3. Add a **guard**: the script should refuse to run when `ENV=production` unless an explicit
   `I_KNOW_THIS_IS_PRODUCTION=1` is set. Same guard on any teardown script.
4. Register it as `prisma.seed` in `libs/database/package.json` so `prisma migrate reset` reseeds
   automatically for local development.
5. Add a companion `pnpm database run db:seed:qa` that creates a *disposable* QA cohort using the
   `qa+…` convention and prints the created emails as JSON, so tests can consume it.

### Teardown

- **Preferred, and already available: `DELETE /user`.** Any test that signs up should delete its own
  account in an `afterAll`/trap, using the token it already holds. This exercises a real product
  path and needs no database access. Make it a hard rule in the test helper, not a convention.
- **Backstop: `db:seed:qa --purge`** — a script that deletes every user matching the QA email
  pattern older than N hours, runnable on staging by a scheduled job. Never wired to production.
- **Nuclear option for previews:** none needed — Railway destroys the environment (and its volume)
  when the PR closes.

## 4. Automated testing layers

Recommended target, cheapest and highest-value first:

| Layer | Tool | Where it runs | Status |
| --- | --- | --- | --- |
| Lint / format / types | eslint, prettier, `pnpm tsc:check` | `lint.yml`, `type-check.yml` | exists |
| Build | `build.yml` | CI | exists |
| Unit (api) | Jest (already configured) | CI | **missing — add `"test": "jest"` to `apps/api/package.json` and a `test.yml` workflow** |
| Unit / component (web) | Vitest + Testing Library | CI | missing |
| API integration | Jest + `supertest` (both already devDependencies) against ephemeral pg/redis | CI, service containers like `deployment-smoke.yml` already uses | missing |
| Deployment smoke | curl against the real production images | `deployment-smoke.yml` | exists |
| Browser E2E | Playwright | CI against the containers `deployment-smoke.yml` already starts; optionally a nightly run against staging | missing |

Notes on placement:

- **Extend `deployment-smoke.yml` rather than building a new harness.** It already boots the real
  api image and the real web image in the same job graph. Adding a third job that starts both
  containers and runs Playwright against `http://localhost:8080` gives real browser E2E on every PR,
  on ephemeral infrastructure, with zero hosting cost. Its current signup/login curl becomes the
  first Playwright spec.
- **Never point E2E at production.** A nightly Playwright run against **staging** (which now exists
  on its Railway-generated domain) is a reasonable addition — it catches environment/config
  drift that CI cannot — but it must use `qa+…` accounts and delete them via `DELETE /user`
  afterwards, and note that staging's shared production credentials (see the finding at the top)
  mean a staging signup can currently trigger real production email until that is fixed.
- Widen the trigger branches: `deployment-smoke.yml` only runs on `main`, while the other three also
  run on `develop`. Align them.

## 5. Guardrails

1. **Visible environment banner.** Add a `VITE_APP_ENV` build arg to `apps/web/Dockerfile` (mirroring
   `VITE_API_BASE_URL`) and render a fixed banner in the SPA shell whenever it is not `production`.
   Because Vite inlines it at build time, this must be a Docker build arg, set from
   `${{RAILWAY_ENVIRONMENT_NAME}}` in Railway.
2. **`noindex` on non-production.** Add `X-Robots-Tag: noindex, nofollow` to `apps/web/nginx.conf`
   behind an envsubst placeholder (the file is already templated —
   `NGINX_ENVSUBST_FILTER` covers `API_UPSTREAM` and `NGINX_LOCAL_RESOLVERS`), plus a `robots.txt`
   in `apps/web/public/` for production.
3. **Separate credentials per environment — partly done, and the top-of-document finding.**
   `HASH_PEPPER` and `JWT_SECRET_KEY` are already regenerated for staging/previews. Still to do:
   reset `BREVO_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `STRAVA_CLIENT_SECRET`,
   `STRAVA_WEBHOOK_TOKEN`, `POLAR_CLIENT_SECRET` and `POLAR_WEBHOOK_SECRET_KEY` on `staging` back to
   `unconfigured` (they are currently copied from production). Tracked as its own issue.
4. **Password-protect staging** (Railway HTTP basic auth or an allowlist at the edge) so a
   `*.up.railway.app` URL with open signup is not publicly reachable.
5. **Production QA policy, written down:** production is verified by (a) `/health`, (b) the smoke
   test that already ran against the identical image in CI, and (c) read-only inspection. If a
   production-only account is genuinely required (e.g. verifying an OAuth callback that only works on
   the real domain), it must use a `qa+…` address and be deleted via `DELETE /user` immediately, with
   the action recorded in the PR.
6. **Guard destructive scripts on `ENV=production`** (see §3) — this is the mechanical backstop for
   rule 5.
7. Optionally, a **signup allowlist on staging** (env-driven email-domain allowlist) so a
   password-protected staging still cannot accumulate junk accounts.

## 6. Phased action list

**Phase 0 — quick wins, no infrastructure, no cost (hours)**

- [ ] Add `"test": "jest"` (and `test:watch`, `test:cov`) to `apps/api/package.json` so
      `CONTRIBUTING.md`'s instructions are true; add a `test.yml` workflow that runs it.
- [ ] Fix `libs/database/scripts/seed-demo-month.ts`: real Argon2 password, parameterised year/month,
      `ENV=production` guard; register it as `prisma.seed`.
- [x] Correct the "Pull request previews" section of `infra/railway/README.md` to describe the
      environments as they are (done in this PR — the section is now verified).
- [ ] **Reset staging's copied production credentials to `unconfigured`** (Brevo/OpenAI/Google keys
      and the Strava/Polar client secrets + webhook tokens). Highest-priority item; own issue.
- [ ] Write the production-QA policy (§5.5) into `CONTRIBUTING.md`.
- [ ] Align `deployment-smoke.yml` triggers with the other workflows.
- [x] Delete the QA user/event that was created in production during the deployment check
      (done in the deploy session: `qa.ultracully.0803a@example.com` + its "QA Smoke Run" event were
      removed via `DELETE /user`, which cascades to the event).

**Phase 1 — real automated coverage, still free (days)**

- [ ] Add Playwright to the repo and a third job in `deployment-smoke.yml` that runs a signup →
      login → create-training-event → delete-account journey against the containers.
- [ ] Add API integration tests with `supertest` against the service-container Postgres.
- [ ] Add Vitest + Testing Library to `apps/web` with a handful of component tests.
- [ ] Add the `db:seed:qa` / `--purge` scripts and the `qa+…` convention.

**Phase 2 — deployed non-production environment (partly done)**

- [x] Create the Railway `staging` environment (duplicate of production), regenerate `HASH_PEPPER`
      and `JWT_SECRET_KEY`, set `ENV=staging`. **Integrations are not yet `unconfigured`** — see the
      finding; that reset is the open Phase-0 item above.
- [x] Enable PR preview environments based on `staging` (`prDeploys` + `botPrEnvironments`, all PRs).
- [ ] Add the `VITE_APP_ENV` banner and the `noindex` header.
- [ ] Password-protect staging.

**Phase 3 — hardening**

- [ ] Nightly Playwright run against staging with `qa+…` accounts and automatic cleanup.
- [ ] Scheduled QA-data purge job on staging.
- [ ] Make the smoke/E2E jobs required checks for merging to `main`.

## 7. Open decisions (need a human)

Two of the original six questions have been decided by what now exists; the rest remain open and are
mirrored, with recommendations, on issue #16. The email and Stripe questions (Q3/Q4) overlap issue
**#23** — that issue owns the resolution; the notes here only cross-reference it.

- **Q1 — Always-on staging vs. PR previews only. — SETTLED (both).** A persistent `staging` and
  per-PR previews are both live. Per §Cost this is a few dollars a month at current traffic, so the
  original budget worry is largely answered; no further decision needed unless the plan's included
  usage is exceeded.
- **Q2 — Previews for all PRs or opt-in by label? — SETTLED (all PRs).** `botPrEnvironments` is on,
  so every PR gets a preview. Revisit only as a cost mitigation (§Cost) if volume grows.
- **Q3 — Email on staging.** Staging currently carries the **production** `BREVO_API_KEY`, so
  signup emails would send for real through the production Brevo account — the wrong default (see
  the finding). Recommendation: reset it to `unconfigured` and, of the options — (a) accept Brevo
  failures, (b) a separate test-sender key, (c) a log-only mode when `ENV !== production` — prefer
  **(c)** as the durable fix, with **(a)** acceptable immediately. This overlaps issue **#23**; defer
  the final call to it.
- **Q4 — Stripe on staging.** Already `sk_test_unconfigured`, so checkout is untestable today.
  Recommendation: set a real Stripe **test-mode** key if checkout QA is wanted (no real charges),
  otherwise leave the placeholder. Also tracked under issue **#23**.
- **Q5 — OAuth connectors.** Strava/Polar/Garmin callbacks are tied to registered redirect URIs, and
  ephemeral preview domains change per PR, so connector auth cannot be exercised on previews.
  Recommendation: register a second app per provider pointing at a stable **staging** redirect URI
  (requires Q6's stable domain); otherwise accept that connector flows are only verifiable in
  production and keep §5.5's escape hatch. (Note the OAuth *client secrets* are currently copied from
  production — see the finding — but the client **IDs** are `unconfigured`, so the flow still cannot
  complete on staging.)
- **Q6 — Custom staging domain.** Staging is on `*.up.railway.app` today. Recommendation: stay on
  the Railway domain unless Q5 is answered "register staging OAuth apps", which needs a stable custom
  domain (e.g. `staging.ultracully.…`).
