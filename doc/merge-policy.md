# Merge policy

`main` is protected by the `main-protection` ruleset. A pull request can only merge once these
status checks pass:

- `Run linter`
- `TypeScript type checking`
- `Build API`
- `Build Web`
- `Devin Review` (added once the first automated review has run)

Force pushes to `main` and branch deletion are blocked; the repository admin can bypass the ruleset.

Devin Review runs automatically on every pull request and posts its result as a status check.
With GitHub auto-merge enabled on a pull request, the merge happens on its own as soon as every
required check is green, and the branch is deleted afterwards.
