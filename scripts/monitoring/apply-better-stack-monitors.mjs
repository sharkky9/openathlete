#!/usr/bin/env node
/**
 * Applies the uptime monitors declared in `infra/monitoring/better-stack-monitors.json`
 * to Better Stack. Monitors are matched by URL, so the script is idempotent:
 * existing monitors are patched, missing ones are created, and nothing is deleted.
 *
 * Usage:
 *   BETTER_STACK_UPTIME_API_TOKEN=... \
 *   API_URL=https://api.example.com \
 *   WEB_URL=https://app.example.com \
 *   node scripts/monitoring/apply-better-stack-monitors.mjs [--dry-run]
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = 'https://uptime.betterstack.com/api/v2/monitors';
const CONFIG_PATH = path.resolve(
  process.cwd(),
  'infra',
  'monitoring',
  'better-stack-monitors.json',
);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.BETTER_STACK_UPTIME_API_TOKEN;
  const apiUrl = trimSlash(process.env.API_URL);
  const webUrl = trimSlash(process.env.WEB_URL);

  if (!apiUrl || !webUrl) {
    fail('API_URL and WEB_URL must be set.');
  }
  if (!token && !dryRun) {
    fail('BETTER_STACK_UPTIME_API_TOKEN must be set (or pass --dry-run).');
  }

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const monitors = config.monitors.map((monitor) => ({
    ...monitor,
    url: monitor.url
      .replaceAll('{{API_URL}}', apiUrl)
      .replaceAll('{{WEB_URL}}', webUrl),
  }));

  if (dryRun) {
    console.log(JSON.stringify(monitors, null, 2));
    printLogAlerts(config.logAlerts);
    return;
  }

  const existing = await listMonitors(token);

  for (const monitor of monitors) {
    const match = existing.find(
      (item) => trimSlash(item.attributes.url) === trimSlash(monitor.url),
    );

    if (match) {
      await request(token, `${API_BASE}/${match.id}`, 'PATCH', monitor);
      console.log(`updated  ${monitor.pronounceable_name} (${monitor.url})`);
    } else {
      await request(token, API_BASE, 'POST', monitor);
      console.log(`created  ${monitor.pronounceable_name} (${monitor.url})`);
    }
  }

  printLogAlerts(config.logAlerts);
}

async function listMonitors(token) {
  const monitors = [];
  let url = `${API_BASE}?per_page=50`;

  while (url) {
    const body = await request(token, url, 'GET');
    monitors.push(...body.data);
    url = body.pagination?.next ?? null;
  }

  return monitors;
}

async function request(token, url, method, payload) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    fail(`${method} ${url} failed with ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

function printLogAlerts(logAlerts) {
  if (!logAlerts?.length) {
    return;
  }
  console.log(
    '\nLog-based alerts are not covered by the Uptime API. Create these in Better Stack Telemetry -> Alerts:',
  );
  for (const alert of logAlerts) {
    console.log(
      `  - ${alert.name}: source "${alert.source}", query \`${alert.query}\`, trigger when ${alert.threshold} (${alert.severity})`,
    );
  }
}

function trimSlash(value) {
  return value ? value.replace(/\/+$/, '') : value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
