# Fork delta

Every departure of `sharkky9/openathlete` from `openathleteorg/openathlete`. Read this before an
upstream integration (see [`fork-maintenance.md`](./fork-maintenance.md)); update it in any PR that
changes the delta.

Last reconciled against upstream `main` at `64a660bb`.

Files this fork adds in its own directories (`infra/railway/**`, `doc/fork-*.md`,
`doc/merge-policy.md`, `.github/workflows/auto-merge.yml`, `.github/workflows/checks.yml`,
`.github/workflows/tests.yml`, `.github/workflows/deployment-smoke.yml`,
`.github/workflows/railway-purge-nonprod-secrets.yml`) cannot conflict and are
described below only where their behaviour matters during an upgrade.

## Railway deployment configuration

**Reason:** the fork deploys to Railway; upstream targets Scaleway and self-hosted Docker Compose.

**Implementation:** `infra/railway/` — service definitions (`api.railway.json`, `web.railway.json`,
`backup.railway.json`), the backup service image (`infra/railway/backup/`),
`variables.env.example`, and the `README`, `OPERATIONS` and `BACKUP-RESTORE` runbooks.

**Upstream modifications:** none.

**Upstream candidate:** no — deployment target is fork-specific.

**Removal condition:** the fork stops deploying to Railway.

**Upgrade test:** `Deployment smoke test` workflow; then deploy the upgrade branch to a staging
Railway environment and check the API, web and backup services boot.

## Railway non-production credential purge

**Reason:** `staging` was created by duplicating `production`, which copies every variable verbatim,
and the "replace every secret" half of that step was never done. Staging and every PR preview built
from it therefore held byte-identical copies of the live production third-party credentials
(issue #47). Because they are copies of live secrets they cannot be rotated in place — they have to
be deleted. Merged PR #44 made every third-party credential optional at boot, so deleting them only
makes the corresponding feature go dark. Railway exposes no built-in way to assert "this environment
holds no production credential", so the fork automates it.

**Implementation:** `.github/workflows/railway-purge-nonprod-secrets.yml` (a `workflow_dispatch`-only
job, `permissions: contents: read`, inputs `dry_run` defaulting to **true** and `environments`
defaulting to `staging`, guarded by a `RAILWAY_TOKEN` presence check) and
`infra/railway/purge-nonprod-secrets.mjs` (dependency-free ESM, global `fetch`, Node 22 — so the job
skips `./.github/actions/setup` and never runs `pnpm install`). The script drives Railway's public
GraphQL API at `https://backboard.railway.com/graphql/v2`, deleting exactly seven variables
(`BREVO_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `STRAVA_CLIENT_SECRET`,
`STRAVA_WEBHOOK_TOKEN`, `POLAR_CLIENT_SECRET`, `POLAR_WEBHOOK_SECRET_KEY`) from every service scope
and the shared/project scope of each target environment, then re-queries and prints a `PASS`/`FAIL`
verdict, exiting non-zero if any survived. Two guards are compiled into the script and are
unreachable from the workflow inputs: `production`/`prod`/`prd` aborts the whole run (checked once
on the requested names before authenticating and again on the names Railway returns), and deletion
requires an exact hit on the seven-name allow-list *and* a miss against an `INTERVALS_ICU` prefix
deny-list, both re-asserted immediately before each delete call. It logs variable **names** only,
never values, because the job log is the audit record and the `Secret scan` check treats these as
live credentials; it is idempotent, so deleting an already-absent variable is a logged no-op rather
than an error. `infra/railway/OPERATIONS.md` documents the dispatch procedure and the
dry-run-first convention; the same commit corrects that file's claim that previews "never see
production credentials" and its pre-PR-#44 description of which variables are required.

**Upstream modifications:** none — both files are new and live in fork-owned paths.

**Upstream candidate:** no — upstream does not deploy to Railway, and the seven variable names are
this fork's deployment concern rather than application behaviour.

**Removal condition:** the fork stops deploying to Railway, or non-production environments stop
being duplicated from production (for example if `staging` is rebuilt from scratch with its own
sandbox credentials) *and* something else enforces the invariant continuously.

**Upgrade test:** `node --check infra/railway/purge-nonprod-secrets.mjs`, then dispatch the workflow
with `dry_run = true` against `staging` and confirm it reports the plan and exits 0 without changing
anything. If upstream ever adds a third-party credential to
`libs/shared/src/types/config/environments/api.environment.ts`, decide whether it belongs on the
allow-list in the script — the list is deliberately explicit, so a new credential is *not* purged
until it is added by hand.

## Upstream Scaleway deploy workflow disabled

**Reason:** upstream's deploy workflow pushes to a Scaleway registry this fork has no credentials
for, and would fail on every push to `main`.

**Implementation:** one `if: github.repository == 'openathleteorg/openathlete'` condition on the
`build-and-deploy` job in `.github/workflows/deploy.yml`.

**Upstream modifications:** `.github/workflows/deploy.yml` (3 added lines). The file was previously
deleted in this fork; it was restored with a guard so upstream edits to it merge cleanly instead of
raising a modify/delete conflict.

**Upstream candidate:** no.

**Removal condition:** upstream removes or replaces the Scaleway workflow.

**Upgrade test:** confirm the job is skipped, not failed, on a push to this fork's `main`.

## Web container renders nginx.conf at startup

**Reason:** upstream's `nginx.conf` hard-codes `proxy_pass http://api:3000`, which nginx resolves at
startup. On Railway (and in CI) that host does not exist when the web container boots and the
container crash-loops.

**Implementation:** `apps/web/nginx.conf` uses a runtime `resolver` plus `${API_UPSTREAM}`;
`apps/web/Dockerfile` copies the config to `/etc/nginx/templates/` and sets `NGINX_ENVSUBST_FILTER`,
`NGINX_ENTRYPOINT_LOCAL_RESOLVERS` and a default `API_UPSTREAM`.

**Upstream modifications:** `apps/web/nginx.conf`, `apps/web/Dockerfile`.

**Upstream candidate:** yes — it is a general robustness fix and preserves upstream's default
behaviour via `API_UPSTREAM=http://api:3000`.

**Removal condition:** upstream makes the socket.io upstream configurable or resolves it lazily.

**Upgrade test:** `Web image builds and serves the SPA` in the deployment smoke workflow, which
boots the image with no API host reachable.

## API entrypoint secret decoding

**Reason:** under `set -e`, `base64 -d` on a plain-text secret aborted the entrypoint, and some
`base64` implementations silently drop invalid characters and turn a plain secret into binary. The
script also exited without saying why.

**Implementation:** `apps/api/scripts/docker-entrypoint.sh` — a value counts as base64 only when
re-encoding reproduces it exactly, plus diagnostic messages on each failure path.

**Upstream modifications:** `apps/api/scripts/docker-entrypoint.sh`.

**Upstream candidate:** yes — it is a straight bug fix, not fork-specific.

**Removal condition:** upstream fixes the decoding or drops base64 secret support.

**Upgrade test:** the API smoke job boots the image with plain-text `DATABASE_URL` and `REDIS_URL`.

## `next` bumped to a patched 15.5.x

**Reason:** Railway's build scanner blocks deploys on the CVEs in the version upstream locks.

**Implementation:** `apps/website/package.json` (`next: ^15.5.22`) and the resulting
`pnpm-lock.yaml` changes.

**Upstream modifications:** `apps/website/package.json`, `pnpm-lock.yaml`. The lockfile is the most
conflict-prone file in the delta; on conflict, take upstream's lockfile and re-run
`pnpm install` with this fork's `package.json` values rather than resolving it by hand.

**Upstream candidate:** yes — a security bump upstream should also want.

**Removal condition:** upstream ships `next >= 15.5.22`; drop the pin and take upstream's version.

**Upgrade test:** `pnpm install --frozen-lockfile`, then `pnpm --filter @openathlete/website build`.
The `Website build` job in `.github/workflows/checks.yml` also runs this, so a broken website build
now shows up on the pull request rather than only locally.

## Localized UI strings and date formatting

**Reason:** the Messages page hard-coded the French filter labels `Tous` / `Non lus` and an English
thread count with a naive `n > 1` plural rule, and several date formatters were pinned to `fr` /
`fr-FR`, so an English user saw French labels and month names (issues #9 and #11).

**Implementation:** the affected strings go through Paraglide (`m.messages_filter_all()`,
`m.messages_filter_unread()`, `m.messages_thread_count_one/_other()`,
`m.messages_thread_fallback_title()`, `m.messages_message_edited()`, `m.chatbot_select_or_create()`)
with the plural form selected by `Intl.PluralRules` on the active locale; the date formatters use
the existing `getDateLocale()` / `getDateFnsLocale()` helpers with `getLocale()` instead of a
hard-coded locale.

**Upstream modifications:** `apps/web/messages/{en,fr}.json` (six new keys),
`apps/web/src/pages/dashboard/messages/index.tsx`,
`apps/web/src/components/messages/message-messages.tsx`,
`apps/web/src/components/training-load/training-load-chart.tsx`,
`apps/web/src/components/calendar/calendar-weekly-load-chart.tsx`,
`apps/web/src/components/metrics/injury-logs-table.tsx`,
`apps/web/src/components/chatbot/block-renderer.tsx`,
`apps/web/src/components/chatbot/chat-window.tsx`,
`apps/web/src/views/dashboard/coach-dashboard-view.tsx`,
`apps/web/src/views/dashboard/settings-view/{athletes,coaches}-tab.tsx`.

**Upstream candidate:** yes — a straight i18n bug fix using upstream's own helpers, with no
fork-specific behaviour. The message catalogs are a likely conflict point on integration; keep both
sides' keys.

**Removal condition:** upstream fixes the same strings and formatters; then take upstream's version.

**Upgrade test:** `pnpm check:locale-parity`, then load the Messages page and the Statistics chart
in English and in French and confirm the filter labels, thread count and chart axis follow the
switcher.

## Merge policy automation

**Reason:** the fork wants PRs from its trusted authors to merge themselves once every required
check is green, with no human approval in the loop.

**Implementation:** `.github/workflows/auto-merge.yml`, `doc/merge-policy.md`, and the
`main-protection` ruleset (repository setting, not in the tree). The Devin review gate
(`.github/workflows/review-gate.yml`) that used to sit alongside this has been deleted; Devin is no
longer used here.

**Upstream modifications:** none.

**Upstream candidate:** no — this is repository governance.

**Removal condition:** the fork stops using auto-merge.

**Upgrade test:** none; verify required check names in the ruleset still match workflow job names
after an upgrade renames any upstream job.

## Supplementary CI checks (`checks.yml`)

**Reason:** four checks the upstream workflows never ran — `pnpm format` (the script existed but was
never wired to CI), the `apps/website` Next build (lint and `tsc --noEmit` do not catch a Next build
failure), a production dependency audit and a secret scan.

**Implementation:** `.github/workflows/checks.yml`, jobs `Format check`, `Website build`,
`Dependency audit` and `Secret scan`. None of them are required checks on `main` yet — promoting one
is a ruleset change, not a change in this tree.

`Dependency audit` runs `node scripts/dependency-audit.js` rather than `pnpm audit` directly. A bare
`pnpm audit --audit-level=high --prod` is red today and would stay red for a long time — the
production tree carries ~96 distinct high/critical advisories, almost all deep transitive
dependencies of `@getbrevo/brevo` and `@mastra/core`. A permanently-red check teaches people to
ignore checks, and `continue-on-error` only hides it (at the job level it still reports the job as
failed in the checks UI). So the known set is committed to
`.github/dependency-audit-baseline.json` and the job fails only on high/critical advisories that are
not in it. It catches a newly published advisory against something already in the tree, and any new
high/critical advisory pulled in by a dependency change. It does not catch the baselined advisories
themselves, or anything at moderate severity or below. Prune or extend the baseline with
`node scripts/dependency-audit.js --update`.

`Website build` generates the Prisma client before building. Next type-checks everything the app
pulls in, which reaches `libs/database/client.ts` -> `./generated/client`; without
`pnpm database run db:generate` the build fails with `Cannot find module './generated/client'`.

`Format check` deliberately does not generate Paraglide or Prisma output: `pnpm format` is
`prettier --check` over checked-in `src` only. `apps/web/.gitignore` gained a `/src/paraglide` entry
for the same reason — Prettier reads the `.gitignore` next to its working directory and would
otherwise check ~1000 generated files (`apps/website/.gitignore` already did this).

**Upstream modifications:** `apps/web/.gitignore` (one added entry).

**Upstream candidate:** yes for the website build job and the `.gitignore` entry; the audit and
secret scan are fork policy.

**Removal condition:** upstream adds equivalent jobs.

**Upgrade test:** `pnpm format`, `pnpm website build`.

## Sidebar avatar no longer requests the shadcn demo asset

**Reason:** `NavUser` rendered `AvatarImage src="/avatars/shadcn.jpg"` in two places. That asset does
not exist in the build, so every page load issued a 404 (network noise and error-monitoring noise).
The user model carries no avatar field, so there is nothing to point the image at.

**Implementation:** `apps/web/src/components/sidebar/nav-user.tsx` — the two `AvatarImage` elements
and the now-unused import are removed; `AvatarFallback` (the user's initials) renders
unconditionally. No schema change, no new field, no upload flow.

**Upstream modifications:** `apps/web/src/components/sidebar/nav-user.tsx` (2 removed elements,
1 import change).

**Upstream candidate:** yes — a plain bug fix with no fork-specific behaviour.

**Removal condition:** upstream removes the hardcoded demo avatar, or adds a real avatar field to
the user model and wires it up here.

**Upgrade test:** load any authenticated page and confirm
`performance.getEntriesByType('resource')` contains no `/avatars/shadcn.jpg` entry while the
initials still render in the sidebar and in the user dropdown.

## Onboarding role selection is authoritative

**Reason:** registration hard-coded `roles: [ATHLETE, COACH]` and `completeOnboarding` never wrote
`roles`, so a user who selected only "athlete" during onboarding still ended up with both roles and
saw the coach space (issue #12).

**Implementation:** `createAccount` seeds `[ATHLETE]` only (an athlete record with default training
zones is created for every account, so a not-yet-onboarded user still has a usable space);
`completeOnboarding` writes `data.roles`, which both adds and removes roles. On the web,
`SpaceProvider` falls back to a role the user actually holds when the space stored in local storage
is not one of them, and `SpaceSwitcher` only forces the athlete space for a coach without athletes
when the user has the `ATHLETE` role. `OnboardingView` pre-selects the coach role when the account
already coaches an athlete (it signed up from a coach invitation), so the confirmed selection matches
reality; an `openathlete_onboarding_coach_seeded` local-storage marker keeps that pre-selection to
once per browser, so deselecting it survives a reload. No data migration: existing accounts keep the
roles they have.

**Upstream modifications:** `apps/api/src/modules/auth/services/user.service.ts`,
`apps/web/src/contexts/space/context/space-provider.tsx`,
`apps/web/src/components/sidebar/space-switcher.tsx`,
`apps/web/src/views/dashboard/onboarding/onboarding-view.tsx`.

**Upstream candidate:** yes — it is a straight bug fix with no fork-specific behaviour.

**Removal condition:** upstream stops pre-assigning roles at registration and persists the
onboarding selection; then take upstream's version.

**Upgrade test:** sign up three accounts and complete onboarding selecting athlete only, coach only
and both; `GET /user/me` must return exactly the selected roles, and the athlete-only account must
see no coach space.

## Athlete-scoped queries wait for the athlete id

**Reason:** the dashboard mounted its metric and training-load queries before the athlete had
loaded, so each endpoint was requested once without `athleteId` — which the API rejects with `400`,
because those handlers parse the query parameter with a non-optional `ParseIntPipe` — and once again
successfully after the athlete resolved. Double load on those endpoints and a stream of false `400`s
in error monitoring.

**Implementation:** `enabled: (opt?.enabled ?? true) && athleteId !== undefined` on the queries whose
route requires the parameter, in `apps/web/src/api/metric/metric.hooks.ts` and
`apps/web/src/api/training-load/training-load.hooks.ts` (their query keys already contain
`athleteId`, so they run as soon as it arrives; `useCalculateMetricQuery` is left alone because that
route parses `athleteId` manually and falls back to the caller's own athlete), and
`apps/web/src/views/dashboard/calendar-view.tsx` only mounts the dashboard header once the athlete
is known, so the header shows its skeletons instead of an empty state while the athlete loads.

**Upstream modifications:** `apps/web/src/api/metric/metric.hooks.ts`,
`apps/web/src/api/training-load/training-load.hooks.ts`,
`apps/web/src/views/dashboard/calendar-view.tsx`.

**Upstream candidate:** yes — a plain bug fix with no fork-specific behaviour; it follows the
`enabled` guard upstream already uses in `useWeeklyLoadSummaryQuery`.

**Removal condition:** upstream applies the same guard (or makes `athleteId` genuinely optional on
the API side); then take upstream's version.

**Upgrade test:** log in as an athlete, load the dashboard and the calendar, and check in the
Network tab that `/metric`, `/metric/latest` and `/training-load/metrics` are each requested once
with a `200` and no preceding `400`.

## Auth forms report validation and server errors

**Reason:** signup and login silently swallowed every failure (issue #10). Client-side validation
errors were never rendered, the axios response interceptor resolved 401 responses instead of
rejecting, and neither mutation had an `onError` handler, so a wrong password or an invalid email
produced no feedback at all.

**Implementation:** `apps/web/src/utils/axios.ts` rethrows after clearing tokens on 401;
`apps/web/src/components/hook-form/rhf-text-field.tsx` renders `fieldState.error.message` like the
other RHF fields already do; `apps/web/src/utils/zod-error-map.ts` (new) routes Zod's default
messages through Paraglide and is installed in `apps/web/src/main.tsx`; the login and create-account
views toast on failure; the shared auth DTOs gained the minimum lengths the forms need
(`libs/shared/src/types/dtos/auth/password-policy.ts`, new).

**Upstream modifications:** `apps/web/src/utils/axios.ts`, `apps/web/src/main.tsx`,
`apps/web/src/components/hook-form/rhf-text-field.tsx`, `apps/web/src/views/auth/login-view.tsx`,
`apps/web/src/views/auth/create-account-view.tsx`, `apps/web/messages/{en,fr}.json`,
`libs/shared/src/types/dtos/auth/{login,create-account,password-reset}.dto.ts` and that directory's
`index.ts`.

**Upstream candidate:** yes — a straight bug fix with no fork-specific behaviour; propose it
upstream and drop this entry once it is merged there.

**Removal condition:** upstream ships error feedback on the auth forms.

**Upgrade test:** on the upgraded branch, submit the signup form with `not-an-email` and a
2-character password (inline errors on both fields), sign up with an already-registered email
(error toast), and log in with a wrong password ("Incorrect email or password", button not stuck).

## Runnable Jest suite and `apps/api` `test` script

**Reason:** `apps/api` ships a full Jest setup (`ts-jest`, `supertest`, `@nestjs/testing`,
`testRegex: .*\.spec\.ts$`) but no `test` script, so `CONTRIBUTING.md`'s `cd apps/api && pnpm test`
fails and the repo has zero tests. Issue #24, item 1.

**Implementation:** `test`, `test:watch` and `test:cov` scripts in `apps/api/package.json`; one real
spec, `apps/api/src/modules/core/helpers/activity-stream.spec.ts`, pinning the activity-stream
compression round-trip and on-disk encoding shape. A fork-owned workflow `.github/workflows/tests.yml`
runs `pnpm api test` on every push/PR to `main`.

**Upstream modifications:** `apps/api/package.json` (scripts only). The spec lives in an
upstream-owned directory but is an added file, so it cannot conflict.

**Upstream candidate:** yes — the missing script is an upstream bug; upstream should want both the
script and the spec.

**Removal condition:** upstream adds a `test` script and its own specs covering this helper.

**Upgrade test:** run `pnpm api test`. A red round-trip assertion after an upgrade is a genuine
regression in `activity-stream.ts` (stored activities would decode wrong) — do not touch the spec.
An `encoding shape` assertion going red means upstream *intentionally* changed the on-disk
compression format; only then update the expected `{ r, v }` / `{ s, i }` shapes to match.

## Playwright deployment golden path

**Reason:** every open bug (#7–#12) was found by hand against production. Issue #24, item 2 asks for
one browser golden path against the real deployed images so the next regression is found by CI.

**Implementation:** a fork-owned `e2e/` Playwright project (outside the pnpm workspace) with a single
spec: sign up -> complete onboarding -> create a training event -> see it on the calendar -> delete
the account via `DELETE /user`. A `golden-path` job in `.github/workflows/deployment-smoke.yml`
builds the production API and web images, boots them against ephemeral Postgres/Redis, runs the spec
and uploads the Playwright report/traces/screenshots on failure. Disposable accounts follow issue
#16's `qa+<purpose>-<runid>@openathlete.test` convention (`e2e/support/test-accounts.ts`); the spec
deletes its own account and `e2e/scripts/purge-test-accounts.ts` is a backstop that discovers leaked
accounts via a read-only `DATABASE_URL` query and removes each through `DELETE /user`. To stay safe
against a shared target, the purge has two modes: the default *backstop* mode excludes the current
`<runid>` and only considers accounts older than a safety window (`PURGE_MIN_AGE_MINUTES`, default 60),
so it never deletes a concurrent run's in-flight account; *teardown* mode (`PURGE_OWN_RUN=1`, which the
CI step sets) targets only the current run's own accounts regardless of age, so a crash that skipped
the in-spec `DELETE /user` is still cleaned up. `RUN_ID` is `GITHUB_RUN_ID` in CI (shared by the spec
and the teardown automatically); locally, export the same `E2E_RUN_ID` for the run and the teardown to
reclaim exactly that run's accounts (the default `local-<timestamp>` differs per process), otherwise
ad-hoc local leaks are reclaimed by the age-based backstop. Because it deletes accounts from whatever
`DATABASE_URL`/API it is pointed at, the purge fails closed: it runs only when `ENV` is explicitly
`development` or `test` (the CI step sets `ENV=development`) and refuses an unset/empty `ENV`,
`production`, `staging`, `preview`, or anything else — not just `ENV=production`.

The job is deliberately **not** a required check: `main-protection` (a repository ruleset this fork
cannot edit) does not list it, and a brand-new browser check should prove itself stable before it can
block merges. Recommend promoting it to required only after it has been green across several runs.
Running the suite against a deployed URL (issue #24, item 5) is out of scope here; it needs only
`WEB_BASE_URL`/`API_BASE_URL` pointed at a Railway preview/staging deployment plus a way to reach
that environment's database for the purge backstop (or an admin list endpoint — see below).

**Upstream modifications:** `.github/workflows/deployment-smoke.yml` (already fork-owned; a job was
added). Everything else is under the fork-owned `e2e/` directory.

**Upstream candidate:** partly — the `e2e/` harness is generally useful, but the CORS/port wiring is
tied to this fork's Railway smoke setup. The account-listing gap (no admin endpoint, so the purge
needs direct DB access) is a genuine upstream feature request.

**Removal condition:** upstream ships an equivalent deployed-image E2E job.

**Upgrade test:** run the golden path locally against `docker-compose.yml` (build the API and web
images, boot them, then `cd e2e && WEB_BASE_URL=... API_BASE_URL=... npm test`). A failure that is a
real product regression looks like a broken step with a screenshot/trace showing the app misbehaving
(e.g. the event never appears on the calendar) — report it, do not weaken the assertion. A failure
that only needs a test update looks like an intentional upstream UI change: a renamed onboarding
step, a changed button label, or a moved event-creation affordance. Confirm by reproducing the new
behaviour by hand; only then adjust the affected locator/step. The locators lean on accessible
roles/names and English message-catalog strings, so a message-key rename is the most likely benign
break.

## `.dockerignore` for clean image builds

**Reason:** neither Dockerfile had a `.dockerignore`, so `COPY . .` copied the host's
`node_modules` into the build stage and overwrote the container's freshly installed, correctly
platformed dependencies — a local `docker build` (or `docker compose build`) then failed inside the
`libs/shared` Rollup build with `Unexpected token`. CI builds from a clean checkout and so never hit
this, which made it a local-only trap.

**Implementation:** a root `.dockerignore` excluding `**/node_modules`, build outputs, VCS, local
`.env` files and the `e2e/` project from the build context.

**Upstream modifications:** none (added file).

**Upstream candidate:** yes — it is a straight build-hygiene fix that also speeds up the build.

**Removal condition:** upstream adds its own `.dockerignore`; merge the two rather than dropping this
one.

**Upgrade test:** `docker build -f apps/api/Dockerfile .` and `docker build -f apps/web/Dockerfile .`
from a checkout that has local `node_modules` present both succeed.

## Demo seed can actually log in

**Reason:** `libs/database/scripts/seed-demo-month.ts` wrote `demo@openathlete.local` with
`password: "demo-hash"` — a literal string, not an Argon2 hash — so the seeded user could never log
in. The script was also broken against the current Prisma client (snake_case field names), hard-coded
September 2025, had no `prisma.seed` entry, and generated a colliding `externalId` across athletes.
Issue #24, item 3.

**Implementation:** the script now hashes the password with Argon2 and the same optional `HASH_PEPPER`
handling the auth module uses (`apps/api/src/modules/auth/services/user.service.ts`). Because
`HASH_PEPPER` lives in `apps/api/.env` (not `libs/database`'s own dotenv scope), the seed explicitly
reads **only** the `HASH_PEPPER` value from `apps/api/.env` (via `dotenv.parse`, when it isn't already
in the environment) so it hashes with the *same* pepper the API verifies against; otherwise a locally
configured pepper would make the seeded user fail login. It deliberately does **not** load the whole
API env file into `process.env`, so the seed's `ENV` gate and its target `DATABASE_URL` can never be
silently inherited from `apps/api/.env` and point this destructive seed at an unintended database. It
reads `DEMO_EMAIL`/`DEMO_PASSWORD`/`SEED_YEAR`/`SEED_MONTH` from the environment, uses the client's
camelCase field names, makes each `externalId` unique per athlete, and marks the seeded users
`onboardingCompleted` so a demo login lands on the seeded calendar rather than the onboarding wizard.
There is **no hardcoded default password**: `DEMO_PASSWORD` is used when set (CI/Playwright set it for
determinism), otherwise a random per-run password is generated and printed to stdout — so there is no
well-known credential to leak even if the seed reaches an unintended database. Because it still
creates login-able accounts, it seeds only when `ENV` is
explicitly `development` or `test`. For any other `ENV` (unset/empty, `production`, staging, preview,
a shared or mislabelled database) it **skips cleanly and exits 0** rather than throwing — the seed is
registered as the Prisma seed hook (`prisma.config.ts` -> `migrations.seed`), so it also fires on
`prisma migrate dev`/`reset` (`db:migrate`/`db:reset`); throwing would break that documented setup
command, since `ENV` is not part of `libs/database`'s own env. `migrate deploy` (the Railway image
path) never invokes the hook. `libs/database/.env.example` documents the optional `ENV`, and
`libs/database/package.json` gains an `argon2` dependency. The Prisma seed hook is
registered as `migrations.seed` in `libs/database/prisma.config.ts` (not the `prisma` block in
`package.json`): a `prisma.config.ts` is present, and under Prisma 6 the config file takes precedence,
so `package.json`'s `prisma.seed` is ignored. `prisma migrate deploy` — what the Docker image runs —
does not fire the seed, so only local `prisma db seed`/`migrate reset`/`migrate dev` load demo data.

**Upstream modifications:** `libs/database/scripts/seed-demo-month.ts`, `libs/database/prisma.config.ts`,
`libs/database/package.json`, `pnpm-lock.yaml` (the `argon2` addition). On a lockfile conflict, take
upstream's lockfile and re-run `pnpm install` rather than resolving by hand.

**Upstream candidate:** yes — the script is upstream's and every one of these is a bug fix. The one
judgement call is re-hashing in the seed rather than importing the API's `UserService` (which would
drag the Nest DI graph into a standalone script); if upstream refactors hashing into a shared,
dependency-free helper, import that instead of mirroring the algorithm.

**Removal condition:** upstream fixes the seed script.

**Upgrade test:** `pnpm database run db:seed:demo-month` (or `pnpm --filter @openathlete/database exec
prisma db seed`, which must print `Running seed command ...`) against a local database, then log in as
the demo user through `POST /auth/login`. A failure here is a regression in the seed or in auth hashing.
If upstream changes the hashing algorithm or pepper handling, this seed must be updated to match
(compare against `user.service.ts`) — that is a required test update, not a product regression.
