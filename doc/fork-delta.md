# Fork delta

Every departure of `sharkky9/openathlete` from `openathleteorg/openathlete`. Read this before an
upstream integration (see [`fork-maintenance.md`](./fork-maintenance.md)); update it in any PR that
changes the delta.

Last reconciled against upstream `main` at `64a660bb`.

Files this fork adds in its own directories (`infra/railway/**`, `doc/fork-*.md`,
`doc/merge-policy.md`, `.github/workflows/auto-merge.yml`, `.github/workflows/review-gate.yml`,
`.github/workflows/deployment-smoke.yml`) cannot conflict and are described below only where their
behaviour matters during an upgrade.

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
CI builds the API and web apps only, so the website build has to be run locally during an upgrade.

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

**Reason:** the fork wants Devin-authored PRs to merge themselves once checks and Devin Review are
clean.

**Implementation:** `.github/workflows/auto-merge.yml`, `.github/workflows/review-gate.yml`,
`doc/merge-policy.md`, and the `main-protection` ruleset (repository setting, not in the tree).

**Upstream modifications:** none.

**Upstream candidate:** no — this is repository governance.

**Removal condition:** the fork stops using Devin Review or auto-merge.

**Upgrade test:** none; verify required check names in the ruleset still match workflow job names
after an upgrade renames any upstream job.
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
reality. No data migration: existing accounts keep the roles they have.

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
