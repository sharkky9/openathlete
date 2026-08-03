# Third-party integration strategy

Which of upstream's third-party integrations this fork commits to maintaining, and how the ones it
does not commit to are disposed of.

This document is a **recommendation awaiting the owner's approval**. Nothing here has been
configured, procured, removed or guarded. Every line of the [decision table](#decision-table) is a
proposal; approving a line turns it into a follow-up issue.

Traced against the tree at the time of writing. It builds on the per-secret inventory in issue #14
and **corrects it in two places** — see [Corrections to #14](#corrections-to-14).

## Vocabulary

The four dispositions, ranked by the conflict surface they add at upstream integration time
(`doc/fork-maintenance.md`, "Where customizations go"):

| Disposition | Mechanics | Conflict risk |
| --- | --- | --- |
| **Configure** | Real credentials in Railway variables. No code change. | none |
| **Dormant** | Code untouched and upstream-identical, secret left at a placeholder, feature unreachable in practice. | none |
| **Neutralized** | Code stays in place; a route, handler or UI surface is guarded off — the `github.repository` pattern used on `.github/workflows/deploy.yml`. | low to medium, depending on whether the guard lands in an upstream file |
| **Removed** | Upstream file deleted. Produces a modify/delete conflict every time upstream touches it. | high |

Two facts constrain everything below.

**Dormant does not close a route.** `ProvidersSyncModule` is imported unconditionally
(`apps/api/src/modules/app.module.ts:62`) and registers `ProviderOAuthController`
(`apps/api/src/modules/providers-sync/providers-sync.module.ts:31`). Every provider webhook path is
publicly routable regardless of whether the corresponding secret is set. There is no global route
prefix, no throttler and no helmet in `apps/api/src/main.ts`. "We are not using Polar" is a
statement about data, not about attack surface.

**Not every disposal is available at configuration level.** The connector tiles are a hard-coded
array (`apps/web/src/components/connectors/connectors-list.tsx:39-44`), not a config lookup, so
"hide the connector from the UI by configuration" — the mechanic the issue assumes for *dormant* —
**does not exist today** for providers. It does exist for Stripe (`VITE_DISABLE_PAYMENTS`) and for
Firebase (`VITE_FIREBASE_*`). Dormant providers therefore keep a visible tile that fails when
clicked, unless a small fork edit hides them.

---

## Strava

**What it does.** OAuth connect (`apps/api/src/modules/providers-sync/providers/strava.provider.service.ts`),
authorization URI at `GET /provider/strava/uri`
(`apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:150`), token exchange
at `POST /provider/strava/token` (JWT-guarded, `:176-178`), webhook verification at
`GET /provider/strava/webhook` (`:826`) and event delivery at `POST /provider/strava/webhook`
(`:880`). Config keys `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REDIRECT_URI`,
`STRAVA_WEBHOOK_TOKEN`, all **required non-empty** by
`libs/shared/src/types/config/environments/api.environment.ts:88-105`. UI surface: the Strava tile
in the connectors list and in onboarding
(`apps/web/src/components/connectors/connectors-list.tsx:39-44`,
`apps/web/src/views/dashboard/onboarding/onboarding-view.tsx:585`).

**With a placeholder today.** Silently degraded, plus one real leak. The connect flow bounces off
Strava with `invalid_client`. The webhook POST handler is unauthenticated but inert: it resolves a
`providerAccount` by `owner_id` and returns when none matches
(`strava.provider.service.ts:564-584`), and it rejects non-numeric `object_id` before using it
(`:553-561`). **New finding:** `GET /provider/strava/webhook` logs the configured
`STRAVA_WEBHOOK_TOKEN` in plaintext on every request
(`provider-oauth.controller.ts:830-832`) — harmless while the value is `unconfigured`, a secret
leak into the log drain the moment a real token is set.

**Recommendation: Configure.** This is the integration the owner actually uses, it is free and
self-serve, and it is the only one whose absence removes real data from the app. Get a Strava API
application, set the four variables, register the webhook subscription with a webhook token that is
a real random secret.

**Do first:** move the `STRAVA_WEBHOOK_TOKEN` out of that log line before setting a real token. It
is a two-line change in an upstream file — small, isolated, and an upstream candidate.

**Ongoing cost.** €0. Credential upkeep: none (Strava client secrets do not expire); the webhook
subscription must be re-registered if the API domain changes. Conflict surface: zero for
configuration, one small delta for the log fix.

---

## Garmin

**What it does.** PKCE OAuth (`apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts`),
five unauthenticated webhook routes: activity ping (`provider-oauth.controller.ts:940`), health ping
(`:1016`), activity files (`:1120`), deregistration (`:1226`), permissions change (`:1273`). Config
keys `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET`, `GARMIN_REDIRECT_URI`, all **optional** in the
schema (`api.environment.ts:113-124`) and currently unset. UI: Garmin tile in the connectors list.

**With a placeholder today.** Unset, not placeholder. The tile is visible; clicking it produces an
authorization URI with an empty `client_id` and the flow fails at Garmin. Webhooks are routable but
every callback fetch is gated behind an *active* Garmin `providerAccount` row, of which there are
none — see [Webhook endpoints](#the-webhook-endpoints) for the detail, which corrects #14's SSRF
assessment.

**Recommendation: Dormant now, revisit if partner approval is granted.** The owner owns the
hardware, so this is the one integration whose value could exceed Strava's (FIT files carry
per-second streams Strava's API does not). But approval is a weeks-long process with an uncertain
outcome, and nothing about keeping the code dormant costs anything today. Do not apply for partner
access as part of this decision; decide separately whether the FIT-file detail is worth the
paperwork.

**Mechanics of dormant:** leave `GARMIN_*` unset (they must stay *unset*, not empty — the URL
validator rejects `""`). No code change.

**If Garmin is later configured**, the callback-URL handling has to be revisited first: see
[Webhook endpoints](#the-webhook-endpoints).

**Ongoing cost.** €0 and no credential upkeep while dormant. Conflict surface: zero — the code stays
byte-identical to upstream. The only carrying cost is that ~2,300 lines of Garmin service code must
keep compiling on every upstream integration, which is free as long as we change nothing in it.

---

## Suunto

**What it does.** OAuth plus a subscription key
(`apps/api/src/modules/providers-sync/providers/suunto.provider.service.ts:78,159-161`), webhook at
`POST /provider/suunto/webhook` (`provider-oauth.controller.ts:1467`). Config keys `SUUNTO_CLIENT_ID`,
`SUUNTO_CLIENT_SECRET`, `SUUNTO_REDIRECT_URI`, `SUUNTO_SUBSCRIPTION_KEY`, all optional
(`api.environment.ts:130-146`), currently unset. UI: Suunto tile in the connectors list.

**With a placeholder today.** Visibly broken in the same way as Garmin: a tile that fails when
clicked. The webhook resolves an account and no-ops.

**Recommendation: Dormant.** No hardware, no reason. Nothing to do; this is the status quo.

**Ongoing cost.** €0, zero conflict surface.

---

## Coros

**What it does.** Almost nothing. `CorosProviderService`'s OAuth config is entirely commented out
(`apps/api/src/modules/providers-sync/providers/coros.provider.service.ts:18-20`) and the matching
env keys are commented out of the schema (`api.environment.ts:148-160`). Upstream has already
shipped it disabled. `COROS` is still reachable through the generic `:provider` switch
(`provider-oauth.controller.ts:164-165`) but has no client id to offer.

**With a placeholder today.** Nothing. There is no Coros tile in the UI list
(`connectors-list.tsx:39-44`).

**Recommendation: Dormant.** Already disabled upstream; there is nothing for this fork to do.
Explicitly *not* a removal candidate — upstream is mid-implementation here and will touch these
files again.

**Ongoing cost.** Zero on every axis.

---

## Polar

**What it does.** OAuth (`apps/api/src/modules/providers-sync/providers/polar.provider.service.ts`),
webhook at `POST /provider/polar/webhook` (`provider-oauth.controller.ts:1353`) handling `EXERCISE`,
`SLEEP`, `ACTIVITY_SUMMARY` and `CONTINUOUS_HEART_RATE`. Config keys `POLAR_CLIENT_ID`,
`POLAR_CLIENT_SECRET`, `POLAR_REDIRECT_URI`, `POLAR_WEBHOOK_URL`, `POLAR_WEBHOOK_SECRET_KEY`, all
**required non-empty** (`api.environment.ts:169-198`), so the placeholders cannot simply be removed
without failing boot. UI: Polar tile in the connectors list.

**With a placeholder today.** Degraded, and the closest thing to a liability among the dormant
providers — an unauthenticated public route whose signature check is skipped when the header is
absent (`polar.provider.service.ts:598-617`). It is inert only because no `providerAccount` row
matches. See [Webhook endpoints](#the-webhook-endpoints).

**Recommendation: Dormant, and close the route as part of the webhook decision.** The owner owns no
Polar hardware and this integration will never be configured on the current facts. But leaving the
placeholders in place is what keeps the app booting, so *dormant* is the configuration answer and
*neutralized* is the security answer; they are not alternatives here, they compose.

**Mechanics:** keep `POLAR_*` at placeholders (required by the schema). Then apply the webhook guard
described below, which covers Polar, Suunto and Garmin together rather than one guard per provider.

**Ongoing cost.** €0, no credential upkeep. Conflict surface: whatever the shared webhook guard
costs, amortized across three providers.

---

## Brevo (transactional email)

Treated in full under [Email](#email-what-the-app-actually-needs). Summary: **Configure**, but not
necessarily Brevo — see that section for the comparison and the recommendation.

---

## Stripe (billing)

**What it does.** `StripeService` wraps checkout, customer portal, invoices and cancellation
(`apps/api/src/modules/subscription/services/stripe.service.ts`). `SubscriptionController` exposes
`/subscription/checkout`, `/cancel`, `/resume`, `/invoices`, `/portal`, all JWT-guarded
(`apps/api/src/modules/subscription/controllers/subscription.controller.ts:42`).
`StripeWebhookController` handles `POST /subscription/webhook`
(`apps/api/src/modules/subscription/controllers/stripe-webhook.controller.ts:41`). Config keys
`STRIPE_SECRET_KEY`, `STRIPE_PRICE_IDS`, `STRIPE_WEBHOOK_SECRET`, all optional in the schema
(`api.environment.ts:265-284`) — but the constructor throws on a missing key
(`stripe.service.ts:18-21`), which is why `infra/railway/variables.env.example` carries
`STRIPE_SECRET_KEY=sk_test_unconfigured`. UI: the Subscription settings tab
(`apps/web/src/views/dashboard/settings-view/settings-view.tsx:56`) and the paywall dialog
(`apps/web/src/components/paywall/paywall-dialog.tsx`).

**With a placeholder today.** Safe. The webhook verifies the Stripe signature and fails closed. The
checkout endpoints return Stripe API errors to an authenticated caller. Nothing is silently wrong.

**Crucially: Stripe is not load-bearing for the AI features.** `FeatureAccessGuard` reads the
`Subscription` row from Postgres via `SubscriptionService.hasAIFeaturesAccess`
(`apps/api/src/modules/subscription/services/subscription.service.ts:411-419`); it never calls
Stripe. A plan can be set directly in the database. See
[AI features and plan gating](#ai-features-and-plan-gating).

**Recommendation: Dormant, with the UI hidden by configuration.** Keep `STRIPE_SECRET_KEY` at its
placeholder so the eager constructor is satisfied; set **`VITE_DISABLE_PAYMENTS=true`** on the web
service. That single variable removes the Subscription settings tab
(`settings-view.tsx:56`) and turns the paywall dialog into an "unavailable" message
(`paywall-dialog.tsx:137-152`) — upstream's own kill switch, built for the iOS build, doing exactly
what this fork wants. This is the cleanest disposal in the whole document: configuration only, zero
code, zero conflict.

Do **not** remove Stripe. It is imported by `SubscriptionModule`, which owns the plan gating the AI
features read; removing it is a broad change to upstream internals for no benefit.

**Ongoing cost.** €0, no credential upkeep, zero conflict surface.

---

## OpenAI

Treated in full under [AI features and plan gating](#ai-features-and-plan-gating).

**What it does, in brief.** `OPENAI_API_KEY` (`api.environment.ts:212-215`, required non-empty)
backs: the Mastra agents for event generation and modification, RPE extraction, injury extraction,
TRIMP estimation and QnA (`apps/api/src/common/constants/ai-models.constant.ts:19-60`), the coach
assistant router (`apps/api/src/mastra/index.ts:42`), Whisper transcription
(`apps/api/src/modules/core/services/activity-feedback.service.ts:29-30,353-356`), and
`text-embedding-3-small` embeddings for agent memory
(`apps/api/src/mastra/config/memory.config.ts:22`,
`apps/api/src/listeners/activity-feedback-extraction.listener.ts:16`).

**With a placeholder today.** Silently degraded. Every call 401s; the listeners catch and log, the
guarded endpoints never get that far because the FREE plan blocks them first.

**Recommendation: Dormant for now; Configure only if the owner wants the AI feature set after
reading what it does.** See the cost and the feature inventory below.

---

## Google Generative AI

**What it does.** One thing: the default model for the post-activity feedback agent,
`google/gemini-3-pro-preview` (`ai-models.constant.ts:44-46`), used by
`apps/api/src/listeners/activity-feedback.listener.ts:209`. `GOOGLE_GENERATIVE_AI_API_KEY` is
required non-empty by the schema (`api.environment.ts:217-219`).

**With a placeholder today.** Silently degraded, and irrelevant: the feedback listener checks
`AI_RPE_QUESTIONS` access first (`activity-feedback.listener.ts:83-85`), which the FREE plan denies.

**Recommendation: Dormant, unless the AI features are turned on** — in which case configure it,
because it is free-tier and it is the only thing standing between the owner and post-activity
feedback questions. Alternatively set `AI_MODEL_POST_ACTIVITY_FEEDBACK` to an OpenAI model and skip
Google entirely; that is a configuration-only choice (`api.environment.ts:239-244`).

**Ongoing cost.** €0 on the free tier. Google rotates and deprecates preview model names, so
`gemini-3-pro-preview` is a name that will break on its own schedule — pinning
`AI_MODEL_POST_ACTIVITY_FEEDBACK` to a stable model is worth doing if this is ever configured.

---

## Firebase

**What it does.** Social ("Continue with Google") sign-in. Web side reads `VITE_FIREBASE_API_KEY`,
`VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`
(`apps/web/src/utils/firebase-auth.ts:22-36`) and throws when any is missing; API side verifies the
ID token with `firebase-admin` using `FIREBASE_SERVICE_ACCOUNT_JSON`
(`apps/api/src/modules/auth/services/firebase-auth.service.ts:34-56`, optional at
`api.environment.ts:291-297`). UI: the OAuth buttons block on the login and signup pages
(`apps/web/src/views/auth/oauth-buttons.tsx:55`).

**With a placeholder today.** Visibly broken. The button renders unconditionally; clicking it throws
"Firebase web config is missing" and shows an `oauth_login_failed` toast
(`oauth-buttons.tsx:61-64`). Not a security problem — the API's Firebase login path refuses to
verify anything without a service account — but it is the one user-visible dead control on the
signup page.

**Recommendation: Dormant.** Email + password login works. Google sign-in for a single user who
already has a password is not worth a Firebase project. If the dead button annoys, hiding it is a
small fork edit in `oauth-buttons.tsx` gated on `import.meta.env.VITE_FIREBASE_API_KEY` — the same
config-presence pattern the file already uses, and a plausible upstream candidate. Recorded as
optional, not recommended.

**Ongoing cost.** €0, zero conflict surface while dormant.

---

## Better Stack (error tracking)

**What it does.** API: `Sentry.init({ dsn: process.env.BETTER_STACK_DSN })` in
`apps/api/src/instrument.ts:5`, wired through `SentryModule`/`SentryGlobalFilter`
(`apps/api/src/modules/app.module.ts:1`). `BETTER_STACK_DSN` is optional
(`api.environment.ts:321-325`) and currently unset, so the API reports nothing.

**Web: the DSN is hard-coded to upstream's project.** `apps/web/src/utils/error-monitoring.ts:5-6`
contains a literal `https://…@eu-nbg-2.betterstackdata.com/1604505`, and
`initErrorMonitoring()` runs unconditionally in production builds (`apps/web/src/main.tsx:28`) with
`replayIntegration` enabled at a 10% session sample and 100% on error
(`error-monitoring.ts:18-25`). **Every production browser error and a sample of session replays from
this fork's deployment are being shipped to the upstream project's telemetry account.** `maskAllText`
is on, so this is not a mass content leak, but URLs, error messages and DOM structure from a private
deployment are going to a third party the fork owner has no relationship with. This is not in #14.

**Recommendation: Neutralize the web side; Dormant on the API side.** The web DSN should come from
`import.meta.env.VITE_BETTER_STACK_DSN` with the init short-circuiting when it is unset — a
~5-line change in `error-monitoring.ts`, an upstream file, and a strong upstream candidate (upstream
also should not hard-code its DSN into every fork). Until that lands, the honest description of the
current state is "this fork exports frontend telemetry to a third party by default".

This is the one item in the document that is a **defect rather than a decision**, and it should be
fixed regardless of how the rest of the table is answered.

On the API side: leave `BETTER_STACK_DSN` unset unless the owner wants error tracking, in which case
a personal Better Stack free-tier source is the natural fit and the fork already has a testing skill
covering it (PR #20).

**Ongoing cost.** €0 on the free tier. Conflict surface: one small delta in `error-monitoring.ts`
until upstream takes the fix.

---

## The webhook endpoints

The question the issue turns on: **does a dormant integration still expose these routes?**

**Yes.** All of them, unauthenticated, on the public API domain:

| Route | Auth | Controller |
| --- | --- | --- |
| `GET /provider/strava/webhook` | verify-token compare | `provider-oauth.controller.ts:826` |
| `POST /provider/strava/webhook` | none | `:880` |
| `POST /provider/garmin/webhook/activity-ping` | none | `:940` |
| `POST /provider/garmin/webhook/health-ping` | none | `:1016` |
| `POST /provider/garmin/webhook/activity-files` | none | `:1120` |
| `POST /provider/garmin/webhook/deregistration` | none | `:1226` |
| `POST /provider/garmin/webhook/user-permissions-change` | none | `:1273` |
| `POST /provider/polar/webhook` | signature, conditionally | `:1353` |
| `POST /provider/suunto/webhook` | none | `:1467` |
| `GET /provider/:provider/uri` | none | `:150` |

Setting a secret to `unconfigured` changes nothing about routability. There is no throttler, so an
unauthenticated caller can also drive unbounded database lookups and log volume through them.

### Polar signature verification — confirmed

`polar.provider.service.ts:598-617`: verification is inside `if (signature && this.webhookSecretKey)`.
Omit the `polar-webhook-signature` header and the check is skipped entirely. #14's report is
accurate and the code is unchanged.

Two refinements. First, the handler is only reachable to effect: after the signature block it looks
up an active `POLAR` `providerAccount` by `user_id` and returns when none exists (`:620-644`), so
with no Polar account connected a forged webhook accomplishes a database read and a log line.
Second, when a real `POLAR_WEBHOOK_SECRET_KEY` *is* configured, `crypto.timingSafeEqual` is called on
buffers of possibly different lengths (`:565-577`), which throws `RangeError` rather than returning
false — a 500 instead of a clean rejection.

### Strava and Garmin webhook POSTs are unauthenticated — confirmed

Both confirmed. Both are inert without a connected account, for the same reason: account lookup
first, return when absent (`strava.provider.service.ts:564-584`;
`garmin.provider.service.ts:854-860`, `:1037-1050`, `:2058-2077`).

### The Garmin `callbackURL` SSRF — #14 overstates it

**#14 says the Garmin activity-files handler "fetches an attacker-supplied `callbackURL`". That is
no longer the whole picture**, and the correction matters for the disposition:

1. There is a validator. `getSafeGarminCallbackUrl` (`garmin.provider.service.ts:87-109`) requires
   `https:`, rejects userinfo credentials, and rejects any port other than 443. It is applied on
   every callback fetch path: `fetchActivitySummaries` (`:943-947`), `fetchHealthSummaries`
   (`:1222-1227`) and `processActivityFile` (`:2115-2126`).
2. **There is no host allowlist.** Any public HTTPS host is still reachable, as is any internal
   service that happens to speak HTTPS on 443. The classic cloud-metadata target
   (`http://169.254.169.254`) is excluded by the scheme check, and Railway's internal services are
   plain HTTP, so the realistic blast radius on this deployment is "the API makes an outbound HTTPS
   GET to a URL of the caller's choosing".
3. **The fetch is unreachable without an active Garmin account.** Every path resolves a
   `providerAccount` with `externalUserId = payload.userId` and `status = 'active'` and returns when
   there is none (`:839-860`, `:1037-1050`, `:2058-2077`). Garmin is unconfigured and no account
   exists, so today the SSRF is **not reachable at all**.
4. The response is not returned to the caller. Activity summaries are parsed and enqueued
   (`:925-940`); file bytes are parsed as FIT/GPX and stored on `eventActivity.stream`
   (`:2136-2146`). So this is blind SSRF plus a stored-parse surface, not an open proxy.
5. **The serious part is not the SSRF, it is the bearer token.** All three fetches send
   `Authorization: Bearer <the user's Garmin access token>` to whatever host survived validation
   (`:951-957`, `:1227-1232`, `:2125-2131`). An attacker who knows a connected user's Garmin
   `externalUserId` — an identifier that travels through Garmin's own webhooks — can have the API
   hand that user's Garmin OAuth token to a server they control. There is also a persistence angle:
   an unmatched activity-file ping caches the attacker's URL in Redis for an hour
   (`storePendingFile`, `:965-984`) to be fetched later when the activity appears.

**What an allowlist would have to permit.** Garmin's production callbacks come from
`apis.garmin.com` (Health/Activity API service endpoints under
`https://apis.garmin.com/wellness-api/rest/…` and `https://apis.garmin.com/activity-api/rest/…`).
A host allowlist of `apis.garmin.com` — ideally plus a path-prefix check — would permit every
legitimate callback and close both the SSRF and the token-exfiltration path. This should be
**verified against Garmin's partner documentation before implementation**, not taken from this
document: the fork has no partner access and the endpoint list above is from the code's own base
URLs and public API docs, not from a Garmin contract.

### Recommendation for the routes

**Neutralize the provider webhook routes that no configured integration needs, at the edge, not in
upstream code.**

Concretely, in order of preference:

1. **Preferred — deny at the reverse proxy.** The web service already renders `nginx.conf` at
   startup from a fork-owned template (`apps/web/nginx.conf`, recorded in `doc/fork-delta.md`), but
   the API is reached directly, so this only helps for paths routed through nginx. Where the API is
   public, this option does not apply as-is; keep it in mind if the topology ever puts a proxy in
   front of the API.
2. **Recommended — a fork-owned NestJS middleware** that returns 404 for a configured list of paths,
   registered from a fork-owned module, driven by an env variable such as
   `DISABLED_ROUTES=/provider/polar/webhook,/provider/suunto/webhook,/provider/garmin/webhook`.
   This is "a new module that calls upstream interfaces, in its own directory" — level 3 of the
   customization hierarchy — and it touches exactly one upstream line (its registration in
   `app.module.ts`). It disposes of all seven unused webhook routes at once, is reversible by
   changing a variable when Garmin is approved, and cannot conflict with upstream edits to the
   provider services.
3. **Not recommended — per-handler guards** inside `provider-oauth.controller.ts`. Upstream edits
   that file often; every guard is a future conflict.
4. **Rejected — deleting the controller or the provider services.** Modify/delete conflicts forever,
   and it breaks Strava with them.

**Independently of the disposition**, two fixes are worth carrying because they protect the
integrations the fork *does* intend to run:

- Make Polar's signature verification fail closed when the header is absent, and compare lengths
  before `timingSafeEqual`. Small, isolated, strong upstream candidate.
- Add a host allowlist to `getSafeGarminCallbackUrl`. Only needed before Garmin is configured, but
  it is the fix that turns the token-exfiltration path off. Also an upstream candidate.

Both belong in follow-up issues, not in this PR.

---

## Email: what the app actually needs

**What sends mail.** Exactly one place: `NotificationService.sendEmail`
(`apps/api/src/modules/notification/services/notification.service.ts:38-75`), driven by
`SendEmailEvent` through `apps/api/src/listeners/notification.listener.ts:15`. The message catalog
(`libs/shared/src/email/email.ts:49-86`) has eight templates; the ones this fork can actually
trigger are:

| Template | Trigger | Matters for one user? |
| --- | --- | --- |
| `password-reset` | `UserService.passwordResetRequest` (`apps/api/src/modules/auth/services/user.service.ts:293-311`) | **Yes** — the only account-recovery path |
| `welcome` | signup (`user.service.ts:229-239`) | No |
| `signup-notification` | signup, sent to `contact@openathlete.org` (`user.service.ts:240-252`) | No — and it mails *upstream's* address on every signup |
| `athlete-invitation*`, `coach-invitation*` | invitation services | No — single user, no coach |
| `subscription-confirmation` | Stripe webhook (`stripe-webhook.controller.ts:224`) | No — Stripe dormant |

So for a single-user deployment the entire question is **password reset**.

**With a placeholder today.** `sendEmail` wraps everything in try/catch and only logs
(`notification.service.ts:69-74`). "Forgot password" returns success and sends nothing. The sender
is `noreply@example.com`. Confirmed unchanged from #14.

**Is account recovery reachable without email?** Yes — through the database, and only through it.
`passwordResetRequest` creates a `Token` row *before* the email is attempted
(`user.service.ts:299-302`; `apps/api/src/modules/auth/services/token.service.ts:30-41`). The token
is a plain `randomUUID` stored in the `token` column and is valid for **15 minutes**
(`token.service.ts:20-21`). So the owner can:

1. Submit "forgot password" in the UI.
2. `SELECT token FROM token ORDER BY created_at DESC LIMIT 1;` on the Railway Postgres.
3. Open `${APP_URL}/auth/password-reset?token=<token>` within 15 minutes.

That is a genuine recovery path that needs no email and no password hashing knowledge — but it needs
Railway database access on hand, and it fails if the owner is locked out somewhere without it. The
alternative (writing an argon2 hash directly) additionally requires reproducing `HASH_PEPPER`.

**Conclusion: email is strongly advisable but not strictly mandatory.** That changes the
recommendation from "must configure Brevo" to "configure the cheapest thing that works".

### Options for a single user

| Option | Setup | Cost | Deliverability | Code change |
| --- | --- | --- | --- | --- |
| **Brevo free tier** | account, API key, verified sender (domain or single address) | €0, 300/day | good | none — it is what the code calls |
| **SMTP relay via a personal mailbox** (Gmail app password, Fastmail) | app password | €0 | good | **yes** — `NotificationService` speaks the Brevo SDK, not SMTP; needs a nodemailer path in an upstream file |
| **Resend / Mailgun / Postmark** | account + API key + domain verify | €0 tier | good | **yes** — same problem as SMTP |
| **No email** | none | €0 | n/a | none, but see below |

The comparison is decided by a fact about the code rather than about the providers:
`NotificationService` is hard-wired to `@getbrevo/brevo` (`notification.service.ts:1,30-35`).
*Any* alternative provider is a rewrite of an upstream service — the highest-conflict change in this
whole document — to save €0, because Brevo's free tier already costs nothing. "Lighter than Brevo"
is a real preference, but the lighter option is not lighter once the fork has to carry the adapter.

**Recommendation: Configure Brevo's free tier.** One account, one API key, one verified single
sender (`BREVO_FROM_EMAIL`) — single-sender verification avoids DNS work entirely. Zero code, zero
fork delta, and it closes the recovery hole. Revisit only if Brevo's free tier changes.

**Two fixes to file alongside it** (not in this PR):

- `sendEmail` swallowing failures means the owner cannot tell a working configuration from a broken
  one. At minimum it should rethrow, or the password-reset path should surface a failure. Upstream
  candidate.
- The `signup-notification` mail to `contact@openathlete.org` (`user.service.ts:245`) sends this
  fork's user emails to upstream's mailbox once a real API key is configured. Configuring Brevo
  turns that on. It should be made configurable — or the address changed — **in the same change that
  sets the API key**, not after.

**Ongoing cost.** €0/month. Credential upkeep: Brevo API keys do not expire, but the verified sender
must remain a mailbox the owner controls, and Brevo deactivates accounts after long inactivity —
budget one login a year. Conflict surface: zero.

---

## AI features and plan gating

### What the AI features actually do

| Feature | Where | Gated by |
| --- | --- | --- |
| Generate a training event/plan from natural language | `POST /agent/ai/events/generate` (`apps/api/src/modules/agent/controllers/ai-features.controller.ts:45-48`) | `FeatureAccessGuard` + `AI_GENERATION` |
| Modify an existing event from natural language | `POST /agent/ai/events/modify` (`:317-320`) | `FeatureAccessGuard` + `AI_GENERATION` |
| Post-activity feedback questions, generated per activity | `apps/api/src/listeners/activity-feedback.listener.ts:83-85,209` | `canAccessFeatureForAthlete` + `AI_RPE_QUESTIONS` |
| RPE and injury extraction from free-text feedback | `apps/api/src/listeners/activity-feedback-extraction.listener.ts:124-160` | **nothing** |
| TRIMP estimation for training load | `apps/api/src/modules/queue/processors/training-load-estimation.processor.ts:167` | `ENABLE_TRAINING_LOAD_ESTIMATION` env flag only (`apps/api/src/modules/queue/queue.module.ts:286`) |
| Whisper voice-to-text for activity feedback | `POST /activity-feedback/transcribe` (`apps/api/src/modules/core/controllers/activity-feedback.controller.ts:43-45`) | **JWT only — no plan gate** |
| Coach QnA assistant over the athlete's own data | `apps/api/src/mastra/index.ts:8-48` | not currently exposed by a controller |

**Correction to the framing in #14 and #23:** "every AI endpoint sits behind `FeatureAccessGuard`" is
not accurate. Whisper transcription, RPE/injury extraction and TRIMP estimation all call OpenAI with
no plan check. **A valid `OPENAI_API_KEY` alone therefore does change something** — it turns on voice
transcription, RPE/injury extraction and AI training-load estimation immediately, for any
authenticated user, with no subscription change. It is the two headline endpoints — generate and
modify a training event — that stay locked.

### The smallest honest change that unlocks the rest

`FeatureAccessGuard` (`apps/api/src/modules/subscription/guards/feature-access.guard.ts:38-48`) →
`FeatureAccessService.canAccessFeature` (`…/services/feature-access.service.ts:22-27`) →
`SubscriptionService.hasAIFeaturesAccess` (`…/services/subscription.service.ts:411-419`), which reads
the user's `Subscription` row, checks the status is active, and returns
`PLAN_CONFIGS[plan].hasAIFeatures`. FREE is `false`
(`libs/shared/src/types/subscription.types.ts:44-50`); `ATHLETE_PRO` is `true` (`:51-58`). Stripe is
not consulted anywhere on this path.

So the smallest change is **one row of data**:

```sql
UPDATE subscription
SET plan = 'ATHLETE_PRO', status = 'active'
WHERE user_id = <owner's user id>;
```

Zero code. **Zero fork delta.** No Stripe, no `STRIPE_PRICE_IDS`, no webhook. The row is created
lazily by `getOrCreateSubscription` on first access, so run the UI once first, or insert the row.
It survives upstream integrations untouched, because it is not in the tree at all. It does not
survive a database reset — worth a line in the Railway runbook if it is applied.

The alternatives are all worse: flipping `hasAIFeatures` on FREE in
`libs/shared/src/types/subscription.types.ts` edits a central upstream file for every plan, which is
exactly the change `doc/fork-maintenance.md` warns against; short-circuiting `FeatureAccessGuard`
does the same to the security-relevant file.

### What it costs

Pay-as-you-go, no floor. The defaults are `openai/gpt-5.1` for generation, modification, RPE,
injury and TRIMP (`ai-models.constant.ts:19-60`), `whisper-1` for transcription, and
`text-embedding-3-small` for memory. For one athlete logging a handful of activities a week — a few
event generations, a handful of feedback extractions and the occasional voice note — this is
plausibly **single-digit euros a month**, dominated by whichever frontier model the generation
endpoints call, and adjustable downward with the `AI_MODEL_*` variables without touching code. That
is an estimate from model pricing and expected volume, not a measurement; the honest way to find out
is to set a low usage cap on the OpenAI account and watch one month.

**Recommendation: Configure OpenAI, and set the subscription row to `ATHLETE_PRO`, only if the owner
wants the event-generation features specifically.** The rest of the AI surface (transcription,
RPE extraction, TRIMP) comes with the key alone. If the answer is "not worth a bill", the current
state is already correct and costs nothing — this is the one decision where doing nothing is a
complete answer.

If it is configured: set a hard spend cap on the OpenAI account, and note that
`POST /activity-feedback/transcribe` accepts 25 MB uploads from any authenticated user with no plan
gate and no rate limit — on a single-user deployment that is acceptable, on an open signup it would
not be.

---

## Decision table

Each row is a proposal for the owner to approve, reject or amend. Each approved row becomes a
follow-up issue.

| # | Integration | Recommended disposition | Mechanics | Money | Fork delta |
| --- | --- | --- | --- | --- | --- |
| 1 | **Strava** | **Configure** | Strava API app; set `STRAVA_CLIENT_ID/SECRET/REDIRECT_URI/WEBHOOK_TOKEN`; register webhook subscription | €0 | none |
| 2 | Strava webhook token logging | **Fix** | remove the token from the log line at `provider-oauth.controller.ts:830-832` | — | 1 small edit, upstream candidate |
| 3 | **Brevo email** | **Configure** (free tier) | Brevo account + single verified sender; set `BREVO_API_KEY`, `BREVO_FROM_EMAIL` | €0 | none |
| 4 | `signup-notification` recipient | **Fix, with row 3** | `contact@openathlete.org` at `user.service.ts:245` must not receive this fork's signups | — | 1 small edit |
| 5 | `sendEmail` swallows failures | **Fix** | rethrow or surface failure (`notification.service.ts:69-74`) | — | 1 small edit, upstream candidate |
| 6 | **Garmin** | **Dormant** | leave `GARMIN_*` unset; revisit if partner approval is ever pursued | €0 | none |
| 7 | **Suunto** | **Dormant** | leave `SUUNTO_*` unset | €0 | none |
| 8 | **Coros** | **Dormant** | already disabled upstream; do nothing | €0 | none |
| 9 | **Polar** | **Dormant** + route closed (row 11) | keep `POLAR_*` placeholders (schema requires them) | €0 | none |
| 10 | **Stripe** | **Dormant, UI hidden** | keep `STRIPE_SECRET_KEY=sk_test_unconfigured`; set `VITE_DISABLE_PAYMENTS=true` on the web service | €0 | **none** |
| 11 | Unused provider webhook routes | **Neutralize** | fork-owned NestJS middleware returning 404 for a configurable path list; registered from a fork-owned module | — | 1 new module + 1 registration line |
| 12 | Polar signature verification | **Fix** | fail closed when the header is absent; length-check before `timingSafeEqual` (`polar.provider.service.ts:598-617`) | — | 1 small edit, upstream candidate |
| 13 | Garmin `callbackURL` host allowlist | **Fix before Garmin is ever configured** | allowlist `apis.garmin.com` in `getSafeGarminCallbackUrl` (`garmin.provider.service.ts:87-109`), verified against Garmin's partner docs | — | 1 small edit, upstream candidate |
| 14 | **Better Stack (web)** | **Neutralize** | move the hard-coded DSN in `error-monitoring.ts:5-6` behind `VITE_BETTER_STACK_DSN`; no-op when unset | €0 | 1 small edit, strong upstream candidate |
| 15 | **Better Stack (API)** | **Dormant** | leave `BETTER_STACK_DSN` unset unless error tracking is wanted | €0 | none |
| 16 | **Firebase** | **Dormant** | leave `VITE_FIREBASE_*` and `FIREBASE_SERVICE_ACCOUNT_JSON` unset; accept the dead "Continue with Google" button | €0 | none |
| 17 | Firebase dead button | **Optional fix** | hide the OAuth buttons when `VITE_FIREBASE_API_KEY` is unset (`oauth-buttons.tsx`) | — | 1 small edit |
| 18 | **OpenAI** | **Dormant**, unless AI wanted | if wanted: set `OPENAI_API_KEY` with a spend cap | ~€ single digits/mo | none |
| 19 | **Plan gating for AI** | **Data change**, only with row 18 | `UPDATE subscription SET plan='ATHLETE_PRO', status='active' WHERE user_id=…` | — | **none** |
| 20 | **Google Generative AI** | **Dormant**, unless AI wanted | if wanted: set `GOOGLE_GENERATIVE_AI_API_KEY` (free tier) and pin `AI_MODEL_POST_ACTIVITY_FEEDBACK` to a stable model | €0 | none |

Rows 2, 4, 5, 11, 12, 13, 14 are the ones that touch code. Everything else is a Railway variable, a
database row, or nothing at all.

## Corrections to #14

1. **The Garmin `callbackURL` SSRF is partially mitigated and currently unreachable.**
   `getSafeGarminCallbackUrl` (`garmin.provider.service.ts:87-109`) enforces HTTPS, no userinfo and
   port 443, and every fetch path requires an active Garmin `providerAccount`. What remains is the
   missing host allowlist and, more importantly, the fact that the user's Garmin bearer token is
   sent to the fetched host.
2. **"Every AI endpoint sits behind `FeatureAccessGuard`" is not true.** Whisper transcription
   (`activity-feedback.controller.ts:43-45`), RPE/injury extraction
   (`activity-feedback-extraction.listener.ts`) and TRIMP estimation
   (`training-load-estimation.processor.ts:167`) have no plan gate. An OpenAI key on its own does
   enable those.

Everything else in #14 verified as still accurate: the Polar signature skip, the unauthenticated
Strava/Garmin webhook POSTs, the silently-dropped email, the `noreply@example.com` sender, and
Stripe failing closed.

Two things #14 does not mention, both found here: the hard-coded upstream Better Stack DSN in the
web build, and `STRAVA_WEBHOOK_TOKEN` being written to the logs on every webhook verification.

## Fork-maintenance summary

Ranked by conflict risk, the recommended disposals are overwhelmingly at the cheap end:

- **Configuration only, no delta (rows 1, 3, 6, 7, 8, 9, 10, 15, 16, 18, 20)** — thirteen of the
  twenty rows are a Railway variable or a database row. Notably Stripe, the integration the issue
  worried about most, disposes of entirely through `VITE_DISABLE_PAYMENTS`, upstream's own flag.
- **A new fork-owned module (row 11)** — the webhook neutralization, one registration line in
  `app.module.ts`.
- **Small isolated edits to upstream files (rows 2, 4, 5, 12, 13, 14, 17)** — every one of them a
  bug fix rather than a fork preference, and five of the seven are upstream candidates. Each shrinks
  to zero if upstream accepts it.
- **No removals are recommended.** Nothing here meets the "upstream is unlikely to touch it again"
  bar; the provider services in particular are under active upstream development.

Each code-touching row, when implemented, must add its own entry to `doc/fork-delta.md` following
the existing format.
