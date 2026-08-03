# Third-party integration strategy

Status: **recommendation awaiting owner approval**

Research date: 2026-08-02

Decision owner: repository owner

This document recommends which third-party integrations this fork should maintain. It records decisions for approval; it does not configure a provider, procure credentials, change application behavior, or remove code.

## Recommendation in plain English

Keep every upstream integration's code so future upstream merges remain straightforward, but stop treating placeholder credentials as a safe disabled state. Add one configuration-level gate that both hides disabled connectors and prevents their routes and background handlers from running. No integration should be removed at this point.

I would make the following decisions:

- **Configure Brevo Free** for transactional email. Password recovery depends on working email, and keeping the existing provider is less fork work than replacing it.
- **Configure a repository-owner Better Stack project**, after making the web DSN optional and configurable. The current web build sends production telemetry to a DSN hard-coded by upstream.
- **Neutralize Strava, Garmin, Suunto, and Polar** until each connector is deliberately enabled. Their public webhook routes remain exposed even with unusable credentials. Strava also has a new policy problem: the current product architecture stores, analyzes, combines, and sends activity data to AI in ways its API policy now restricts.
- **Keep COROS, Firebase, and Google Generative AI dormant**. Preserve their upstream code, leave credentials unset, and hide their entry points. COROS is currently a mock/incomplete connector.
- **Neutralize Stripe and OpenAI**. There is no billing product, and the AI feature set is not yet worth the provider cost and fork delta. Stripe is not needed to grant AI access to a self-hosted user.
- Investigate **Intervals.icu as a separate future connector**. It is a better match for this owner's actual data sources and personal-scale use, but it is not one of the existing integrations and should not be smuggled into this decision.

The first implementation issue should be the common enablement gate, not eleven provider-specific deletions. That produces the lowest ongoing merge-conflict surface.

## What “disabled” means today

The Railway template supplies non-empty placeholders for many secrets (`infra/railway/variables.env.example:21-40`), while the API schema mostly checks only string or URL shape (`libs/shared/src/types/config/environments/api.environment.ts:89-325`). The providers module and its single controller are always registered (`apps/api/src/modules/providers-sync/providers-sync.module.ts:23-52`), and the static connector lists remain visible in onboarding and settings (`apps/web/src/components/connectors/connectors-list.tsx:39-47`, `apps/web/src/views/dashboard/settings-view/connectors-tab.tsx:50-56`). Therefore a placeholder is not an enablement control.

Observed outcomes fall into three classes:

- **Visibly broken:** clicking a connector starts OAuth with a placeholder or empty client ID; billing and Firebase buttons reach unconfigured handlers; password reset reports success even if Brevo rejects the message.
- **Silently degraded:** missing push-notification configuration is logged and skipped; an unset API Better Stack DSN produces no useful telemetry; some webhook events no-op when no active provider account matches.
- **Security or privacy liability:** public webhook routes remain reachable; Garmin accepts an attacker-supplied fetch URL; unsigned Polar requests can pass; Suunto signatures are not checked; and the web client sends production telemetry to an upstream-owned, hard-coded Better Stack DSN.

“Dormant” in this document means credentials are unset, all UI entry points are hidden by configuration, and no provider operation is reachable. The current code does not yet implement that definition.

## Disposition hierarchy and fork cost

From lowest to highest expected upstream conflict risk:

1. **Dormant:** retain upstream-identical code; use common configuration to omit the connector from UI and runtime registration. Reverify compilation at upstream integrations, but do not maintain provider behavior.
2. **Configure:** retain upstream-identical code and supply real credentials. This usually has little source conflict, but the fork owns runtime testing, credential renewal, provider policy compliance, and monetary cost.
3. **Neutralized:** retain the code but put its routes, handlers, jobs, and UI behind a small common guard. This adds a limited fork delta, ideally one that can be proposed upstream.
4. **Removed:** delete integration code. This creates recurring modify/delete conflicts when upstream touches the integration and should be reserved for abandoned upstream code.

At the current comparison point, the integration source files in this fork are identical to `openathleteorg/openathlete` at upstream commit `64a660bb`. Removal would turn a clean upstream relationship into a permanent merge-conflict surface. I recommend **no removals**, so this decision does not require an entry in `doc/fork-delta.md`. The eventual common guard and any self-hosted AI entitlement change should be recorded there when implemented.

## Proposed common disposal mechanism

The mechanics below are an implementation target, not changes made by this document.

1. Add `ENABLED_CONNECTOR_PROVIDERS` to `libs/shared/src/types/config/environments/api.environment.ts` and `VITE_ENABLED_CONNECTOR_PROVIDERS` to web configuration. The initial value should be empty. Only enabled providers should have required credential groups.
2. Add a provider-enabled decorator and guard, for example `apps/api/src/modules/providers-sync/guards/provider-enabled.guard.ts`. Apply it to OAuth URI/token operations and every fixed-provider webhook. A disabled provider should return `404` before reading a payload, looking up an account, fetching a URL, or calling a vendor.
3. Filter `apps/web/src/components/connectors/connectors-list.tsx` and `apps/web/src/views/dashboard/settings-view/connectors-tab.tsx` from the same public allowlist. Validate the provider in `apps/web/src/pages/auth/oauth-callback.tsx` against that allowlist as well.
4. Leave provider services and adapters in place and compiling. This preserves upstream compatibility while giving “unset” a real operational meaning.
5. Use separate booleans for non-connector systems: `STRIPE_ENABLED`, `AI_FEATURES_ENABLED`, and an optional `VITE_BETTER_STACK_DSN`. They have different route and UI shapes and should not be forced into the connector list.

Prefer returning `404` for disabled public webhooks so an installation does not advertise integrations it does not run. Tests should prove a disabled provider cannot reach its service, not merely that a button is hidden.

## Provider recommendations

### Strava — Neutralized

**What it does.** The API configuration requires client ID, client secret, OAuth callback URL, and webhook token (`libs/shared/src/types/config/environments/api.environment.ts:89-110`). `StravaProviderService` exchanges and refreshes tokens and imports activities (`apps/api/src/modules/providers-sync/providers/strava.provider.service.ts:74-92`, `apps/api/src/modules/providers-sync/providers/strava.provider.service.ts:225-252`). Public OAuth and webhook endpoints are in `ProviderOAuthController` (`apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:110-170`, `apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:785-889`). Strava appears in both onboarding and connector settings, with activity import and full-import capabilities (`apps/web/src/components/connectors/connectors-list.tsx:39-47`, `apps/web/src/views/dashboard/settings-view/connectors-tab.tsx:50-56`, `libs/shared/src/types/misc/core/provider-sync.ts:17-67`).

**Placeholder behavior.** The app boots, but OAuth redirects with the placeholder client ID and visibly fails at Strava. Webhook POST is public and unauthenticated. A spoofed create event must still match an active Strava owner account; if it does, it can trigger a fixed-host Strava API fetch and an import (`apps/api/src/modules/providers-sync/providers/strava.provider.service.ts:540-647`). The verification handler also logs both the received token and configured webhook token (`apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:813-835`), which turns a routine failure into secret leakage. There is no arbitrary-URL SSRF in the Strava handler, but leaving a stale active account raises the effect of forged callbacks.

**Why not configure it now.** Strava's API terms effective 2026-06-01 require an active paid Strava subscription for API access and initially limit a new app to its developer. More importantly, the policy prohibits several uses central to this application: using Strava API data for AI, analysis/analytics, combining it with other customers' data, and retaining it as a persistent archive beyond a limited cache. That conflicts with the current import, longitudinal analysis, multi-provider storage, and AI-feedback architecture. “I actively use Strava” does not resolve the policy mismatch.

**Mechanics.** Keep the service untouched; omit Strava from the common enabled-provider allowlist; leave all four secrets unset; hide Strava in the two UI lists; guard `GET /providers/strava/uri`, token/disconnect/import endpoints, and both webhook methods. Remove secret values from verification logs in the security follow-up. Open a separate policy/design issue before enabling it.

**Ongoing cost.** A paid Strava subscription is currently $11.99/month or $79.99/year in the United States, plus webhook operation, credential rotation, policy review, deletion/export compliance, and regression testing at every upstream integration. The policy redesign is a larger cost than the API bill.

Primary sources: [Strava Getting Started](https://developers.strava.com/docs/getting-started/), [API Agreement](https://www.strava.com/legal/api), [API Policy](https://www.strava.com/legal/api_policy), [webhooks](https://developers.strava.com/docs/webhooks/).

### Garmin — Neutralized

**What it does.** Garmin configuration is optional in the schema (`libs/shared/src/types/config/environments/api.environment.ts:112-127`). `GarminProviderService` implements OAuth, activity and health ping processing, FIT/GPX activity-file ingestion, deregistration, and permission-change handling (`apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts:112-130`, `apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts:838-963`, `apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts:2048-2184`). Five public Garmin POST handlers are registered in the common controller (`apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:891-1282`). Garmin appears in onboarding/settings and advertises activity, health, and training capabilities (`libs/shared/src/types/misc/core/provider-sync.ts:17-67`).

**Placeholder behavior.** With empty credentials, OAuth visibly fails. With no active Garmin account, most callback work no-ops, but the routes remain public. That is a contingent safety property, not a route closure; a stale or later-created account changes the result.

**Security finding.** The current URL check only requires HTTPS, no user information, and port 443/default (`apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts:87-110`). It does not restrict hostnames, reject public hostnames resolving to private/link-local addresses, or control redirects. In the activity ping path, an attacker who knows a valid Garmin user ID can make the server fetch an arbitrary HTTPS `callbackURL` with that user's stored Garmin bearer token—even when activity import is disabled (`apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts:838-963`). The response is not returned to the attacker, but the Authorization header is sent to the attacker-controlled host, so this is credential exfiltration as well as SSRF.

The activity-files path checks both an active account and import preference, then fetches the same attacker-controlled URL with the bearer token. A matching FIT/GPX response is parsed, compressed, stored, and queued; if the activity has not arrived yet, the URL is cached in Redis for one hour (`apps/api/src/modules/providers-sync/providers/garmin.provider.service.ts:2048-2184`). Thus the response is not reflected to the webhook caller, but it can reach internal network targets and affect stored application data.

For a legitimate implementation, the allowlist must contain exact Garmin callback hosts documented for the approved program—not arbitrary `*.garmin.com`. It must reject IP literals and any DNS result in loopback, private, link-local, carrier-grade NAT, or reserved ranges; use only port 443; and disable redirects or revalidate every redirect destination. The public material references `apis.garmin.com`, while examples also use `connectapi.garmin.com`; the exact callback set must come from the partner documentation before a route is opened.

**Why not configure it now.** Garmin's Connect Developer Program is for business use and requires approval. Garmin says the API itself has no licensing or maintenance fee for standard access, but review, contract/brand obligations, and a typical one-to-four-week integration project are disproportionate for a personal fork.

**Mechanics.** Keep the service; leave Garmin out of the enabled-provider allowlist; hide it from both UI lists; guard OAuth and all five public POST routes before request processing. A later enablement issue must add the exact-host/DNS/redirect protections above and tests that the bearer token can never leave Garmin-approved origins.

**Ongoing cost.** No standard API fee, but partner approval, OAuth credentials, brand compliance, operational webhook ownership, and a comparatively large security regression surface.

Primary sources: [Garmin program overview](https://developer.garmin.com/gc-developer-program/overview/), [program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/), [Activity API](https://developer.garmin.com/gc-developer-program/activity-api/), [brand guidelines](https://developer.garmin.com/downloads/brand/Garmin-Developer-API-Brand-Guidelines.pdf).

### Suunto — Neutralized

**What it does.** Suunto's client ID, client secret, subscription key, and callback URL are optional in the API schema (`libs/shared/src/types/config/environments/api.environment.ts:129-149`). Its service implements OAuth, workouts, activity and recovery import, and webhook ingestion (`apps/api/src/modules/providers-sync/providers/suunto.provider.service.ts:75-174`, `apps/api/src/modules/providers-sync/providers/suunto.provider.service.ts:993-1179`). The controller exposes a public POST webhook (`apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:1402-1513`). Suunto is shown in both connector UIs and advertises all provider-sync capabilities (`libs/shared/src/types/misc/core/provider-sync.ts:17-67`).

**Placeholder behavior.** OAuth visibly fails. The webhook does not verify Suunto's documented `X-HMAC-SHA256-Signature`. When no user ID resolves directly, an unauthenticated request can cause the service to enumerate active Suunto accounts and test the supplied workout key against Suunto's fixed API for each account (`apps/api/src/modules/providers-sync/providers/suunto.provider.service.ts:1053-1099`). The workout-key validation and fixed vendor host avoid arbitrary URL fetching, but the endpoint can still create vendor traffic and import work. It also logs the full callback body (`apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:1430-1437`).

**Why not configure it now.** Suunto describes its program as free for companies and organizations building public services, with application acceptance and a signed API agreement. That does not match a private personal fork, and the owner does not use Suunto.

**Mechanics.** Keep the service; leave credentials unset; omit Suunto from the enabled-provider allowlist; hide it in onboarding/settings; and guard OAuth and webhook routes. If it is ever enabled, verify the HMAC before logging or account lookup and add replay/size controls.

**Ongoing cost.** No published API fee, but provider application/agreement, subscription-key and OAuth upkeep, HMAC/webhook operation, data-erasure obligations, and upstream revalidation.

Primary sources: [Suunto API Zone](https://apizone.suunto.com/), [FAQ](https://apizone.suunto.com/faq), [webhooks](https://apizone.suunto.com/webhooks).

### Polar — Neutralized

**What it does.** Polar client credentials, webhook secret, and callback URL are required by the schema (`libs/shared/src/types/config/environments/api.environment.ts:168-197`). The service implements AccessLink OAuth, activity/metrics import, and webhook handling (`apps/api/src/modules/providers-sync/providers/polar.provider.service.ts:74-110`, `apps/api/src/modules/providers-sync/providers/polar.provider.service.ts:582-645`). A public Polar webhook is registered at `apps/api/src/modules/providers-sync/controllers/provider-oauth.controller.ts:1288-1395`. Polar is visible in both connector UIs and advertises activity and metrics import.

**Placeholder behavior and security finding.** Issue #14 is correct. A PING is accepted before verification; otherwise the signature is verified only inside `if (signature && this.webhookSecretKey)` (`apps/api/src/modules/providers-sync/providers/polar.provider.service.ts:582-617`). An absent signature therefore skips verification completely. A placeholder webhook secret also rejects legitimate signed payloads while unsigned payloads continue. After account matching, a forged request can trigger fixed-host Polar calls and import work.

**Why not configure it now.** Polar AccessLink is currently free and self-service for Polar Flow users, so it is more accessible than Garmin or Suunto. However, the owner has no Polar hardware and receives no product value from carrying live credentials and webhooks.

**Mechanics.** Keep the code, but neutralize it until the public route is safely closed: omit Polar from the common allowlist, make its secret group conditionally required, hide the UI, and guard OAuth/webhook operations. If ever enabled, require both a configured secret and a valid signature for every non-registration callback; never interpret a missing header as success.

**Ongoing cost.** No current API fee, but application credentials, a once-returned webhook signing secret that must be securely retained, webhook health (Polar deactivates persistently failing webhooks), and security revalidation.

Primary sources: [Polar AccessLink](https://www.polar.com/accesslink-api/), [API agreement](https://www.polar.com/en/legal/polar-api-agreement).

### COROS — Dormant

**What it does.** COROS is scaffolded but not integrated. Its environment configuration is commented out (`libs/shared/src/types/config/environments/api.environment.ts:151-166`), the service hard-codes empty credentials (`apps/api/src/modules/providers-sync/providers/coros.provider.service.ts:10-34`), and its adapter is explicitly a mock that generates fake IDs rather than calling COROS (`apps/api/src/modules/providers-sync/adapters/coros.adapter.ts:9-38`). The settings card is commented out, although the generic API controller and OAuth callback still recognize `coros` (`apps/web/src/pages/auth/oauth-callback.tsx:17-99`).

**Placeholder behavior.** It cannot complete OAuth or real synchronization. There is no COROS-specific public webhook handler in this repository, so it lacks the direct webhook liability of the four providers above. Generic routes should still reject it while disabled.

**Recommendation and mechanics.** Preserve upstream's work-in-progress unchanged. Do not add credentials; exclude COROS from the API/web allowlists; keep its settings card hidden; and have the common route guard reject generic COROS OAuth/import requests. Do not remove it: upstream is still the likely owner of this incomplete integration, so deletion would maximize future conflicts.

**Ongoing cost.** Near-zero vendor cost while dormant; compilation and upstream-merge verification only. A future official app requires COROS identity/security review, with pricing, limits, and SLA not publicly committed.

Primary sources: [COROS API applications](https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application), [supported partner apps](https://support.coros.com/hc/en-us/articles/360040256531-Supported-3rd-Party-Apps).

### Brevo email — Configure

**What it does.** `NotificationService` directly creates a Brevo client from `BREVO_API_KEY` and sends from `BREVO_SENDER` (`apps/api/src/modules/notification/services/notification.service.ts:20-75`). Email types cover password reset, welcome, subscription confirmation, athlete invitation, coach invitation, and signup notification (`libs/shared/src/email/email.ts:5-88`). Registration emits welcome/signup messages and password reset emits its reset link (`apps/api/src/modules/auth/services/user.service.ts:229-252`, `apps/api/src/modules/auth/services/user.service.ts:293-315`). Athlete and coach invitation services also emit mail (`apps/api/src/modules/auth/services/athlete-invitation.service.ts:96-180`, `apps/api/src/modules/auth/services/coach-invitation.service.ts:98-183`). A second direct Brevo client sends unread-message notifications from a per-minute scheduler (`apps/api/src/modules/messages/services/message-notification.scheduler.ts:14-36`, `apps/api/src/modules/messages/services/message-notification.scheduler.ts:162-195`). Replacing Brevo therefore requires more than swapping one notification adapter.

**Placeholder behavior.** The Railway sender is `noreply@example.com` and the API key is a placeholder (`infra/railway/variables.env.example:33-34`). `sendEmail` catches and only logs provider failures (`apps/api/src/modules/notification/services/notification.service.ts:68-74`). The forgot-password endpoint returns after emitting the event, and the web view shows success (`apps/api/src/modules/auth/controllers/user.controller.ts:292-335`, `apps/web/src/views/auth/password-reset-request-view.tsx:17-23`), even when no message is sent. The message scheduler likewise catches failures and can retry/log every minute while an unread notification remains due.

There is no independent administrator or recovery-code flow. The password-reset token arrives only by email. Without email, a forgotten password is unrecoverable through the product; recovery requires direct database/operator intervention. Firebase login could incidentally rescue a user whose matching OAuth identity is already usable, but it is not a password-recovery design. Email is therefore mandatory for the intended authentication experience.

**Options considered.** Brevo Free currently allows 300 sends/day for one user, though free-plan branding remains; it requires an API key and verified sender/domain. An existing personal-mailbox SMTP relay avoids a new vendor but couples the app to a high-value mailbox credential, creates an email abstraction fork, and inherits mailbox sending limits/security policies. Resend has lighter developer ergonomics and a 3,000-email/month, 100/day free tier, but requires domain verification and code changes in two call sites. Postmark's free developer tier is only 100 emails/month before a paid plan. “No email” makes self-service recovery nonfunctional.

**Recommendation and mechanics.** Configure Brevo Free with a repository-owner account, a verified sender/domain, and a real sender address. Keep `BREVO_API_KEY` and `BREVO_SENDER` required because email is an intentionally enabled dependency. Add a follow-up to expose delivery failure operationally and correct the account-enumeration mismatch: `UserService` currently throws for an unknown reset email (`apps/api/src/modules/auth/services/user.service.ts:293-298`) even though the controller documentation says requests should be silently accepted.

**Ongoing cost.** $0 at this scale; sender/domain verification, API-key rotation, monitoring the free quota/branding, and periodic delivery testing. This is less maintenance than a provider replacement and has minimal upstream conflict.

Primary sources: [Brevo plans](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans), [Free-plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan), [transactional email API](https://developers.brevo.com/docs/send-a-transactional-email), [sender verification](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email), [Resend pricing](https://resend.com/pricing), [Postmark pricing](https://postmarkapp.com/pricing/).

### Stripe billing — Neutralized

**What it does.** The subscription module always registers Stripe services and controllers (`apps/api/src/modules/subscription/subscription.module.ts:12-23`). `StripeService` throws at construction if the secret is absent (`apps/api/src/modules/subscription/services/stripe.service.ts:15-37`), and checkout/subscription routes call it (`apps/api/src/modules/subscription/controllers/subscription.controller.ts:40-50`, `apps/api/src/modules/subscription/controllers/subscription.controller.ts:134-269`). The public webhook verifies Stripe signatures and fails closed on verification errors (`apps/api/src/modules/subscription/controllers/stripe-webhook.controller.ts:41-98`, `apps/api/src/modules/subscription/services/stripe.service.ts:305-321`). The settings subscription tab and paywall/checkout dialog are visible in the web app (`apps/web/src/views/dashboard/settings-view/settings-view.tsx:56-86`, `apps/web/src/components/paywall/paywall-dialog.tsx:41-121`).

**Placeholder behavior.** A non-empty fake secret lets the client construct, so the app boots. Billing calls visibly fail, price IDs are missing, and the billing UI advertises a product that does not exist. The signed webhook itself is not an unauthenticated liability—it rejects invalid signatures—but it should not be public for a product that has no billing.

**Recommendation and mechanics.** Add `STRIPE_ENABLED=false` and its web equivalent. Make Stripe client construction lazy or conditional; guard checkout, portal, and webhook handlers; hide the subscription/billing UI. Preserve subscription reads and feature-access logic because they are domain functions independent of payment collection. Leave Stripe source in place and credentials unset.

**Ongoing cost.** $0 while neutralized. If enabled, Stripe has no base monthly fee but standard online card pricing is 2.9% + 30¢ and Stripe Billing adds usage-based fees; it also adds product/price configuration, webhook secrets, tax/refund/support obligations, and recurring upstream testing.

Primary sources: [Stripe pricing](https://stripe.com/pricing), [Billing pricing](https://stripe.com/billing/pricing), [API keys](https://docs.stripe.com/keys), [webhooks](https://docs.stripe.com/webhooks).

### OpenAI — Neutralized

**What it does.** OpenAI is not one feature. The configured model map defaults event generation, modification, injury extraction, perceived-exertion extraction, and planned-TRIMP estimation to `openai/gpt-5.1`; Q&A defaults to `openai/gpt-4o` (`apps/api/src/common/constants/ai-models.constant.ts:18-60`). The user-visible or background feature set is:

1. Generate a structured training event from natural language (`apps/api/src/modules/agent/controllers/ai-features.controller.ts:45-176`).
2. Modify an existing event/workout conversationally (`apps/api/src/modules/agent/controllers/ai-features.controller.ts:317-451`).
3. Generate post-activity feedback questions (`apps/api/src/listeners/activity-feedback.listener.ts:82-93`, `apps/api/src/listeners/activity-feedback.listener.ts:196-225`).
4. Extract RPE and injury information from answers (`apps/api/src/listeners/activity-feedback-extraction.listener.ts:14-25`, `apps/api/src/listeners/activity-feedback-extraction.listener.ts:124-200`).
5. Embed feedback for later retrieval in the same extraction listener.
6. Transcribe voice feedback with Whisper (`apps/api/src/modules/core/controllers/activity-feedback.controller.ts:43-75`, `apps/api/src/modules/core/services/activity-feedback.service.ts:304-365`).
7. Estimate planned training load in a queue worker (`apps/api/src/modules/queue/processors/training-load-estimation.processor.ts:37-52`, `apps/api/src/modules/queue/processors/training-load-estimation.processor.ts:149-203`).
8. A Q&A coach agent is assembled in `apps/api/src/mastra/index.ts`, but there is no clear current route/UI value comparable with the features above.

The web surfaces generation, modification, and feedback behind paywalls (`apps/web/src/components/calendar/calendar-day.tsx:271-313`, `apps/web/src/components/create-event-dialog/components/ai-modify-event-dialog.tsx:45-139`, `apps/web/src/components/event-details/activity-feedback-display-card.tsx:20-100`).

**Plan-gating finding.** The FREE plan has `hasAIFeatures: false`, while paid athlete plans enable it (`libs/shared/src/types/subscription.types.ts:36-75`). `FeatureAccessGuard` delegates AI access to the subscription service (`apps/api/src/modules/subscription/guards/feature-access.guard.ts:15-50`, `apps/api/src/modules/subscription/services/feature-access.service.ts:18-29`, `apps/api/src/modules/subscription/services/subscription.service.ts:401-419`). The event generation and modification endpoints use that guard.

The issue premise that *every* AI endpoint is guarded, and that a valid key alone changes nothing, is contradicted by the current code. Voice transcription has authentication/user-type guards but no `FeatureAccessGuard`; the feedback-extraction listener has no plan check; and the training-load queue worker has no plan check. With `ENABLE_TRAINING_LOAD_ESTIMATION=true` in the Railway template (`infra/railway/variables.env.example:42-45`), a real OpenAI key can incur spend outside the two guarded endpoints. The post-activity question listener does perform an AI plan check before generation.

**Smallest honest way to enable AI for one user.** A manual database change to give the owner an active `ATHLETE_PRO` subscription is the smallest no-code mechanism, and Stripe need not be configured because access checks read subscription state rather than proof of a Stripe payment. It is not honest product state: the UI says the user has a paid plan when no plan was sold, and the entitlement is an undocumented database operation.

The smallest honest persistent design is a self-hosted entitlement such as `SELF_HOSTED_AI_USER_IDS`, checked centrally in `feature-access.service.ts` or the subscription access path while the displayed plan remains FREE. Add the missing entitlement checks to transcription, feedback extraction, and training-load estimation. This touches central subscription/access code and the environment schema—the exact kind of fork delta warned about in `doc/fork-maintenance.md`—so it must be narrow, tested, proposed upstream as a self-hosting capability, and recorded in `doc/fork-delta.md` if it remains local.

**Placeholder behavior.** The fake key boots. Guarded UI calls paywall a FREE user, but the unguarded/background paths can reach OpenAI and fail noisily. If replaced by a real key without fixing entitlement coverage, those same paths can spend money unexpectedly.

**Recommendation and mechanics.** Set a global `AI_FEATURES_ENABLED=false` and web equivalent; hide all AI entry points; reject explicit AI routes; skip AI listeners and jobs before client invocation; set training-load estimation off; leave the OpenAI secret unset. Do not configure Stripe. If the owner later approves an AI trial, implement the self-hosted entitlement, choose every model ID explicitly, add project spend limits, and assess whether activity-source terms allow that data to be sent to AI.

**Ongoing cost.** Usage based. For scale, `gpt-4o-mini` is currently $0.15 per million input tokens and $0.60 per million output tokens, but this code defaults several tasks to different, potentially more expensive models. Whisper, embeddings, and all selected chat models must be budgeted separately. There is also model/version drift, prompt/evaluation work, safety/privacy review, and central-file merge conflict.

Primary sources: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing), [`gpt-4o-mini` pricing](https://developers.openai.com/api/docs/models/gpt-4o-mini).

### Google Generative AI — Dormant

**What it does.** Google is currently the default only for `AI_MODEL_POST_ACTIVITY_FEEDBACK`, set to `google/gemini-3-pro-preview` (`apps/api/src/common/constants/ai-models.constant.ts:18-60`). The API key is accepted by the shared environment schema (`libs/shared/src/types/config/environments/api.environment.ts:217-254`), and the post-activity listener uses the configured model after an AI-plan check (`apps/api/src/listeners/activity-feedback.listener.ts:82-93`, `apps/api/src/listeners/activity-feedback.listener.ts:196-225`). There is no separate Google connector UI.

**Placeholder behavior.** The app boots. A FREE user normally fails the plan check before the model call; an entitled user reaches the provider and gets a visible/logged generation failure. It becomes unexpected spend or data disclosure if entitlement is changed without aligning model/provider settings.

**Recommendation and mechanics.** Keep it dormant with no key while AI is globally disabled. If AI is later enabled using OpenAI only, set `AI_MODEL_POST_ACTIVITY_FEEDBACK` to an approved OpenAI model so a second provider is not required. Configure Gemini only if its specific model is measurably better and the owner accepts its data terms.

**Ongoing cost.** $0 dormant. Gemini has a free tier, but Google states that free-service prompts and responses may be used to improve products and may be reviewed by humans; paid-service terms differ. Paid use currently requires a minimum prepayment and adds a second credential, billing account, model lifecycle, privacy review, and test matrix.

Primary sources: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [terms](https://ai.google.dev/gemini-api/terms), [billing](https://ai.google.dev/gemini-api/docs/billing), [API keys](https://ai.google.dev/gemini-api/docs/api-key).

### Firebase — Dormant

**What it does.** Firebase service-account values and a functions URL are optional API configuration (`libs/shared/src/types/config/environments/api.environment.ts:284-296`). `FirebaseAuthService` validates a Firebase ID token for OAuth login and throws when its service account is missing (`apps/api/src/modules/auth/services/firebase-auth.service.ts:25-101`); the public auth route calls it (`apps/api/src/modules/auth/controllers/auth.controller.ts:90-100`). The Google OAuth button is always rendered on login/signup, while its utility requires four `VITE_FIREBASE_*` values and throws if they are missing (`apps/web/src/views/auth/oauth-buttons.tsx:71-92`, `apps/web/src/utils/firebase-auth.ts:22-47`). A push service posts notifications to the configured Firebase function and silently skips when its URL is absent (`apps/api/src/modules/notification/services/push-notification.service.ts:17-80`).

**Placeholder behavior.** Google sign-in is visibly broken but caught by the UI; push notification delivery silently degrades. There is no always-on Firebase public webhook comparable to provider sync.

**Recommendation and mechanics.** Keep credentials unset and upstream code intact; add a `VITE_FIREBASE_AUTH_ENABLED=false` gate around the OAuth buttons and reject the Firebase auth endpoint when disabled. Leave the optional push URL unset. Firebase can be configured later if Google login or push notifications become valuable.

**Ongoing cost.** Firebase's Spark plan can be used without payment information, and Authentication/Cloud Messaging have meaningful free usage, but a live configuration still requires a Google Cloud/Firebase project, OAuth consent/client maintenance, service-account key protection, function deployment for push, and auth regression testing.

Primary source: [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans), [Admin SDK setup](https://firebase.google.com/docs/admin/setup).

### Better Stack — Configure after fixing the hard-coded web DSN

**What it does.** The API initializes Sentry-compatible telemetry from optional `BETTER_STACK_DSN` with traces and profiles sampled at 100% (`apps/api/src/instrument.ts:1-9`), and the app always installs a global Sentry exception filter (`apps/api/src/modules/app.module.ts:32-72`). The web app initializes production error monitoring from `apps/web/src/main.tsx:28`. Its utility contains an upstream hard-coded DSN and enables browser tracing and replay, with 25% trace sampling, 10% session replay, and 100% error replay (`apps/web/src/utils/error-monitoring.ts:5-26`). Text is masked, but media is not blocked.

**Placeholder behavior and liability.** An absent API DSN produces no useful API telemetry. The web behavior is different: production builds send errors, traces, and sampled replays to the hard-coded upstream project regardless of the fork owner's Railway secret. That is an active data-disclosure/privacy liability, not a dormant integration.

**Recommendation and mechanics.** First replace the constant with optional `VITE_BETTER_STACK_DSN`; return before initialization when unset; and review/reduce production trace, profile, and replay sampling for a personal app. Record that small change in `doc/fork-delta.md` until it is upstreamed. Then create a repository-owner Better Stack Free project and configure both API and web DSNs. If the owner declines observability, the same optional configuration cleanly neutralizes it by leaving both DSNs unset.

**Ongoing cost.** Better Stack offers a free personal-project allowance suitable for this scale. Operational cost is account ownership, retention/privacy review, release/source-map setup if desired, alert tuning, and ensuring captured health/activity data is appropriate. Conflict risk is low after the hard-coded DSN becomes a standard optional environment value.

Primary source: [Better Stack pricing](https://betterstack.com/pricing).

## Webhook and callback threat assessment

### Does a dormant integration still expose routes?

**Yes, today.** `ProvidersSyncModule` always registers `ProviderOAuthController`, all provider services, and the scheduler (`apps/api/src/modules/providers-sync/providers-sync.module.ts:23-52`). Its public methods do not consult whether a provider is enabled. Missing credentials may cause a later lookup or vendor call to fail, but the request has already reached the handler. “We do not use Polar” is therefore not a security control.

The verified current state is:

| Route family | Authentication/integrity today | Consequence |
| --- | --- | --- |
| Strava webhook GET/POST (`provider-oauth.controller.ts:785-889`) | Verification GET uses a shared token; POST has no signature. The failure path logs configured token material. | Spoofed events can trigger fixed-host activity fetch/import for a matching active account. |
| Garmin POST handlers (`provider-oauth.controller.ts:891-1282`) | No application authentication or callback signature. | Attacker-controlled HTTPS fetch with a user's bearer token; internal fetch, credential-exfiltration, caching, parsing, storage, and queue effects depending on handler/state. |
| Polar webhook (`provider-oauth.controller.ts:1288-1395`) | Missing signature skips verification in `polar.provider.service.ts:582-617`. | Unsigned spoof can reach account/vendor/import logic. |
| Suunto webhook (`provider-oauth.controller.ts:1402-1513`) | Documented HMAC is not checked. | Unauthenticated requests can fan out fixed-host checks across active accounts and trigger imports. |

The security-closing mechanism is the common server-side enabled-provider guard, with an empty default allowlist. UI hiding alone is insufficient. Provider-specific signature and SSRF defenses are still prerequisites before any affected provider is enabled. Credentials and active-account rows for disabled providers should also be removed as defense in depth, but neither substitutes for closing the route.

## Email decision

The app needs email for more than marketing: password reset, welcome messages, signup notification, coach and athlete invitations, unread-message notification, and subscription confirmation. Only subscription confirmation disappears with Stripe. The others remain product behavior.

For this single-user deployment, the decision is:

1. Configure Brevo Free now with a verified sender.
2. Add delivery-failure observability and test password-reset delivery.
3. Do not introduce a generic mail abstraction until a second real requirement justifies it.
4. Do not claim email is optional unless a new recovery mechanism is implemented. Without it, password loss means direct database/operator recovery.

This keeps the fork closest to upstream and has a lower credential blast radius than using an existing personal mailbox's SMTP credentials.

## AI, entitlement, and Stripe decision

Stripe does not technically gate AI. `FeatureAccessGuard` asks the subscription service whether the current stored subscription is active/trialing and its plan includes AI; it does not contact Stripe while authorizing a request. Billing is one way upstream changes subscription state, not a runtime dependency of inference.

The honest single-user path, if the owner later decides the seven implemented AI capabilities justify the bill, is:

1. Keep Stripe disabled.
2. Add an explicit self-hosted entitlement for the owner in the central feature-access path.
3. Apply it consistently to event generation/modification, transcription, feedback extraction/embedding, feedback questions, and training-load estimation.
4. Configure one AI provider and explicit model IDs, with provider-side spend limits.
5. Verify each activity source's terms before sending imported data to that provider.

Until that issue is approved, disable AI globally. A real OpenAI key by itself is neither sufficient nor safe: two main endpoints remain paywalled, while several background or auxiliary paths are not consistently gated.

## Decision table for line-by-line approval

Each row should become one follow-up issue after approval. “Approve” means approving the recommendation and named mechanics, not authorizing this document's PR to implement them.

| Approve? | Integration | Recommended disposition | Concrete follow-up mechanics | Proposed follow-up issue |
| --- | --- | --- | --- | --- |
| ☐ | Strava | **Neutralized** | Common API/UI allowlist; guard OAuth/import/webhooks; unset four keys; remove token logging; require policy-compatible redesign before enablement. | `Neutralize Strava and document API-policy blockers` |
| ☐ | Garmin | **Neutralized** | Guard OAuth and five POST handlers; hide UI; unset keys; before enablement add exact-host, DNS-range, port, and redirect validation. | `Close Garmin callbacks and harden callbackURL fetching` |
| ☐ | Suunto | **Neutralized** | Guard OAuth/webhook; hide UI; unset keys; require documented HMAC before any future enablement. | `Neutralize Suunto and verify webhook signatures` |
| ☐ | Polar | **Neutralized** | Guard OAuth/webhook; hide UI; make keys conditional; if enabled, reject every missing/invalid signature. | `Neutralize Polar and make webhook authentication fail closed` |
| ☐ | COROS | **Dormant** | Preserve mock upstream code; omit from allowlists; keep UI hidden; no credentials. | `Declare COROS dormant until upstream completes the connector` |
| ☐ | Brevo | **Configure** | Owner account, verified sender/domain, real API key/sender; alert on failure; test password reset and invitations. | `Configure and verify transactional email delivery` |
| ☐ | Stripe | **Neutralized** | Add API/web enabled flag; lazy client; guard billing/webhook; hide billing UI; retain subscription/feature domain logic. | `Neutralize Stripe without removing subscription entitlements` |
| ☐ | OpenAI | **Neutralized** | Global API/web AI flag; skip all explicit/background inference; unset key; turn training-load estimation off. | `Neutralize all AI execution paths and close entitlement gaps` |
| ☐ | Google Generative AI | **Dormant** | No key; AI global off; if an OpenAI-only trial is approved, repoint feedback model to the chosen provider. | `Declare Gemini dormant and make model-provider selection explicit` |
| ☐ | Firebase | **Dormant** | Hide Google OAuth; reject Firebase auth while disabled; keep push URL unset; preserve upstream services. | `Make Firebase auth and push explicitly optional` |
| ☐ | Better Stack | **Configure**, after prerequisite | Replace hard-coded web DSN with optional env var; review sampling; configure owner-owned API/web DSNs. | `Move telemetry to an owner-controlled Better Stack project` |

No row recommends **Removed**. If upstream later abandons an integration and stops touching it, removal can be reconsidered with a `doc/fork-delta.md` entry and a measured conflict-cost comparison.

## Implementation sequence after approval

1. **Close exposure first.** Implement the common enabled-provider allowlist and server-side guard with an empty default. Cover all OAuth, import, and webhook routes with disabled-provider tests. Remove the hard-coded web telemetry DSN in the same security/privacy milestone.
2. **Make configuration truthful.** Stop using fake non-empty secrets as defaults. Require each credential group only when its provider is enabled, and align API and web flags.
3. **Restore essential operations.** Configure Brevo Free with a verified sender and verify reset/invitation delivery. Configure an owner-controlled Better Stack project after the DSN fix.
4. **Neutralize unused product systems.** Gate Stripe billing/UI and all AI entry/background paths. Leave subscription-domain logic and upstream provider implementations intact.
5. **Record the fork delta.** Add the generic guard, optional telemetry DSN, Stripe flag, and AI flag to `doc/fork-delta.md`; include exact files, rationale, upstream status, and revalidation tests. Propose generally useful self-hosting changes upstream.
6. **Evaluate the owner's actual data path.** Open a discovery issue for Intervals.icu and manual Garmin export before pursuing partner APIs. Intervals.icu offers personal API keys, activity/wellness/workout access, uploads, and webhooks with a 5,000-request/day personal-key allowance; COROS already supports it as a partner destination. A personal-key connector is a better eligibility match, but it still needs a data-flow and duplication design.
7. **Run an AI trial only if separately approved.** Establish the self-hosted entitlement, provider/model list, source-data permissions, evaluation criteria, and monthly spend ceiling first.

Primary sources for the future Intervals.icu issue: [Open API overview](https://www.intervals.icu/features/open-api/), [API cookbook](https://forum.intervals.icu/t/intervals-icu-api-integration-cookbook/80090), [personal API access](https://forum.intervals.icu/t/api-access-to-intervals-icu/609).

## Reverification checklist for future upstream integrations

At each upstream merge:

- Diff provider modules, public controllers, environment schemas, static connector UI lists, subscription access, AI listeners/workers, and telemetry initialization against the enablement gates.
- Assert every disabled webhook returns before service invocation, DB lookup, logging of payloads/secrets, or outbound fetch.
- Assert Garmin callback tests cover redirects, DNS rebinding/private ranges, IP literals, alternate ports, and Authorization-header confinement.
- Assert every AI provider call, including background listeners and queue processors, shares the same global enablement and user entitlement.
- Exercise password reset and invitations against the configured sender; do not treat a successful HTTP response as proof of delivery.
- Confirm production web telemetry uses only the repository owner's DSN and current privacy/sampling settings.
- Recheck provider terms and pricing before enabling or expanding any integration; code compatibility does not imply contractual eligibility.
