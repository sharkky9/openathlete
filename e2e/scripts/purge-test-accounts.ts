/**
 * Backstop for disposable accounts leaked by a crashed Playwright run.
 *
 * The golden path deletes its own account via DELETE /user; this script cleans
 * up accounts a crash left behind. There is no admin "list users" endpoint, so
 * leaked accounts are discovered with a read-only query against the target
 * database (DATABASE_URL) and then removed through the real DELETE /user path so
 * the app's own cascade logic runs — the same teardown the convention promises.
 *
 * All disposable accounts share TEST_PASSWORD, so a leaked account can be logged
 * into and deleted. One that cannot be logged in is reported, not force-deleted.
 *
 * To stay safe against a shared target, discovery skips the current run's own
 * accounts and only considers accounts older than a safety window, so a
 * concurrently running suite's in-flight account is never deleted mid-test.
 *
 * Refuses to run against production.
 */
import { Client } from 'pg';

import {
  RUN_ID,
  TEST_EMAIL_DOMAIN,
  TEST_PASSWORD,
  apiDeleteAccount,
  apiLogin,
} from '../support/test-accounts';

// Two modes:
//
// - Backstop (default): clean up accounts leaked by *other*, past runs against a
//   shared, long-lived target. It excludes the current run's own accounts and
//   only considers accounts older than a safety window, so a concurrently
//   running suite's in-flight account is never deleted mid-test.
//   Tune the window with PURGE_MIN_AGE_MINUTES (default 60).
//
// - Teardown (PURGE_OWN_RUN=1): the post-run teardown of *this* run — used by
//   the CI job right after the spec. It deletes only this run's own accounts
//   (scoped to RUN_ID) regardless of age, so a crash that skipped the in-spec
//   DELETE /user is still cleaned up, while other runs' accounts are untouched.
const MIN_AGE_MINUTES = Number(process.env.PURGE_MIN_AGE_MINUTES ?? 60);
const OWN_RUN = ['1', 'true', 'yes'].includes(
  (process.env.PURGE_OWN_RUN ?? '').toLowerCase(),
);

async function main(): Promise<void> {
  if (process.env.ENV === 'production') {
    throw new Error(
      'Refusing to purge with ENV=production. This script targets local/CI ' +
        'and disposable environments only.',
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to discover leaked accounts.');
  }

  console.log(
    OWN_RUN
      ? `Purge mode: teardown (this run only, RUN_ID=${RUN_ID}).`
      : `Purge mode: backstop (other runs, older than ${MIN_AGE_MINUTES}m).`,
  );

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let leaked: string[];
  try {
    const res = OWN_RUN
      ? await client.query<{ email: string }>(
          // teardown: only this run's own accounts, regardless of age
          `SELECT email FROM "user" WHERE email LIKE $1`,
          [`qa+%-${RUN_ID}@${TEST_EMAIL_DOMAIN}`],
        )
      : await client.query<{ email: string }>(
          // backstop: other runs' accounts, older than the safety window
          `SELECT email FROM "user"
           WHERE email LIKE $1
             AND email NOT LIKE $2
             AND created_at < NOW() - make_interval(mins => $3::int)`,
          [
            `qa+%@${TEST_EMAIL_DOMAIN}`,
            `qa+%-${RUN_ID}@${TEST_EMAIL_DOMAIN}`,
            MIN_AGE_MINUTES,
          ],
        );
    leaked = res.rows.map((r) => r.email);
  } finally {
    await client.end();
  }

  if (leaked.length === 0) {
    console.log('No leaked disposable accounts found.');
    return;
  }

  console.log(`Found ${leaked.length} disposable account(s) to purge.`);
  let deleted = 0;
  const failures: string[] = [];

  for (const email of leaked) {
    try {
      const token = await apiLogin(email, TEST_PASSWORD);
      const status = await apiDeleteAccount(token);
      if (status === 200) {
        deleted += 1;
        console.log(`Deleted ${email}`);
      } else {
        failures.push(`${email} (DELETE returned ${status})`);
      }
    } catch (err) {
      failures.push(`${email} (${(err as Error).message})`);
    }
  }

  console.log(`Purged ${deleted}/${leaked.length} account(s).`);
  if (failures.length > 0) {
    console.warn(`Could not purge:\n  ${failures.join('\n  ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
