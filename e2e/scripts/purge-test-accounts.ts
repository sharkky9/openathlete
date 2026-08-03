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

// Only purge accounts older than this many minutes, so a concurrently running
// suite's freshly created account (against a shared, non-ephemeral target) is
// never deleted mid-test. Override with PURGE_MIN_AGE_MINUTES.
const MIN_AGE_MINUTES = Number(process.env.PURGE_MIN_AGE_MINUTES ?? 60);

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

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let leaked: string[];
  try {
    const res = await client.query<{ email: string }>(
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
