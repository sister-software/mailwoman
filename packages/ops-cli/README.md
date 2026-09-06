# @mailwoman/ops-cli

Private. `mwops`, the operator CLI for CI and humans: a view over the `@mailwoman/release-kit` and
`@mailwoman/repo-health` registries with no logic of its own.

```
mwops release preflight
mwops release plan --json > release-plan.json
mwops release publish --plan release-plan.json
mwops health all
mwops health debt
mwops health baseline debt
```

`health baseline debt` is the one mutation the health verb performs: it rewrites `packages/repo-health/baseline.json`
from the current readings, after a reviewed reduction. Every other `health` invocation only reads.

Workflows call these commands and never a `lib/*.ts` path. Agents reach the same operations through the release MCP
server, which is enabled separately from `@mailwoman/dev-mcp` because publishing carries credentials and irreversible
effects that a diagnostic server must not imply.

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
