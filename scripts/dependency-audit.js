#!/usr/bin/env node
/**
 * Dependency audit with a committed baseline.
 *
 * `pnpm audit --audit-level=high --prod` is red today and will stay red for a
 * long time: the production tree still carries more than 100 high/critical
 * audit findings. A check that is permanently red teaches people to ignore
 * checks, so this wrapper reports on the *delta* instead.
 *
 * It fails only when a high or critical advisory appears that is not already
 * recorded in `.github/dependency-audit-baseline.json`. Everything else — the
 * full severity summary and the full high/critical advisory list — is printed
 * to the log every run so the number stays visible.
 *
 * What this catches: a newly published advisory against something already in
 * the tree, and any new high/critical advisory pulled in by a dependency
 * change.
 *
 * What this does NOT catch: the existing 88 baselined advisory IDs (that is the
 * point — they are tracked debt, not a per-pull-request signal), and anything
 * at moderate severity or below.
 *
 * Usage:
 *   node scripts/dependency-audit.js            # check, exit 1 on new findings
 *   node scripts/dependency-audit.js --update   # rewrite the baseline
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASELINE_PATH = path.resolve(
  process.cwd(),
  '.github',
  'dependency-audit-baseline.json'
);
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function runAudit() {
  // pnpm audit exits non-zero whenever it finds anything, so the exit code is
  // not a usable signal here — only the JSON body is.
  const result = spawnSync(
    'pnpm',
    ['audit', '--json', '--prod'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' }
  );

  if (result.error) {
    throw new Error(`could not run pnpm audit: ${result.error.message}`);
  }

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error(
      `pnpm audit produced no output (exit ${result.status}).\n${result.stderr || ''}`
    );
  }

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `pnpm audit did not return JSON (exit ${result.status}): ${err.message}`
    );
  }
}

function collectBlocking(report) {
  const advisories = Object.values(report.advisories || {});
  return advisories
    .filter((advisory) => BLOCKING_SEVERITIES.has(advisory.severity))
    .map((advisory) => ({
      id: advisory.github_advisory_id || `npm-${advisory.id}`,
      severity: advisory.severity,
      module: advisory.module_name,
      title: advisory.title,
      url: advisory.url,
    }))
    .sort(
      (a, b) => a.module.localeCompare(b.module) || a.id.localeCompare(b.id)
    );
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) {
    return { advisories: [] };
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

function writeBaseline(blocking) {
  const baseline = {
    $comment:
      'Known high/critical production advisories. Regenerate with `node scripts/dependency-audit.js --update`. Shrinking this list is the goal; growing it should be a deliberate decision.',
    generated: new Date().toISOString().slice(0, 10),
    advisories: [...new Set(blocking.map((item) => item.id))].sort(),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

function main() {
  const update = process.argv.includes('--update');
  const report = runAudit();
  const counts = (report.metadata && report.metadata.vulnerabilities) || {};
  const blocking = collectBlocking(report);

  console.log('Dependency audit (production tree)');
  console.log(
    `  findings by severity: critical=${counts.critical ?? 0} high=${counts.high ?? 0} ` +
      `moderate=${counts.moderate ?? 0} low=${counts.low ?? 0}`
  );
  console.log(`  dependencies scanned: ${report.metadata?.totalDependencies ?? 'unknown'}`);
  console.log(`  distinct high/critical advisories: ${blocking.length}`);
  console.log('');

  console.log('High/critical advisories:');
  for (const item of blocking) {
    console.log(`  [${item.severity}] ${item.module} — ${item.id}`);
    console.log(`      ${item.title}`);
    console.log(`      ${item.url}`);
  }
  console.log('');

  if (update) {
    const written = writeBaseline(blocking);
    console.log(
      `Baseline rewritten with ${written.advisories.length} advisory ids -> ${BASELINE_PATH}`
    );
    return;
  }

  const baseline = readBaseline();
  const known = new Set(baseline.advisories || []);
  const seen = new Set(blocking.map((item) => item.id));

  const introduced = blocking.filter((item) => !known.has(item.id));
  const resolved = [...known].filter((id) => !seen.has(id)).sort();

  if (resolved.length > 0) {
    console.log(
      `${resolved.length} baselined advisory id(s) are no longer present. ` +
        'Run `node scripts/dependency-audit.js --update` to prune the baseline:'
    );
    for (const id of resolved) {
      console.log(`  - ${id}`);
    }
    console.log('');
  }

  if (introduced.length === 0) {
    console.log(
      `No new high/critical advisories. ${known.size} known advisory id(s) remain baselined ` +
        'in .github/dependency-audit-baseline.json.'
    );
    return;
  }

  console.log(`${introduced.length} NEW high/critical advisory/advisories:`);
  for (const item of introduced) {
    console.log(`  [${item.severity}] ${item.module} — ${item.id}`);
    console.log(`      ${item.title}`);
    console.log(`      ${item.url}`);
  }
  console.log('');
  console.log(
    'Fix the advisory, or — if it is unavoidable transitive debt — accept it ' +
      'deliberately with `node scripts/dependency-audit.js --update` and say why in the pull request.'
  );
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`dependency-audit: ${err.message}`);
  process.exitCode = 1;
}
