/**
 * Backstop for disposable accounts leaked by a crashed Playwright run.
 *
 * The golden path deletes its own account via DELETE /user; this script cleans
 * up accounts a crash left behind. There is no admin "list users" endpoint, so
 * leaked accounts are discovered with a read-only query against the target
 * database (DATABASE_URL) and then removed through the real DELETE /user path so
 * the app's own cascade logic runs — the same teardown the convention promises.
 *
 * All disposable accounts share E2E_PASSWORD, so a leaked account can be logged
 * into and deleted. One that cannot be logged in is reported, not force-deleted.
 *
 * Refuses to run against production.
 */
import { Client } from 'pg';

import {
  TEST_EMAIL_DOMAIN,
  TEST_PASSWORD,
  apiDeleteAccount,
  apiLogin,
} from '../support/test-accounts';

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
      `SELECT email FROM "user" WHERE email LIKE $1`,
      [`qa+%@${TEST_EMAIL_DOMAIN}`],
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
