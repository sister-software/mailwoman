# ops-cli

`mwops`, the operator CLI for CI and humans, dispatches the release, shop, repository health, and storage registries.

```
mwops release preflight
mwops release plan --json > release-plan.json
mwops release publish --plan release-plan.json
mwops health all
mwops health debt
mwops health baseline debt
```

Each operation declares its flags as a `parseArgs` options config beside its input schema. A flag the operation doesn't
declare exits 2. A boolean flag is turned off with its `--no-` form.

The Cloudflare tokens start from `mwops release cloudflare-tokens`, which verifies each role's token and prints a
dashboard link that pre-fills its permissions. Create the minter from its link and set `CLOUDFLARE_TOKEN_MINTER`, or set
`CLOUDFLARE_EMAIL` and `CLOUDFLARE_API_KEY` to the Global API Key. Then `mwops release mint-cloudflare-tokens -o <file>`
creates the deploy and cache-purge tokens as account-owned tokens and writes them to that new file, mode 0600.

`mwops check <name> [paths…]` runs one registered repository check (`lib/check-kit/registry.ts`) in this checkout
without a shell and exits with the check's status. The output goes to a log under the cache root, or under
`--log-dir`. The command prints one summary line, the failing tests or checks, and the log path, and `--json` prints
the result object. A heavy check takes the host lock under the cache root, which every checkout on the host shares,
and waits for queued or in-progress CI runs, within `--max-wait-minutes` (default 20). `--no-wait` refuses at once
when the lock is held. A lock whose holder process is gone, or whose pid now belongs to a process with another start time,
is released with a message. `mwops check preflight` runs the direct-push set from `AGENTS.md`. `mwops host status`
reports the lock holder and the CI runs, and `mwops host wait-idle --max-minutes N` exits 0 when the host is idle, 3
when the bound expired with it busy, and 4 when CI stayed unread.

`health baseline debt` is the one mutation the health verb performs: it rewrites `lib/repo-health/baseline.json`
from the current readings, after a reviewed reduction. Every other `health` invocation only reads.

Workflows call these commands and never a `lib/*.ts` path. Agents reach the same operations through the release MCP
server. That server is enabled separately from the development MCP server because publishing uses credentials and has irreversible
effects that a diagnostic server mustn't imply.

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
