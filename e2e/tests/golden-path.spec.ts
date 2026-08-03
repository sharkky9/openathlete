import { expect, test } from '@playwright/test';

import {
  API_BASE_URL,
  TEST_PASSWORD,
  apiDeleteAccount,
  apiLogin,
  testEmail,
  tryDeleteAccount,
} from '../support/test-accounts';

/**
 * The one golden path from issue #24, item 2, exercised against the real
 * deployed images (production build + ephemeral Postgres/Redis):
 *
 *   sign up -> complete onboarding -> create a training event
 *   -> see it on the calendar -> delete the account via DELETE /user
 *
 * Deliberately a single path: a broad blind suite would be flaky, and a flaky
 * required check is worse than no check. Assertions are real; there are no
 * retries. If a step fails because the app is broken, that is a finding.
 */

const EMAIL = testEmail('golden-path');
const EVENT_NAME = `E2E Golden Path ${Date.now()}`;

test.afterAll(async () => {
  // Backstop for a crashed run that never reached the delete step.
  await tryDeleteAccount(EMAIL, TEST_PASSWORD);
});

test('signup -> onboarding -> create training event -> calendar -> delete account', async ({
  page,
}) => {
  // --- Sign up -------------------------------------------------------------
  await page.goto('/auth/create-account');
  await page.locator('input[name="firstName"]').fill('Qa');
  await page.locator('input[name="lastName"]').fill('Golden');
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();

  // Signup logs in automatically and routes to onboarding.
  await page.waitForURL('**/dashboard/onboarding', { timeout: 30_000 });

  // --- Complete onboarding (athlete only) ----------------------------------
  // Assert each step heading before advancing so the flow is deterministic and
  // a failure points at the exact step that changed.
  const next = () =>
    page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'Welcome to OpenAthlete!' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Get Started' }).click();

  await expect(
    page.getByRole('heading', { name: 'What describes you best?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: "I'm an athlete" }).click();
  await next();

  await expect(
    page.getByRole('heading', { name: 'Do you have a coach?' }),
  ).toBeVisible();
  await next();

  await expect(
    page.getByRole('heading', { name: 'Tell us about yourself' }),
  ).toBeVisible();
  await next();

  await expect(
    page.getByRole('heading', { name: 'Connect your devices' }),
  ).toBeVisible();
  await next();

  await expect(
    page.getByRole('heading', { name: "You're all set!" }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue to Dashboard' }).click();

  await page.waitForURL('**/dashboard**', { timeout: 30_000 });

  // --- Go to the calendar and create a training event ----------------------
  await page.goto('/dashboard/calendar');

  // Desktop: right-click a day cell to open the context menu, then "Plan a training".
  const today = new Date();
  const dayCell = page
    .locator('span', { hasText: new RegExp(`^${today.getDate()}$`) })
    .first();
  await dayCell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Plan a training' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Plan a Training')).toBeVisible();

  await dialog.locator('input[name="name"]').fill(EVENT_NAME);
  // Sport defaults to "Running" and the date is prefilled from the clicked day,
  // so name is the only required field left to submit a training event.
  await dialog.getByRole('button', { name: 'Create the Training' }).click();

  // --- See it on the calendar ----------------------------------------------
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText(EVENT_NAME).first()).toBeVisible({
    timeout: 15_000,
  });

  // --- Delete the account via DELETE /user ---------------------------------
  const token = await apiLogin(EMAIL, TEST_PASSWORD);
  const deleteStatus = await apiDeleteAccount(token);
  expect(deleteStatus).toBe(200);

  // The account is really gone: logging in again is rejected.
  const relogin = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: TEST_PASSWORD }),
  });
  expect(relogin.status).toBe(401);
});
