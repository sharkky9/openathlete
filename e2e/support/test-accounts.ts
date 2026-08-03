/**
 * Disposable test-account convention from issue #16:
 *
 *   qa+<purpose>-<runid>@openathlete.test
 *
 * The `<runid>` ties an account to the CI run (or a local run) that created it,
 * so a leaked account is traceable and the purge script can safely reclaim it.
 * The `.test` TLD is reserved (RFC 6761) and can never be a real user.
 */

export const TEST_EMAIL_DOMAIN = 'openathlete.test';

/** A single strong password reused for all disposable accounts. */
export const TEST_PASSWORD = 'E2ePassw0rd!disposable';

/**
 * Stable identifier for the current run, embedded in every disposable email.
 *
 * Precedence:
 *  - `E2E_RUN_ID` — an explicit id. Export the SAME value for the test run and a
 *    later `PURGE_OWN_RUN=1` teardown to reclaim exactly that run's accounts
 *    locally (a bare `local-<timestamp>` fallback differs between the two
 *    processes, so teardown would otherwise match nothing).
 *  - `GITHUB_RUN_ID` — in CI, so a leaked account traces back to the workflow run
 *    and the post-run teardown targets it without extra setup.
 *  - `local-<timestamp>` — default for ad-hoc local runs; unique so runs never
 *    collide (reclaimed by the default age-based backstop, not teardown mode).
 */
export const RUN_ID =
  process.env.E2E_RUN_ID ?? process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

/**
 * Build a disposable email for a given purpose, e.g. `golden-path`.
 * Lower-cased in full: the API lower-cases the whole address on signup, and the
 * purge script's `LIKE` lookups are case-sensitive, so a `RUN_ID` with uppercase
 * (e.g. a custom `E2E_RUN_ID`) would otherwise never match at cleanup time.
 */
export function testEmail(purpose: string): string {
  const safePurpose = purpose.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `qa+${safePurpose}-${RUN_ID}@${TEST_EMAIL_DOMAIN}`.toLowerCase();
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

/** Log in through the real API and return the access token. */
export async function apiLogin(
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(
      `Login failed for ${email}: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as LoginResponse;
  return body.accessToken;
}

/** Delete the authenticated account via DELETE /user. Returns the HTTP status. */
export async function apiDeleteAccount(accessToken: string): Promise<number> {
  const res = await fetch(`${API_BASE_URL}/user`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.status;
}

/**
 * Best-effort teardown: log in and delete. Never throws, so it is safe to call
 * from an `afterAll` even if the account was already deleted by the test body.
 */
export async function tryDeleteAccount(
  email: string,
  password: string,
): Promise<void> {
  try {
    const token = await apiLogin(email, password);
    await apiDeleteAccount(token);
  } catch {
    // Account already gone (deleted by the test) or never created — nothing to do.
  }
}
