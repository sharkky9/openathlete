# Merge policy

`main` is protected by the `main-protection` ruleset. A pull request can only merge once these
status checks pass:

- `Run linter`
- `TypeScript type checking`
- `Build API`
- `Build Web`
- `Web image builds and serves the SPA`
- `API image boots, migrates and serves requests`
- `API unit tests (Jest)`
- `Playwright golden path (signup to delete)`

Those eight are the whole gate. **Zero approving reviews are required, by design**: the fork is
driven by a single maintainer plus agents, so a human approval requirement would only add a step
nobody is waiting on. CI status is the merge criterion — if the checks are green the change is
considered good enough to land, which puts the burden on the checks rather than on a reviewer.

Merges are squash merges, and the head branch is deleted afterwards. Force pushes to `main` and
deletion of `main` are blocked; the repository admin can bypass the ruleset.

The `Auto-merge` workflow (`.github/workflows/auto-merge.yml`) turns on GitHub auto-merge for pull
requests opened by a trusted author (currently `sharkky9`, `chrishandel-faire` and
`devin-ai-integration[bot]`), so a pull request squash-merges itself as soon as every required
check is green. Auto-merge is a per-pull-request flag with no repository-wide equivalent and the
`pull_request_target` run only fires for pull requests opened after the workflow reached `main`, so
the workflow also sweeps open pull requests on a schedule to arm any that still have the flag off.

## Checks that run but are not required

Several workflows run on every pull request without being part of the ruleset. They are useful
signal and can be promoted to required checks later (that is a repository settings change, not a
change in this tree):

- `Format check`, `Website build`, `Dependency audit` and `Secret scan` (`.github/workflows/checks.yml`).
  `Dependency audit` is deliberately `continue-on-error` for now.

## Devin Review is retired

The fork previously required two extra checks, `Devin Review` and `Devin Review findings`, the
latter posted by a `Review gate` workflow that blocked merging while a Devin review thread was
unresolved. Devin is no longer used here. Both checks are gone from the ruleset and
`.github/workflows/review-gate.yml` has been deleted — it kept posting a `Devin Review findings`
status that stayed `pending` forever, which made every pull request read as `unstable`.
