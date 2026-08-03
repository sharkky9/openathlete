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
 * Stable identifier for the current run. In CI this is the GitHub run id so a
 * leaked account can be traced back to the exact workflow run; locally it is a
 * timestamp so repeated local runs never collide.
 */
export const RUN_ID = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;

export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

/** Build a disposable email for a given purpose, e.g. `golden-path`. */
export function testEmail(purpose: string): string {
  const safePurpose = purpose.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `qa+${safePurpose}-${RUN_ID}@${TEST_EMAIL_DOMAIN}`;
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
