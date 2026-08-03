# Testing, test data and staging strategy

Status: **proposal** — nothing in this document has been provisioned. It is a plan for review.

## Why this exists

The Railway deployment (`infra/railway/`) currently has a single `production` environment with
`web`, `api`, `postgres` and `redis`. End-to-end validation of the deployment was done by creating a
real account and a real training event **in the production database**. There is today no other
deployed place to do that: no staging environment, no PR previews, and no browser-level automated
tests. This document proposes how to fix that, grounded in what is actually in this repo.

## 1. Current state (inventory)

### Deployment

| Thing | Where | Notes |
| --- | --- | --- |
| Railway service topology + variables | `infra/railway/README.md`, `infra/railway/variables.env.example` | Documents `production`, and *claims* PR previews are enabled on a `staging` environment |
| Config as code | `infra/railway/api.railway.json`, `infra/railway/web.railway.json` | Dockerfile builder, health checks, `watchPatterns` |
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

None. `ENV` already accepts `staging` (`libs/shared/src/types/config/environment.enum.ts`), but
nothing in the SPA reads it — the web build has no environment marker at all, and there is no
`robots.txt` (`apps/web/public/` contains only icons and the manifest) and no `X-Robots-Tag` in
`apps/web/nginx.conf`. Signup is open on production.

## 2. Environments

### Recommendation

Three tiers, in this priority order:

1. **Ephemeral CI (already exists, extend it).** `deployment-smoke.yml` spins up real pg + redis and
   the real production images per PR. This is the cheapest, most isolated place to run functional
   and browser tests. **Most automated end-to-end testing should live here, not on a deployed
   environment.**
2. **A persistent `staging` Railway environment.** A second environment in the same Railway project,
   duplicated from `production`, with its **own** `postgres` and `redis` services and volumes, its
   own `HASH_PEPPER`/`JWT_SECRET_KEY`, and `ENV=staging`. Purpose: manual/exploratory QA, demoing,
   verifying migrations against a database that has history, and reproducing prod-like issues. Its
   web/api get `*.up.railway.app` domains; no custom domain.
3. **Railway PR previews on top of `staging`** (as `infra/railway/README.md` already anticipates).
   Each PR gets a throwaway copy of the staging environment with its own database; Railway destroys
   it when the PR closes.

### Critique of what `infra/railway/README.md` currently says

The "Pull request previews" section is written in the present tense — *"PR environments are enabled
on the `staging` environment"* — but there is no `staging` environment; only `production` exists.
That paragraph should be demoted to a "planned" note (or the environment actually created) so the
doc stops describing infrastructure that isn't there.

Three concrete gaps that section glosses over:

- **`VITE_API_BASE_URL` is a build-time arg** (`apps/web/Dockerfile` `ARG VITE_API_BASE_URL`). In a
  preview environment the API domain is only known after the api service gets its domain, and the
  web image must be **rebuilt** for each preview. Railway does rebuild per environment, and
  `https://${{api.RAILWAY_PUBLIC_DOMAIN}}` resolves per environment, so this works — but it means
  every preview pays a full web+api Docker build, which is the main cost/latency driver.
- **Databases are self-hosted containers with volumes**, not a managed add-on. A duplicated
  environment gets an empty volume, so previews start with an empty database and only the schema
  that `prisma migrate deploy` creates on boot. That is correct and safe, but it also means previews
  have **no data** unless we seed them (see §3).
- **Secrets must not be inherited from production.** Duplicating an environment copies variables.
  `HASH_PEPPER` and `JWT_SECRET_KEY` must be regenerated for `staging` (and therefore for previews),
  and every third-party integration should stay at the `unconfigured` placeholders documented in
  `variables.env.example` so staging can never touch a real Strava/Polar/Stripe/Brevo account.

### Isolation rules

| Concern | production | staging / previews |
| --- | --- | --- |
| Database / Redis | own services, volumes, backups | separate services per environment, disposable, no backups needed |
| `ENV` | `production` | `staging` |
| `HASH_PEPPER`, `JWT_SECRET_KEY` | unique | unique, different from prod (also makes prod JWTs useless there) |
| Strava / Polar / Garmin / Suunto / Coros | real credentials | `unconfigured` placeholders |
| Stripe | live/real test key | `sk_test_unconfigured` (or a real Stripe **test-mode** key if we want to QA checkout) |
| Brevo (email) | real key | `unconfigured` — see open question Q3 |
| Search engines | indexable | `noindex` (see §4) |
| Custom domain | `ultracully.up.railway.app` etc. | Railway-generated domain only |

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
- **Never point E2E at production.** A nightly Playwright run against **staging** is a reasonable
  addition once staging exists (it catches environment/config drift that CI cannot), but it must use
  `qa+…` accounts and delete them via `DELETE /user` afterwards.
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
3. **Separate credentials per environment.** Regenerate `HASH_PEPPER` and `JWT_SECRET_KEY` for
   staging/previews; keep all integration secrets as `unconfigured` placeholders there.
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
- [ ] Correct the "Pull request previews" section of `infra/railway/README.md` to describe intent
      rather than existing state.
- [ ] Write the production-QA policy (§5.5) into `CONTRIBUTING.md`.
- [ ] Align `deployment-smoke.yml` triggers with the other workflows.
- [ ] Delete the QA user/event that was created in production during the deployment check.

**Phase 1 — real automated coverage, still free (days)**

- [ ] Add Playwright to the repo and a third job in `deployment-smoke.yml` that runs a signup →
      login → create-training-event → delete-account journey against the containers.
- [ ] Add API integration tests with `supertest` against the service-container Postgres.
- [ ] Add Vitest + Testing Library to `apps/web` with a handful of component tests.
- [ ] Add the `db:seed:qa` / `--purge` scripts and the `qa+…` convention.

**Phase 2 — deployed non-production environment (costs money)**

- [ ] Create the Railway `staging` environment (duplicate of production), regenerate its secrets,
      set `ENV=staging`, keep integrations `unconfigured`.
- [ ] Enable PR preview environments based on `staging`.
- [ ] Add the `VITE_APP_ENV` banner and the `noindex` header.
- [ ] Password-protect staging.

**Phase 3 — hardening**

- [ ] Nightly Playwright run against staging with `qa+…` accounts and automatic cleanup.
- [ ] Scheduled QA-data purge job on staging.
- [ ] Make the smoke/E2E jobs required checks for merging to `main`.

## 7. Open decisions (need a human)

- **Q1 — Always-on staging vs. PR previews only.** A persistent `staging` runs four services
  (web, api, postgres, redis) continuously; PR previews run the same four but only while a PR is
  open, at the cost of a full Docker build per preview and a cold, empty database. Options: (a)
  previews only, no persistent staging — cheapest, but nothing to test long-lived data or migrations
  against; (b) persistent staging only — predictable cost, but PRs share one environment; (c) both,
  as proposed. **Which trade-off do you want, and what is the monthly budget ceiling?**
- **Q2 — Should previews be enabled for all PRs or opt-in by label?** Opt-in (e.g. a
  `preview` label) avoids paying for docs-only PRs like this one.
- **Q3 — Email on staging.** With `BREVO_API_KEY=unconfigured`, signup emails will fail. Do we
  (a) accept the failures, (b) provision a separate Brevo key restricted to a test sender, or
  (c) add a "log emails instead of sending" mode when `ENV !== production`? Option (c) is a code
  change and out of scope for this document.
- **Q4 — Stripe on staging.** Placeholder key (checkout untestable) or a real Stripe **test-mode**
  key (checkout testable, no real charges)?
- **Q5 — OAuth integrations.** Strava/Polar/Garmin callbacks are tied to registered redirect URIs.
  Testing them on ephemeral preview domains is not practical. Do we register a second app per
  provider pointing at a stable staging domain, or accept that connector flows are only verifiable
  in production (and therefore keep §5.5's escape hatch)?
- **Q6 — Custom staging domain.** Stay on `*.up.railway.app`, or point something like
  `staging.ultracully.…` at it (needed for OAuth stability, per Q5)?
