# Fork maintenance

`sharkky9/openathlete` is a fork of [`openathleteorg/openathlete`](https://github.com/openathleteorg/openathlete).
It is maintained as **upstream + a deliberately small, documented patch set**, not as an independent
codebase that happened to start from an open-source project. Every departure from upstream is
recorded in [`fork-delta.md`](./fork-delta.md).

## Remotes

```bash
git remote add upstream https://github.com/openathleteorg/openathlete.git
git fetch upstream --tags
```

`origin` is this fork, `upstream` is the original project. Upstream currently publishes **no tags or
releases**, so integration targets a commit on `upstream/main` rather than a version. Pick a commit,
record its SHA and date in the upgrade PR, and treat it as the release under test.

## Upgrade workflow

Run this on a cadence (review upstream monthly, integrate quarterly unless a security fix forces it):

```bash
git fetch upstream
git checkout -b upgrade/upstream-$(date +%Y-%m-%d) main
git merge upstream/main          # merge, never rebase: main is shared and protected
```

Then, in order:

1. Resolve conflicts. Check them against `fork-delta.md` — every conflict should map to an entry
   there. A conflict in a file with no entry means the delta document is stale.
2. Read upstream's commit log since the last integration for behavioural and config changes.
3. Apply database migrations (`pnpm database run db:generate`, then `db:migrate`).
4. Reconcile `infra/railway/variables.env.example` with any new/renamed environment variables.
5. Run the checks in [`merge-policy.md`](./merge-policy.md): lint, `pnpm tsc:check`, builds, and the
   deployment smoke workflow (which is the fork-specific compatibility test).
6. Run each entry's "upgrade test" from `fork-delta.md`.
7. Deploy the branch to a Railway staging service before merging.
8. Merge the upgrade PR into `main`.

A clean merge is not a passing upgrade: merges succeed while still introducing behavioural
incompatibilities.

## Where customizations go

Prefer, in this order:

1. Configuration and environment variables (`infra/railway/variables.env.example`).
2. Existing upstream extension points.
3. New modules that call upstream interfaces, in their own directory.
4. Small, isolated edits to upstream files — each one recorded in `fork-delta.md`.
5. Broad changes to upstream internals — avoid; these make future upgrades a reimplementation
   rather than an upgrade.

Concretely: deployment, infrastructure and operations material belongs under `infra/`, `scripts/`
and `.github/workflows/` files that upstream does not own. Do not scatter fork-specific conditions
through the application, do not rename upstream concepts, and do not restructure upstream
directories.

Deleting an upstream file is a worse patch than neutralizing it in place: a deletion produces a
modify/delete conflict every time upstream touches the file. Where an upstream workflow does not
apply to this fork, guard it (see the `github.repository` condition in
`.github/workflows/deploy.yml`) instead of removing it.

## Contributing back

Changes that are not specific to this fork — bug fixes in upstream scripts, new extension points —
should be proposed upstream. Every change accepted upstream shrinks the patch set that has to be
carried forever. `fork-delta.md` marks which entries are upstream candidates.

## Keeping this current

Any PR that adds, changes or removes a departure from upstream must update `fork-delta.md` in the
same PR.
