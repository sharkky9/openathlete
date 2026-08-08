#!/usr/bin/env node
/**
 * Delete production third-party credentials from Railway's NON-PRODUCTION
 * environments (staging and the ephemeral PR previews created from it).
 *
 * Background (issue #47): staging and every PR preview were duplicated from
 * production, so they hold byte-identical copies of the live third-party
 * credentials. Copies of a live secret cannot be "rotated" in place — they have
 * to be removed. Merged PR #44 made every one of these credentials genuinely
 * optional at boot (`libs/shared/src/types/config/environments/api.environment.ts`),
 * so deleting them degrades the corresponding feature and nothing else.
 *
 * Talks to the Railway public GraphQL API directly (no dependencies, global
 * `fetch`, Node >= 22) so the workflow needs no install step.
 *
 *   Endpoint : https://backboard.railway.com/graphql/v2
 *   Auth     : `Authorization: Bearer <token>`   (account / workspace / OAuth token)
 *              `Project-Access-Token: <token>`   (project token)
 *              Both are attempted, in that order — see resolveAuth().
 *
 * Operations used (all documented at docs.railway.com):
 *   query  { me { name } }                                    - probe an account token
 *   query  { projectToken { projectId environmentId } }       - probe a project token
 *   query  { projects { edges { node { id name } } } }        - discover the project
 *   query  { me { workspaces { team { projects ... } } } }    - discover it in a workspace
 *   query  project($id: String!)                              - environments + services
 *   query  variables($projectId:, $environmentId:, $serviceId:) - read variable map
 *   mutation variableDelete($input: VariableDeleteInput!)     - delete one variable
 *
 * SAFETY. Two hard guards, both compiled into this file and neither reachable
 * from any caller-supplied input:
 *
 *   1. PROTECTED_ENVIRONMENT_NAMES — the run aborts, before and after name
 *      resolution, if any target is a production environment. There is no flag,
 *      env var or workflow input that disables this.
 *   2. PROTECTED_VARIABLE_PREFIXES + PURGE_ALLOWLIST — a variable is deleted
 *      only when it is on the allow-list AND does not match the
 *      deny-list. `INTERVALS_ICU*` belongs to another workstream and is never
 *      touched.
 *
 * LOGGING. This log is the audit record and the repo runs a gitleaks secret
 * scan, so treat it as public: variable NAMES are printed, variable VALUES
 * never are. The `variables` query returns a `{ name: value }` map and its
 * response body is never logged — only `Object.keys(...)` of it.
 *
 * IDEMPOTENT. Deleting an absent variable is a no-op, not an error, so the
 * script is safe to run repeatedly (it has to be: a workflow_dispatch workflow
 * cannot be dispatched until it is on the default branch, so the first real run
 * happens after merge and may well be re-run).
 *
 * Environment:
 *   RAILWAY_TOKEN             (required) account, workspace or project token
 *   RAILWAY_PROJECT_ID_INPUT  project id typed at dispatch time; wins if set
 *   RAILWAY_PROJECT_ID        project id from the repository Actions variable
 *   DRY_RUN                   "true" (default) reports intent and changes nothing
 *   ENVIRONMENTS              comma-separated target names, default "staging"
 *
 * Supplying a project id is not optional in practice: automatic discovery is
 * best-effort, and when it comes back empty the id is the only way forward.
 *
 * Exit codes: 0 = clean (or dry run), 1 = failure / survivors / aborted guard.
 */

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

/**
 * GUARD 2a — the only variables this script is ever allowed to delete.
 * Exact match, no wildcards. Anything not on this list is left alone.
 */
const PURGE_ALLOWLIST = Object.freeze([
  'BREVO_API_KEY',
]);

/**
 * GUARD 2b — never delete a variable whose name starts with one of these,
 * whatever else says otherwise. `INTERVALS_ICU*` is owned by another
 * workstream. Checked independently of the allow-list, as defence in depth.
 */
const PROTECTED_VARIABLE_PREFIXES = Object.freeze(['INTERVALS_ICU']);

/**
 * GUARD 1 — environment names that are production and must never be touched.
 * Compiled in on purpose: no workflow input, CLI flag or environment variable
 * can add to, remove from or bypass this list.
 */
const PROTECTED_ENVIRONMENT_NAMES = Object.freeze(['production', 'prod', 'prd']);

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const normalizeEnvName = (name) => String(name ?? '').trim().toLowerCase();

/** GUARD 1 predicate. Applied to requested names AND to resolved API names. */
const isProtectedEnvironment = (name) =>
  PROTECTED_ENVIRONMENT_NAMES.includes(normalizeEnvName(name));

/** GUARD 2b predicate. */
const isProtectedVariable = (name) => {
  const upper = String(name ?? '').trim().toUpperCase();
  return PROTECTED_VARIABLE_PREFIXES.some((prefix) => upper.startsWith(prefix));
};

/** GUARD 2 — both halves. A variable is deletable only if this returns true. */
const mayDelete = (name) =>
  PURGE_ALLOWLIST.includes(name) && !isProtectedVariable(name);

// Fail at load time if the two halves of guard 2 ever contradict each other,
// i.e. if someone adds a protected name to the allow-list.
for (const name of PURGE_ALLOWLIST) {
  if (isProtectedVariable(name)) {
    throw new Error(
      `Refusing to run: allow-listed variable ${name} matches a protected prefix.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** A failure we can explain; printed as a message, never as a stack trace. */
class FatalError extends Error {}

let tokenForRedaction = '';

/** Belt and braces: never let the token itself reach the log. */
const redact = (text) => {
  const str = String(text ?? '');
  if (!tokenForRedaction) return str;
  return str.split(tokenForRedaction).join('***REDACTED***');
};

const log = (message = '') => console.log(redact(message));
const section = (title) => {
  log('');
  log(`=== ${title} ===`);
};
const fmtList = (names) => (names.length ? names.join(', ') : '(none)');

// ---------------------------------------------------------------------------
// Railway GraphQL client
// ---------------------------------------------------------------------------

/**
 * POST a GraphQL operation. Returns `data` on success.
 *
 * Never logs or returns the raw response body: `variables` responses contain
 * live credential VALUES. Errors surface only GraphQL `message` strings,
 * redacted and truncated.
 */
async function graphql(authHeaders, query, variables = {}) {
  let response;
  try {
    response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw new FatalError(
      `Could not reach the Railway API at ${RAILWAY_API_URL}: ${redact(cause?.message)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new FatalError(
      `Railway rejected the credential (HTTP ${response.status}). ` +
        'Check that RAILWAY_TOKEN is a valid account, workspace or project token ' +
        'and that it has access to this project.',
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new FatalError(
      `Railway returned a non-JSON response (HTTP ${response.status}).`,
    );
  }

  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    // Only the message field, capped — do not spread the whole error object,
    // which can carry the request payload.
    const messages = body.errors
      .map((error) => String(error?.message ?? 'unknown error'))
      .join('; ');
    const error = new Error(redact(messages).slice(0, 300));
    error.graphQLErrors = body.errors.map((e) => String(e?.message ?? ''));
    throw error;
  }

  if (!response.ok) {
    throw new FatalError(`Railway returned HTTP ${response.status}.`);
  }

  return body?.data ?? {};
}

/**
 * Work out which header shape this token wants. Railway accepts
 * `Authorization: Bearer` for account/workspace/OAuth tokens and
 * `Project-Access-Token` for project tokens; the two are not interchangeable,
 * so probe with the cheapest query for each and keep whichever answers.
 */
async function resolveAuth(token) {
  const accountHeaders = { Authorization: `Bearer ${token}` };
  try {
    const data = await graphql(accountHeaders, 'query { me { name } }');
    if (data?.me) {
      return { headers: accountHeaders, kind: 'account', projectToken: null };
    }
  } catch {
    // Fall through and try the project-token shape.
  }

  const projectHeaders = { 'Project-Access-Token': token };
  try {
    const data = await graphql(
      projectHeaders,
      'query { projectToken { projectId environmentId } }',
    );
    if (data?.projectToken?.projectId) {
      return {
        headers: projectHeaders,
        kind: 'project',
        projectToken: data.projectToken,
      };
    }
  } catch {
    // Fall through to the shared failure below.
  }

  throw new FatalError(
    'RAILWAY_TOKEN was not accepted as either an account/workspace token ' +
      '(Authorization: Bearer) or a project token (Project-Access-Token). ' +
      'Generate a token at https://railway.com/account/tokens and store it as ' +
      'the RAILWAY_TOKEN repository secret.',
  );
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const PROJECT_QUERY = `
  query project($id: String!) {
    project(id: $id) {
      id
      name
      environments { edges { node { id name } } }
      services { edges { node { id name } } }
    }
  }
`;

const unwrap = (connection) =>
  (connection?.edges ?? []).map((edge) => edge?.node).filter(Boolean);

/**
 * The project id the operator supplied, if any.
 *
 * PRECEDENCE: the `project_id` workflow_dispatch input
 * (RAILWAY_PROJECT_ID_INPUT) beats the RAILWAY_PROJECT_ID repository Actions
 * variable, so an id can be pasted at dispatch time without a round trip
 * through repository settings. Either one skips discovery entirely.
 */
const explicitProjectId = () => {
  const fromInput = process.env.RAILWAY_PROJECT_ID_INPUT?.trim();
  if (fromInput) return { id: fromInput, source: 'the project_id dispatch input' };

  const fromVariable = process.env.RAILWAY_PROJECT_ID?.trim();
  if (fromVariable) {
    return { id: fromVariable, source: 'the RAILWAY_PROJECT_ID repository variable' };
  }

  return { id: '', source: '' };
};

const tooManyProjects = (projects) =>
  new FatalError(
    'This token can see more than one Railway project, and this script will ' +
      'not guess which one to purge. Supply one of these ids as the ' +
      '`project_id` dispatch input or as the RAILWAY_PROJECT_ID repository ' +
      'variable:\n' +
      projects.map((p) => `  - ${p.name} (${p.id})`).join('\n'),
  );

/**
 * Last-resort discovery for a project owned by a workspace/team rather than by
 * the token owner personally. Only ever called when the root `projects` query
 * returned zero edges.
 *
 * STRICTLY ADDITIVE, AND DELIBERATELY SO. These field names come from Railway's
 * documentation, not from schema introspection — the same un-introspected guess
 * that produced the misdiagnosis this function exists to soften. So every error
 * is swallowed: if the query is rejected, the shape has changed, or it simply
 * finds nothing, the caller falls through to exactly the behaviour it had
 * before this function existed. It can only ever add an answer, never take one
 * away and never fail a run on its own.
 */
async function discoverWorkspaceProjects(auth) {
  try {
    const data = await graphql(
      auth.headers,
      'query { me { workspaces { team { projects { edges { node { id name } } } } } } }',
    );
    const workspaces = Array.isArray(data?.me?.workspaces)
      ? data.me.workspaces
      : [];
    return workspaces.flatMap((workspace) => unwrap(workspace?.team?.projects));
  } catch {
    return [];
  }
}

/** Pick the project to operate on, refusing to guess between several. */
async function resolveProjectId(auth) {
  const { id: explicitId, source: explicitSource } = explicitProjectId();

  if (auth.kind === 'project') {
    const tokenProjectId = auth.projectToken.projectId;
    if (explicitId && explicitId !== tokenProjectId) {
      throw new FatalError(
        `The project id ${explicitId} (from ${explicitSource}) does not match ` +
          `the project this project token belongs to (${tokenProjectId}).`,
      );
    }
    log(`Token kind      : project token (scoped to one project)`);
    return tokenProjectId;
  }

  log('Token kind      : account/workspace token');

  const data = await graphql(
    auth.headers,
    'query { projects { edges { node { id name } } } }',
  );
  const projects = unwrap(data?.projects);

  if (explicitId) {
    const match = projects.find((project) => project.id === explicitId);
    if (!match && projects.length > 0) {
      throw new FatalError(
        `The project id ${explicitId} (from ${explicitSource}) is not among ` +
          `the projects this token can see: ` +
          fmtList(projects.map((p) => `${p.name} (${p.id})`)),
      );
    }
    log(`Project id      : ${explicitId} (from ${explicitSource}; discovery skipped)`);
    return explicitId;
  }

  if (projects.length === 0) {
    // The root query answered, with an empty list. Try the workspace-scoped
    // query before giving up; it is best-effort and never throws (see above).
    const workspaceProjects = await discoverWorkspaceProjects(auth);

    if (workspaceProjects.length === 1) {
      log('Discovery       : root projects query was empty; found the project via a workspace');
      return workspaceProjects[0].id;
    }
    if (workspaceProjects.length > 1) {
      log('Discovery       : root projects query was empty; found several projects via workspaces');
      throw tooManyProjects(workspaceProjects);
    }

    throw new FatalError(
      'Project discovery found nothing. The token authenticated successfully, ' +
        'but the root `projects` query returned an empty list and no project ' +
        'was reachable through the token owner\'s workspaces either.\n' +
        'This is what it looks like when the project belongs to a workspace ' +
        '(team) rather than to the token owner directly — the token is fine, ' +
        'the project is simply not listed where these queries look.\n' +
        'Supply the project id and discovery is skipped altogether: paste it ' +
        'into the workflow\'s `project_id` dispatch input, or set the ' +
        'RAILWAY_PROJECT_ID repository Actions variable (Settings -> Secrets ' +
        'and variables -> Actions -> Variables). The id is in the Railway ' +
        'project URL and under project Settings -> General.',
    );
  }

  if (projects.length > 1) {
    throw tooManyProjects(projects);
  }

  return projects[0].id;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

const VARIABLES_QUERY = `
  query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }
`;

const VARIABLE_DELETE_MUTATION = `
  mutation variableDelete($input: VariableDeleteInput!) {
    variableDelete(input: $input)
  }
`;

/**
 * Variable NAMES in one scope, sorted. The response is a `{ name: value }` map
 * of live credentials — only its keys ever leave this function.
 */
async function readVariableNames(auth, projectId, environmentId, serviceId) {
  const data = await graphql(auth.headers, VARIABLES_QUERY, {
    projectId,
    environmentId,
    serviceId: serviceId ?? null,
  });
  return Object.keys(data?.variables ?? {}).sort();
}

const looksLikeNotFound = (error) =>
  (error?.graphQLErrors ?? [])
    .join(' ')
    .toLowerCase()
    .match(/not found|does not exist|no such/) !== null;

/**
 * Delete one variable. Returns 'deleted' | 'absent'.
 *
 * Both guards are re-asserted here, at the last possible moment before the
 * mutation, so no calling path can reach the API with an unapproved name.
 */
async function deleteVariable(auth, projectId, environmentId, serviceId, name) {
  if (!mayDelete(name)) {
    throw new FatalError(
      `Internal guard tripped: refusing to delete non-allow-listed variable ${name}.`,
    );
  }

  const input = { projectId, environmentId, name };
  // Shared (project-level) variables have no service; service variables do.
  if (serviceId) input.serviceId = serviceId;

  try {
    await graphql(auth.headers, VARIABLE_DELETE_MUTATION, { input });
    return 'deleted';
  } catch (error) {
    // Idempotency: an already-absent variable is a no-op, not a failure.
    if (looksLikeNotFound(error)) return 'absent';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseBoolean(raw, fallback) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(value)) return false;
  throw new FatalError(`DRY_RUN must be true or false, got "${raw}".`);
}

async function main() {
  // 1. Fail fast on a missing token.
  const token = process.env.RAILWAY_TOKEN?.trim();
  if (!token) {
    throw new FatalError(
      'RAILWAY_TOKEN is not set (or is empty).\n' +
        'This script needs a Railway account, workspace or project token with ' +
        'access to the OpenAthlete project.\n' +
        'In CI, add it as the RAILWAY_TOKEN repository secret ' +
        '(Settings -> Secrets and variables -> Actions).\n' +
        'Locally: RAILWAY_TOKEN=... node infra/railway/purge-nonprod-secrets.mjs',
    );
  }
  tokenForRedaction = token;

  // Default to a dry run: the destructive path must always be opted into.
  const dryRun = parseBoolean(process.env.DRY_RUN, true);

  const requested = [
    ...new Set(
      String(process.env.ENVIRONMENTS ?? 'staging')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];

  section('Railway non-production credential purge');
  log(`Mode            : ${dryRun ? 'DRY RUN (nothing will be changed)' : 'LIVE (variables will be deleted)'}`);
  log(`Requested envs  : ${fmtList(requested)}`);
  log(`Allow-list      : ${PURGE_ALLOWLIST.join(', ')}`);
  log(`Protected envs  : ${PROTECTED_ENVIRONMENT_NAMES.join(', ')} (never touched)`);
  log(`Protected vars  : ${PROTECTED_VARIABLE_PREFIXES.map((p) => `${p}*`).join(', ')} (never deleted)`);

  if (requested.length === 0) {
    throw new FatalError('ENVIRONMENTS resolved to an empty list.');
  }

  // GUARD 1, first application: on the requested names, before any network
  // call, so an attempt to target production never even authenticates.
  const requestedProduction = requested.filter(isProtectedEnvironment);
  if (requestedProduction.length > 0) {
    throw new FatalError(
      `Refusing to run: ${fmtList(requestedProduction)} is a production environment. ` +
        'This script only ever operates on non-production environments and the ' +
        'guard cannot be disabled.',
    );
  }

  // 2. Discover project, environments and services.
  const auth = await resolveAuth(token);
  const projectId = await resolveProjectId(auth);

  const projectData = await graphql(auth.headers, PROJECT_QUERY, {
    id: projectId,
  });
  const project = projectData?.project;
  if (!project) {
    throw new FatalError(`Railway returned no project for id ${projectId}.`);
  }

  const environments = unwrap(project.environments);
  const services = unwrap(project.services);

  log(`Project         : ${project.name} (${project.id})`);
  log(`Environments    : ${fmtList(environments.map((e) => e.name))}`);
  log(`Services        : ${fmtList(services.map((s) => s.name))}`);

  // 3. Resolve requested names to real environments.
  const targets = requested.map((name) => {
    const match = environments.find(
      (environment) => normalizeEnvName(environment.name) === normalizeEnvName(name),
    );
    if (!match) {
      throw new FatalError(
        `Environment "${name}" does not exist in project ${project.name}. ` +
          `Available: ${fmtList(environments.map((e) => e.name))}`,
      );
    }
    return match;
  });

  // GUARD 1, second application: on the names Railway actually returned, so a
  // target that resolves to production is caught even if the caller spelled it
  // differently or Railway renamed it between runs.
  const resolvedProduction = targets.filter((environment) =>
    isProtectedEnvironment(environment.name),
  );
  if (resolvedProduction.length > 0) {
    throw new FatalError(
      `Refusing to run: ${fmtList(resolvedProduction.map((e) => e.name))} resolved to a ` +
        'production environment. Aborting the entire run without deleting anything.',
    );
  }

  log(`Target envs     : ${fmtList(targets.map((e) => `${e.name} (${e.id})`))}`);

  // Scopes: Railway keeps shared (project-level) variables separately from
  // per-service ones, and `variables` reads whichever you ask for. Shared goes
  // first so a shared variable is gone before the service scopes are read.
  //
  // A service scope also reports the shared variables it inherits, so one
  // shared variable can show up under several scopes. That makes the counts
  // below occurrences rather than distinct variables — deliberately, since a
  // shared delete that fails must stay visible everywhere it still applies.
  const scopes = [
    { label: 'shared (project-level)', serviceId: null },
    ...services.map((service) => ({
      label: `service "${service.name}"`,
      serviceId: service.id,
    })),
  ];

  let plannedCount = 0;
  let deletedCount = 0;
  const failures = [];

  // 4/5. Purge pass.
  section(dryRun ? 'Purge pass (DRY RUN)' : 'Purge pass');
  for (const environment of targets) {
    log('');
    log(`--- environment: ${environment.name} ---`);
    for (const scope of scopes) {
      let names;
      try {
        names = await readVariableNames(
          auth,
          projectId,
          environment.id,
          scope.serviceId,
        );
      } catch (error) {
        failures.push(
          `read ${environment.name} / ${scope.label}: ${redact(error.message)}`,
        );
        log(`  ${scope.label}: ERROR reading variables - ${redact(error.message)}`);
        continue;
      }

      const doomed = names.filter(mayDelete);
      const protectedPresent = names.filter(isProtectedVariable);

      if (doomed.length === 0) {
        log(`  ${scope.label}: clean (${names.length} variables, none on the allow-list)`);
      } else {
        log(`  ${scope.label}: ${doomed.length} of ${names.length} variables match the allow-list`);
      }
      if (protectedPresent.length > 0) {
        log(`    protected, skipped: ${fmtList(protectedPresent)}`);
      }

      for (const name of doomed) {
        plannedCount += 1;
        if (dryRun) {
          log(`    WOULD DELETE  ${name}`);
          continue;
        }
        try {
          const outcome = await deleteVariable(
            auth,
            projectId,
            environment.id,
            scope.serviceId,
            name,
          );
          if (outcome === 'deleted') {
            deletedCount += 1;
            log(`    DELETED       ${name}`);
          } else {
            log(`    ALREADY GONE  ${name} (no-op)`);
          }
        } catch (error) {
          failures.push(
            `delete ${name} in ${environment.name} / ${scope.label}: ${redact(error.message)}`,
          );
          log(`    ERROR         ${name} - ${redact(error.message)}`);
        }
      }
    }
  }

  // 6/7. Verification pass — re-read everything and state the outcome.
  section('Verification (re-queried from Railway)');
  const survivors = [];
  for (const environment of targets) {
    log('');
    log(`--- environment: ${environment.name} ---`);
    for (const scope of scopes) {
      let names;
      try {
        names = await readVariableNames(
          auth,
          projectId,
          environment.id,
          scope.serviceId,
        );
      } catch (error) {
        failures.push(
          `verify ${environment.name} / ${scope.label}: ${redact(error.message)}`,
        );
        log(`  ${scope.label}: ERROR re-reading variables - ${redact(error.message)}`);
        continue;
      }

      log(`  ${scope.label} (${names.length} variables):`);
      log(`    ${fmtList(names)}`);

      for (const name of names.filter((n) => PURGE_ALLOWLIST.includes(n))) {
        survivors.push(`${environment.name} / ${scope.label} / ${name}`);
      }
    }
  }

  section('Result');
  if (dryRun) {
    log(`Would delete    : ${plannedCount} variable occurrence(s)`);
    log(`Still present   : ${survivors.length} allow-listed variable occurrence(s)`);
    for (const survivor of survivors) log(`  - ${survivor}`);
    if (failures.length > 0) {
      log('');
      log(`FAILURES (${failures.length}):`);
      for (const failure of failures) log(`  - ${failure}`);
      log('');
      log('VERDICT: FAIL - the dry run could not read every scope.');
      return 1;
    }
    log('');
    log('VERDICT: DRY RUN - nothing was changed.');
    log('Re-dispatch with dry_run = false to apply the deletions above.');
    return 0;
  }

  log(`Deleted         : ${deletedCount} variable occurrence(s)`);
  log(`Survivors       : ${survivors.length}`);
  for (const survivor of survivors) log(`  - ${survivor}`);
  if (failures.length > 0) {
    log('');
    log(`FAILURES (${failures.length}):`);
    for (const failure of failures) log(`  - ${failure}`);
  }

  log('');
  if (survivors.length === 0 && failures.length === 0) {
    log('VERDICT: PASS - none of the allow-listed production credentials remain in any target environment.');
    return 0;
  }
  log('VERDICT: FAIL - production credentials remain in a non-production environment, or a call failed.');
  log('Remove the remaining variables from the Railway dashboard and re-run this workflow.');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // Expected failures explain themselves; anything else keeps its stack so a
    // genuine bug is debuggable.
    if (error instanceof FatalError) {
      console.error(`\nERROR: ${redact(error.message)}`);
    } else {
      console.error(`\nUNEXPECTED ERROR: ${redact(error?.stack ?? error?.message ?? error)}`);
    }
    process.exitCode = 1;
  });
