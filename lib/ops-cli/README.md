# ops-cli

`mwops`, the operator CLI for CI and humans, dispatches the release, shop, repository health, storage, host and pull
request registries.

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
is released with a message. `mwops check preflight` runs the direct-push set from `AGENTS.md`, followed by
`health-tree`. `mwops host status` reports the lock holder and the CI runs, and `mwops host wait-idle --max-minutes N`
exits 0 when the host is idle, 3 when the bound expired with it busy, and 4 when CI stayed unread.

`yarn health` runs nine scripts. `node-modules-reacharound`, `prefix-directories` and the other checks that a test
runs over the current tree run only through the tests under `lib/repo-health`. `mwops check health-tree` runs those
tests with Vitest and reads its JSON report.

`mwops worktree status --path <dir>` reads the working tree that contains `<dir>` from this checkout, which has its own
install. It reports three prerequisites, each as satisfied, missing, or unread with the reason: `node_modules` as a
directory of the tree's own, `out/` no older than the sources, and every weights workspace `copy-weights` writes
holding the untracked files its `files` array declares. When the tree has its own install, `out/` counts as current
only when the tree's `tsc -b --dry` also reports every build project up to date. Test projects are `noEmit`. The dry
run reports each of them as out of date after every build, so the reading counts them apart.

Beside the prerequisites, the status reports the branch, the commits behind and ahead of the local `origin/main` ref
with the time its reflog records a fetch last moving it, and whether `<tree>/.env` exists. When it doesn't, the status
gives the path of the file `@mailwoman/core/env` reads for the tree, and the `--env-file` flag that points at this
checkout's file. It reads the contents of neither file. It exits 0 when the tree is ready and 1 when it isn't.

`mwops worktree prepare --path <dir>` runs `yarn install --json`, `yarn compile` and
`yarn mwops release copy-weights` in that tree, each only when its prerequisite isn't satisfied, under one host lock.
Each step runs through the check runner, which writes its log under the cache root. A failing step stops the sequence.
A compile that fails with a missing-export error against a `@mailwoman/*` or `#` module runs once more. The step
result records the first run and its log. TypeScript 7's `tsc -b` has failed that way on a tree whose `out/`
predated a change to `@mailwoman/core`'s exports, then passed with no source change.
The command then reads the status again and exits 0 only when that status is ready. `--dry-run` lists the steps it
would run.

`mwops pr status <number>` reads one pull request's head commit, base branch, mergeable and merge-state values, and
each check with its bucket. `mwops pr wait <number> --max-minutes N` reads the checks every `--poll-seconds` (default 45) until zero are pending or the bound (default 40) expires. Both exit 0 when every check passed, 1 when one failed or
was cancelled, 3 when a check is pending at the end, 4 when `gh` returned no checks JSON, and 5 when the head has zero
checks, because of a merge conflict or because none started. On exit 1 each failed job's log is written under the cache
root's `checks/ci-logs` directory, and the command prints the failing tests the Vitest parser reads from it, or states
that the log held none.

`health baseline debt` is the one mutation the health verb performs: it rewrites `lib/repo-health/baseline.json`
from the current readings, after a reviewed reduction. Every other `health` invocation only reads.

Workflows call these commands and never a `lib/*.ts` path. Agents reach the same operations through the release MCP
server. That server is enabled separately from the development MCP server because publishing uses credentials and has irreversible
effects that a diagnostic server mustn't imply.

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
