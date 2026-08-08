#!/usr/bin/env node
/**
 * Reconcile OpenAthlete's production uptime monitors and backup heartbeat in
 * Better Stack. This script is dependency-free and requires Node 22 or newer.
 *
 * Dry-run is the default and does not need a token:
 *
 *   node scripts/monitoring/apply-better-stack-monitors.mjs --dry-run
 *
 * Applying changes requires BETTER_STACK_UPTIME_API_TOKEN and is idempotent:
 * existing monitors are matched by URL, while the heartbeat is matched by
 * name. Unchanged resources are left alone.
 *
 * The heartbeat ping URL is a credential and is never printed. To capture it
 * after an apply, set BACKUP_HEARTBEAT_URL_OUTPUT to a local path. The file is
 * written with mode 0600 and should then be copied into Railway's production
 * backup service as the BACKUP_HEARTBEAT_URL secret.
 *
 * Environment:
 *   API_URL                         API base URL or /health/ready URL
 *   WEB_URL                         production web URL
 *   BETTER_STACK_UPTIME_API_TOKEN   required only when applying
 *   BETTER_STACK_TEAM_NAME          optional; needed by global API tokens
 *   BETTER_STACK_ALERT_EMAIL        true by default
 *   BETTER_STACK_ALERT_SMS          false by default
 *   BETTER_STACK_ALERT_CALL         false by default
 *   BETTER_STACK_ALERT_PUSH         false by default
 *   BACKUP_HEARTBEAT_URL_OUTPUT     optional secure output file
 *   DRY_RUN                         true by default; --apply overrides it
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BETTER_STACK_API_URL = "https://uptime.betterstack.com/api/v2";
const DEFAULT_API_URL = "https://ultracully-api.up.railway.app/health/ready";
const DEFAULT_WEB_URL = "https://ultracully.up.railway.app/";
const HEARTBEAT_NAME = "OpenAthlete production backup";
const MANAGED_MONITOR_FIELDS = Object.freeze([
  "pronounceable_name",
  "url",
  "monitor_type",
  "expected_status_codes",
  "http_method",
  "check_frequency",
  "request_timeout",
  "follow_redirects",
  "verify_ssl",
  "email",
  "sms",
  "call",
  "paused",
]);
const MANAGED_HEARTBEAT_FIELDS = Object.freeze([
  "name",
  "period",
  "grace",
  "server_timezone",
  "email",
  "sms",
  "call",
  "push",
  "paused",
]);

class FatalError extends Error {}

let tokenForRedaction = "";

const redact = (value) => {
  let text = String(value ?? "");
  if (tokenForRedaction) {
    text = text.split(tokenForRedaction).join("***REDACTED***");
  }
  return text.replace(
    /https:\/\/uptime\.betterstack\.com\/api\/v1\/heartbeat\/[^\s"']+/gi,
    "***HEARTBEAT_URL_REDACTED***",
  );
};

const log = (message = "") => console.log(redact(message));
const section = (title) => {
  log("");
  log(`=== ${title} ===`);
};

const parseBoolean = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new FatalError(`${name} must be the literal string "true" or "false".`);
};

const normalizeUrl = (name, raw, { readiness = false } = {}) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FatalError(`${name} must be an absolute http(s) URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new FatalError(`${name} must use http or https.`);
  }
  url.hash = "";
  if (readiness && !url.pathname.endsWith("/health/ready")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/health/ready`;
    url.search = "";
  }
  if (!readiness && url.pathname === "") url.pathname = "/";
  return url.toString();
};

const parseArgs = () => {
  const args = new Set(process.argv.slice(2));
  const allowed = new Set(["--apply", "--dry-run", "--help"]);
  const unknown = [...args].filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    throw new FatalError(`Unknown argument(s): ${unknown.join(", ")}`);
  }
  if (args.has("--apply") && args.has("--dry-run")) {
    throw new FatalError("Choose either --apply or --dry-run, not both.");
  }
  if (args.has("--help")) {
    log("Usage: apply-better-stack-monitors.mjs [--dry-run | --apply]");
    log(
      "Dry-run is the default. See the file header for environment variables.",
    );
    return null;
  }
  if (args.has("--apply")) return { dryRun: false };
  if (args.has("--dry-run")) return { dryRun: true };
  return { dryRun: parseBoolean("DRY_RUN", true) };
};

const withTeam = (payload) => {
  const teamName = process.env.BETTER_STACK_TEAM_NAME?.trim();
  return teamName ? { ...payload, team_name: teamName } : payload;
};

const desiredResources = () => {
  const alerting = Object.freeze({
    email: parseBoolean("BETTER_STACK_ALERT_EMAIL", true),
    sms: parseBoolean("BETTER_STACK_ALERT_SMS", false),
    call: parseBoolean("BETTER_STACK_ALERT_CALL", false),
    critical_alert: parseBoolean("BETTER_STACK_ALERT_PUSH", false),
  });
  const apiUrl = normalizeUrl(
    "API_URL",
    process.env.API_URL?.trim() || DEFAULT_API_URL,
    { readiness: true },
  );
  const webUrl = normalizeUrl(
    "WEB_URL",
    process.env.WEB_URL?.trim() || DEFAULT_WEB_URL,
  );
  const monitorBase = {
    monitor_type: "expected_status_code",
    expected_status_codes: [200],
    http_method: "get",
    check_frequency: 180,
    request_timeout: 30,
    follow_redirects: true,
    verify_ssl: true,
    paused: false,
    ...alerting,
  };

  return {
    monitors: Object.freeze([
      withTeam({
        ...monitorBase,
        pronounceable_name: "OpenAthlete API readiness",
        url: apiUrl,
      }),
      withTeam({
        ...monitorBase,
        pronounceable_name: "OpenAthlete web",
        url: webUrl,
      }),
    ]),
    heartbeat: withTeam({
      name: HEARTBEAT_NAME,
      period: 86_400,
      grace: 10_800,
      server_timezone: "UTC",
      paused: false,
      email: alerting.email,
      sms: alerting.sms,
      call: alerting.call,
      push: alerting.critical_alert,
      critical_alert: alerting.critical_alert,
    }),
  };
};

const safeErrorDetail = async (response) => {
  try {
    return redact((await response.text()).slice(0, 500));
  } catch {
    return "(response body unavailable)";
  }
};

const apiRequest = async (pathOrUrl, { method = "GET", body } = {}) => {
  const url = new URL(pathOrUrl, `${BETTER_STACK_API_URL}/`);
  if (url.origin !== new URL(BETTER_STACK_API_URL).origin) {
    throw new FatalError("Better Stack returned an unsafe pagination URL.");
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tokenForRedaction}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    throw new FatalError(`Could not reach Better Stack: ${cause?.message}`);
  }

  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    throw new FatalError(
      `Better Stack ${method} ${url.pathname} returned HTTP ${response.status}: ${detail}`,
    );
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new FatalError(
      `Better Stack ${method} ${url.pathname} returned invalid JSON.`,
    );
  }
};

const listAll = async (resource) => {
  const items = [];
  let next = `${resource}`;
  const visited = new Set();
  while (next) {
    if (visited.has(next))
      throw new FatalError(`Pagination loop listing ${resource}.`);
    visited.add(next);
    const body = await apiRequest(next);
    if (!Array.isArray(body?.data)) {
      throw new FatalError(
        `Better Stack returned an invalid ${resource} listing.`,
      );
    }
    items.push(...body.data);
    next = body?.pagination?.next ?? null;
  }
  return items;
};

const canonical = (value) => {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return JSON.stringify(value ?? null);
};

const observedField = (attributes, field) => {
  if (field === "paused" && attributes?.paused === undefined) {
    return attributes?.paused_at != null;
  }
  return attributes?.[field];
};

const hasDesiredFields = (attributes, desired, fields) =>
  fields.every(
    (field) =>
      canonical(observedField(attributes, field)) === canonical(desired[field]),
  );

const findUnique = (items, predicate, description) => {
  const matches = items.filter((item) => predicate(item?.attributes ?? {}));
  if (matches.length > 1) {
    throw new FatalError(
      `Found ${matches.length} Better Stack resources matching ${description}; ` +
        "refusing to guess which one to update.",
    );
  }
  return matches[0] ?? null;
};

const reconcileMonitor = async (existingMonitors, desired) => {
  const existing = findUnique(
    existingMonitors,
    (attributes) => attributes.url === desired.url,
    `monitor URL ${desired.url}`,
  );
  if (!existing) {
    await apiRequest("monitors", { method: "POST", body: desired });
    log(`created monitor: ${desired.pronounceable_name}`);
    return "created";
  }
  if (hasDesiredFields(existing.attributes, desired, MANAGED_MONITOR_FIELDS)) {
    log(`unchanged monitor: ${desired.pronounceable_name}`);
    return "unchanged";
  }
  await apiRequest(`monitors/${encodeURIComponent(existing.id)}`, {
    method: "PATCH",
    body: desired,
  });
  log(`updated monitor: ${desired.pronounceable_name}`);
  return "updated";
};

const reconcileHeartbeat = async (existingHeartbeats, desired) => {
  const existing = findUnique(
    existingHeartbeats,
    (attributes) => attributes.name === desired.name,
    `heartbeat name ${desired.name}`,
  );
  if (!existing) {
    const body = await apiRequest("heartbeats", {
      method: "POST",
      body: desired,
    });
    log(`created heartbeat: ${desired.name}`);
    return { result: "created", url: body?.data?.attributes?.url };
  }
  if (
    hasDesiredFields(existing.attributes, desired, MANAGED_HEARTBEAT_FIELDS)
  ) {
    log(`unchanged heartbeat: ${desired.name}`);
    return { result: "unchanged", url: existing.attributes?.url };
  }
  const body = await apiRequest(
    `heartbeats/${encodeURIComponent(existing.id)}`,
    {
      method: "PATCH",
      body: desired,
    },
  );
  log(`updated heartbeat: ${desired.name}`);
  return {
    result: "updated",
    url: body?.data?.attributes?.url ?? existing.attributes?.url,
  };
};

const writeHeartbeatUrl = async (heartbeatUrl) => {
  const output = process.env.BACKUP_HEARTBEAT_URL_OUTPUT?.trim();
  if (!output) {
    log(
      "heartbeat URL not printed; set BACKUP_HEARTBEAT_URL_OUTPUT to capture it securely",
    );
    return;
  }
  if (!heartbeatUrl) {
    throw new FatalError("Better Stack did not return the heartbeat ping URL.");
  }
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${heartbeatUrl}\n`, { mode: 0o600 });
  log(`heartbeat URL written securely to ${outputPath}`);
};

const run = async () => {
  const options = parseArgs();
  if (!options) return;
  const desired = desiredResources();

  section(options.dryRun ? "DRY RUN" : "APPLY");
  log(`API target: ${desired.monitors[0].url}`);
  log(`Web target: ${desired.monitors[1].url}`);
  log("Check frequency: 180s; request timeout: 30s; expected status: 200");
  log("Backup heartbeat: every 86400s with 10800s grace");
  log(
    `Alerts: email=${desired.heartbeat.email}, sms=${desired.heartbeat.sms}, ` +
      `call=${desired.heartbeat.call}, push=${desired.heartbeat.push}`,
  );

  if (options.dryRun) {
    log("No Better Stack resources were read or changed.");
    return;
  }

  tokenForRedaction = process.env.BETTER_STACK_UPTIME_API_TOKEN?.trim() ?? "";
  if (!tokenForRedaction) {
    throw new FatalError(
      "BETTER_STACK_UPTIME_API_TOKEN is required with --apply.",
    );
  }

  const [existingMonitors, existingHeartbeats] = await Promise.all([
    listAll("monitors"),
    listAll("heartbeats"),
  ]);
  const monitorResults = [];
  for (const monitor of desired.monitors) {
    monitorResults.push(await reconcileMonitor(existingMonitors, monitor));
  }
  const heartbeatResult = await reconcileHeartbeat(
    existingHeartbeats,
    desired.heartbeat,
  );
  await writeHeartbeatUrl(heartbeatResult.url);

  section("RESULT");
  log(`Monitors: ${monitorResults.join(", ")}`);
  log(`Heartbeat: ${heartbeatResult.result}`);
};

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redact(`ERROR: ${message}`));
  if (!(error instanceof FatalError) && process.env.DEBUG === "true") {
    console.error(redact(error?.stack));
  }
  process.exitCode = 1;
}
