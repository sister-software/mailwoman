# ops-cli

`mwops`, the operator CLI for CI and humans, dispatches the release, shop, repository health, storage, host, pull
request, worktree and probe registries.

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

The AWS identities for the remote tile build follow the same two steps. `mwops release aws-credentials` verifies the
tile-build access key in the environment against AWS STS. `mwops release mint-aws-credentials -o <file>` runs under the
shell's AWS session, or under `--profile`, and that session needs IAM write access. It creates the
`mailwoman-tile-build` user with one access key and the `mailwoman-tile-build-instance` role with its instance profile,
and writes `AWS_TILE_BUILD_ACCESS_KEY_ID` and `AWS_TILE_BUILD_SECRET_ACCESS_KEY` to that new file, mode 0600.
`--dry-run` prints each policy document before any IAM request. `lib/release-kit/deploy/aws/credentials.ts` holds the
policies.

`mwops check <name> [paths…]` runs one registered repository check (`lib/check-kit/registry.ts`) in this checkout
without a shell and exits with the check's status. The output goes to a log under the cache root, or under
`--log-dir`. The command prints one summary line, the failing tests or checks, and the log path. Use `--json` to print
the result object. Each check's `hostLoad` in the registry decides what it waits for. A `light` check starts at once.
A `heavy` check, such as `compile`, `lint` or `health`, takes the lock under the shared cache root and starts beside
CI runs. An `exclusive` check, a test suite, waits for queued or in-progress CI runs before taking the lock. Both waits
use one `--max-wait-minutes` bound (default 20). The check holds no lock while it waits for CI, so a check waiting on
CI blocks no other check. `--no-wait` refuses at once
when the lock is held. A lock whose holder process is gone, or whose pid now belongs to a process with another start time,
is released with a message. `mwops check preflight` runs the direct-push set from `AGENTS.md`, followed by
`health-tree`. `mwops host status` reports the lock holder and the CI runs, and `mwops host wait-idle --max-minutes N`
exits 0 when the host is idle, 3 when the bound expired with it busy, and 4 when CI stayed unread.

`yarn health` runs nine scripts. `node-modules-reacharound`, `prefix-directories` and the other checks that a test
runs over the current tree run only through the tests under `lib/repo-health`. `mwops check health-tree` runs those
tests with Vitest and reads its JSON report.

Run `mwops worktree status --path <dir>` from a checkout with its own install. The command reads the working tree that
contains `<dir>`. It reports three prerequisites, each as satisfied, missing, or unread with the reason: `node_modules` as a
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
The check runner runs each step and writes its log under the cache root. A failing step stops the sequence.
A compile that fails with a missing-export error against a `@mailwoman/*` or `#` module runs once more. The step
result records the first run and its log. TypeScript 7's `tsc -b` has failed that way on a tree whose `out/`
predated a change to `@mailwoman/core`'s exports, then passed with no source change.
The command then reads the status again and exits 0 only when that status is ready. `--dry-run` lists the steps it
would run.

`mwops pr status <number>` reads one pull request's head commit, base branch, mergeable and merge-state values, and
each check with its bucket. `mwops pr wait <number> --max-minutes N` reads the checks every `--poll-seconds` (default 45) until one fails, zero are pending, or the bound (default 40) expires. It returns at the first read that shows a failed check, while the others still run. Both exit 0 when every check passed, 1 when one failed or
was cancelled, 3 when a check is pending and zero have failed, 4 when `gh` returned no checks JSON, and 5 when the head has zero
checks, because of a merge conflict or because none started. On exit 1 each failed job's log is written under the cache
root's `checks/ci-logs` directory, and the command prints the failing tests the Vitest parser reads from it, or states
that the log held none. A failed check that isn't a GitHub Actions job, such as CodeQL, has no job log. Its link ends in
`/runs/<id>`, and the command reads that check run's annotations through
`gh api repos/sister-software/mailwoman/check-runs/<id>/annotations` and prints each one's level, path, start line,
title and message under the check. The command reports a failed call separately from a successful call that returned
zero annotations. The check stays failed in either case.

`mwops probe <workspace> --get <path> [--get <path> …]` starts one workspace's server from this checkout without a
shell, bound to 127.0.0.1 with `--port 0`, and waits for the line that states `listening on http://<host>:<port>`. It
sends each GET to that port on loopback, in order, then stops the server by the process id it started: SIGTERM, and
SIGKILL after 15 seconds. It then checks by process id that neither the server nor a descendant remains. The targets
are read from the checkout: each workspace whose `cli/main.ts` hands a `serve` command to `runDropInCLI` runs from
source, and `api` runs the compiled `mailwoman serve --cpus 1`, whose command imports `@mailwoman/api`. Each request
reports its status, content type, duration and body up to `--max-bytes` with a `truncated` marker, or the value at
`--json-path` in a JSON body. The result marks a missing JSON path as absent. A request without a response reports the
socket's cause code, such as `ECONNREFUSED`.

`--env NAME=value` adds a value to the inherited environment, and `--env-file <file>` passes Node's `--env-file` to the
server. The result records the environment names and never their values. Flags after `--` reach the server, except
`--host` and `--port`. The server's output goes to a log under the cache root's `checks` directory, or under
`--log-dir`. The result states the time from process start to the listening line, the startup output, the peak
resident memory of the server's process tree from `/proc/<pid>/status`, and how the server stopped.

The command's exit statuses:

- 0 when the server listened, every request received an HTTP response and the server stopped.
- 1 when a request received zero response.
- 3 when the server exited before listening. The command prints the server's exit status and last output lines.
- 4 when the startup wait, `--startup-timeout-seconds` (default 60), expired.
- 6 when a server process remained after the stop.
- 130 on an interrupt, after the server is stopped.

An HTTP 4xx or 5xx is a response. A probe takes no host lock: on the lab data root each server's process tree peaked
between 419 and 742 MiB of resident memory, below what the lock exists for.

`health baseline debt` is the one mutation the health verb performs: it rewrites `lib/repo-health/baseline.json`
from the current readings, after a reviewed reduction. Every other `health` invocation only reads.

Workflows call these commands and never a `lib/*.ts` path. Agents reach the same operations through the release MCP
server. That server is enabled separately from the development MCP server because publishing uses credentials and has irreversible
effects that a diagnostic server mustn't imply.

Record: `docs/superpowers/specs/2026-09-04-scripts-directory-migration-proposal.md`.
