# Merge policy

`main` is protected by the `main-protection` ruleset. A pull request can only merge once these
status checks pass:

- `Run linter`
- `TypeScript type checking`
- `Build API`
- `Build Web`
- `Web image builds and serves the SPA`
- `API image boots, migrates and serves requests`
- `Devin Review`
- `Devin Review findings`

Force pushes to `main` and branch deletion are blocked; the repository admin can bypass the ruleset.

Devin Review runs automatically on every pull request and posts its result as the `Devin Review`
status check. That check only reports that the review ran, so the `Review gate` workflow adds the
`Devin Review findings` status, which fails while any Devin Review comment thread on the pull
request is still unresolved and not outdated. Because GitHub emits no event when a thread is
resolved, that workflow also re-evaluates open pull requests on a ten-minute schedule.

The `Auto-merge` workflow turns on GitHub auto-merge for pull requests opened by the
repository owner or by Devin, so a pull request squash-merges itself as soon as every required
check is green, and its branch is deleted afterwards.
