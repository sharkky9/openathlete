/**
 * PostHog event names and small helpers for `apps/web` product analytics.
 * Do not send PII, free-text prompts, or raw error messages — use codes only.
 *
 * Manual verification: PostHog → Live events while walking through:
 * onboarding, OAuth connect, calendar CRUD, and messages.
 *
 * Suggested dashboards / funnels:
 * - Activation: user_signed_up → onboarding_step_completed → provider_connect_completed → event_created
 * - Retention (weekly): event_created, event_updated, messages_message_sent, provider_sync_preference_changed
 */

export const AnalyticsEvent = {
  onboarding_step_completed: 'onboarding_step_completed',
  onboarding_abandoned: 'onboarding_abandoned',
  provider_connect_initiated: 'provider_connect_initiated',
  provider_connect_completed: 'provider_connect_completed',
  provider_connect_failed: 'provider_connect_failed',
  provider_sync_preference_changed: 'provider_sync_preference_changed',
  event_deleted: 'event_deleted',
  event_duplicated: 'event_duplicated',
  event_template_saved: 'event_template_saved',
  messages_thread_created: 'messages_thread_created',
  messages_thread_deleted: 'messages_thread_deleted',
  messages_message_sent: 'messages_message_sent',
} as const;

export type AnalyticsEventName =
  (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/** Where OAuth was started (stored before redirect). */
export type OauthConnectSource = 'onboarding' | 'settings';

const OAUTH_CONNECT_SOURCE_SESSION_KEY = 'oa_ph_oauth_connect_source';

export function setOauthConnectSourceForRedirect(
  source: OauthConnectSource,
): void {
  try {
    sessionStorage.setItem(OAUTH_CONNECT_SOURCE_SESSION_KEY, source);
  } catch {
    // ignore quota / private mode
  }
}

export function consumeOauthConnectSource(): OauthConnectSource {
  try {
    const raw = sessionStorage.getItem(OAUTH_CONNECT_SOURCE_SESSION_KEY);
    sessionStorage.removeItem(OAUTH_CONNECT_SOURCE_SESSION_KEY);
    if (raw === 'onboarding' || raw === 'settings') {
      return raw;
    }
  } catch {
    // ignore
  }
  return 'settings';
}

/** Stable code for PostHog breakdowns (no raw message). */
export function analyticsErrorCodeFromUnknown(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0 && msg.length < 80) {
      return msg.replaceAll(/\s+/g, '_').slice(0, 64);
    }
  }
  return 'unknown_error';
}
