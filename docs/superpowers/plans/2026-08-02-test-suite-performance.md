# Test suite performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `test.yml` green wall-clock from 6m29s to ~2m00–2m15s, and make the evidence-lexicons gate invariant to gazetteer size.

**Architecture:** Five independent changes, ordered most-certain-prize first. Two are CI configuration (an Actions cache prune; caching the compiled `out/` tree). One moves derived weights artifacts from GitHub's cache service to the local data root the self-hosted runner already has. One splits the single test file that is 93% of the slow leg's runtime into four layers — a fast fixture on every PR, and the full-scale build path-gated, nightly, and at release. One hoists repeated model loads in `neural/test/weights.test.ts`.

**Tech Stack:** GitHub Actions, `gh` CLI, vitest 4.1.10, `node:sqlite` (`DatabaseSync`), TypeScript run directly under Node 24 (type stripping, no flags), yarn 4.17.0.

**Source spec:** `docs/superpowers/specs/2026-08-02-test-suite-performance-design.md`

## Global Constraints

- **Node runs source directly** (type stripping, no flags). Relative imports carry explicit `.ts` extensions.
- **`erasableSyntaxOnly: true`** repo-wide — no `enum` (use `const X = {…} as const` + `type X = (typeof X)[keyof typeof X]`), no constructor parameter properties, no runtime namespaces.
- **ZERO raw `process.env` / `process.argv`** — CI-enforced by oxlint (`sister-software/no-process-globals`). The only blessed accessors are `@mailwoman/core/env` (`$public`) and `@mailwoman/core/utils/scripting`.
- **Data-root paths go through `@mailwoman/core/utils`** — `dataRootPath(...)` / `mailwomanDataRoot()`. The `/mnt/playpen/mailwoman-data` default lives in exactly one place (`core/utils/data-root.ts`). Never re-hardcode it; in docs and help text reference `$MAILWOMAN_DATA_ROOT`.
- **Acronym casing:** acronyms capitalize as whole camelCase components — `parseJSON`, `readID`, `modelURL`. Not `parseJson` / `readId`. Does not apply to `snake_case` DB columns or wire keys.
- **Two pre-commit gates fire on every commit** and both reject silently-looking failures:
  1. `oxfmt --check` on staged files — it reformats **markdown tables** too. Run `yarn oxfmt <paths>` before committing docs.
  2. An MDX safety check — a raw `<` before an alphanumeric in markdown prose (e.g. `<1s`) is rejected because MDX parses it as a JSX tag. Backtick it.
- **`yarn compile` before test runs** that touch compiled output. The CLI integration tests exec `mailwoman/out/cli.js`.
- **Commit trailers** — every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
  ```
- **Work happens in the worktree** at `.claude/worktrees/perf+test-suite`, branch `worktree-perf+test-suite`, based on `origin/main` @ `9b46c82e`. Do not `cd` to the main checkout.
- **Never use bare `git stash` / `git stash pop`** — the stash stack is shared with other worktrees and other agents.
- **Out of scope:** step (e1) (`node_modules` caching) and the pnpm migration. Both deferred — see `docs/superpowers/specs/2026-08-02-pnpm-migration-design.md`.

## File Structure

| file                                                             | disposition | responsibility                                                                                        |
| ---------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `.github/workflows/cache-prune.yml`                              | create      | Scheduled Actions-cache prune. Sole owner of the retention policy.                                    |
| `scripts/derived-weights-key.ts`                                 | create      | Compute the content key for the derived-weights store. Pure; no I/O beyond reading the hashed inputs. |
| `scripts/derived-weights-key.test.ts`                            | create      | Unit tests for the key function.                                                                      |
| `scripts/copy-weights.ts`                                        | modify      | Read/write the derived store before spawning the CLI builders.                                        |
| `mailwoman/gazetteer-pipeline/fst.ts`                            | modify      | Memoize `computeSurfaceCountryCounts` by `dbPath` + mtime.                                            |
| `mailwoman/gazetteer-pipeline/evidence-lexicons.ts`              | modify      | Memoize `loadPersonNameSurfaces`.                                                                     |
| `mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts`         | modify      | Drop the two full-DB tests; keep the pure-unit surface.                                               |
| `mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts` | create      | The fixture admin DB + the four laws end to end. Runs on every PR.                                    |
| `mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts`    | create      | The full-scale build. Path-gated / nightly / release only.                                            |
| `.github/workflows/test.yml`                                     | modify      | `lexicon-full` job, the PARTIAL GATE annotation, the `out/` cache.                                    |
| `.github/workflows/lexicon-nightly.yml`                          | create      | Nightly full-scale build against the live data root.                                                  |
| `neural/test/weights.test.ts`                                    | modify      | Hoist the link scripts and the shared classifier.                                                     |
| `vitest.config.ts`                                               | modify      | Exclude `.venv` and `scratchpad`.                                                                     |
| `package.json`                                                   | modify      | `ci:test:fast` / `ci:test:slow` globs for the new test files.                                         |

---

### Task 1: Prune the Actions cache

The repo is at 10.7 GB against a 10 GB limit with 78 entries, so GitHub evicts LRU and the hosted yarn cache is a coin-flip (Fetch measured at 0.6s / 56.4s / 61.0s on three runs of the same branch, same day). CodeQL overlay-base databases are 4324 MB of it across 54 entries.

**Files:**

- Create: `.github/workflows/cache-prune.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing other tasks import. Task 7 depends on the freed quota existing.

- [ ] **Step 1: Read the current cache state and record it**

```bash
gh api repos/sister-software/mailwoman/actions/cache/usage
gh api --paginate repos/sister-software/mailwoman/actions/caches \
  --jq '.actions_caches[] | "\(.size_in_bytes)\t\(.key | split("-")[0:3] | join("-"))"' \
  | awk -F'\t' '{s[$2]+=$1; n[$2]++} END {for (k in s) printf "%8.0f MB  %3d entries  %s\n", s[k]/1048576, n[k], k}' \
  | sort -rn
```

Write the output into the PR description. This is the before-number the acceptance criterion is measured against.

- [ ] **Step 2: Create the workflow**

```yaml
# Prune the repo's GitHub Actions cache.
#
# WHY THIS EXISTS: measured 2026-08-02, the repo sat at 10.7 GB against a 10 GB limit with 78
# entries. Over quota, GitHub evicts LRU — and what it evicted was the hosted legs' yarn cache, so
# `Install dependencies` flipped between 24s (warm) and 83s (cold) run to run, on three legs, with
# `yarn cache is not found` in the Setup Node log. Nothing about the yarn config was wrong; there
# was no room. CodeQL's default-setup overlay-base databases were 4324 MB across 54 entries — 40%
# of the entire budget for a workflow that is not even in this directory.
#
# POLICY (first match wins):
#   - codeql-overlay-base-database-*  keep the NEWEST per language on the default branch, delete the rest.
#     These are CodeQL's incremental-analysis cache; deleting them all costs CodeQL time on every run,
#     so this keeps one working set rather than zero.
#   - everything else                 left alone. This workflow is not a general garbage collector;
#     an unrecognized key prefix is somebody's working cache and is none of its business.
#
# SAFETY: entries accessed within the last hour are skipped unconditionally, so a prune that lands
# mid-run cannot delete a cache a live job is about to read.
#
# DRY RUN: workflow_dispatch exposes `apply` (default false). The scheduled run applies; a manual
# run reports what it would delete unless you tick the box.
name: Cache prune

on:
  schedule:
    # 04:17 UTC daily — off the hour to avoid GitHub's scheduling stampede.
    - cron: "17 4 * * *"
  workflow_dispatch:
    inputs:
      apply:
        description: "Actually delete (unticked = report only)"
        type: boolean
        default: false

permissions:
  contents: read
  actions: write

jobs:
  prune:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Prune
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
          APPLY: ${{ github.event_name == 'schedule' || inputs.apply }}
        run: |
          set -euo pipefail

          before=$(gh api "repos/${REPO}/actions/cache/usage" --jq '.active_caches_size_in_bytes')
          echo "before: $((before / 1048576)) MB" >> "$GITHUB_STEP_SUMMARY"

          cutoff=$(date -u -d '1 hour ago' +%s)

          # Every codeql overlay-base entry on the default branch, newest first, with its language.
          # The key shape is codeql-overlay-base-database-<n>-<hash>-<language>-<version>-<sha>, so the
          # language is field 6 when split on "-".
          gh api --paginate "repos/${REPO}/actions/caches" \
            --jq '.actions_caches[]
                  | select(.key | startswith("codeql-overlay-base-database-"))
                  | [.id, .key, .ref, .last_accessed_at, (.key | split("-")[5])]
                  | @tsv' > /tmp/codeql.tsv || true

          seen_langs=""
          deleted=0
          freed=0

          # Sort by last_accessed_at DESC so the first entry per language is the newest.
          sort -t$'\t' -k4,4r /tmp/codeql.tsv | while IFS=$'\t' read -r id key ref accessed lang; do
            [ -n "${id:-}" ] || continue

            accessed_epoch=$(date -u -d "$accessed" +%s 2>/dev/null || echo 0)
            if [ "$accessed_epoch" -gt "$cutoff" ]; then
              echo "SKIP (hot)   $key"
              continue
            fi

            case " $seen_langs " in
              *" $lang "*)
                echo "DELETE       $key"
                if [ "$APPLY" = "true" ]; then
                  gh api -X DELETE "repos/${REPO}/actions/caches/${id}" >/dev/null || true
                fi
                deleted=$((deleted + 1))
                ;;
              *)
                echo "KEEP (newest $lang)  $key"
                seen_langs="$seen_langs $lang"
                ;;
            esac
          done

          after=$(gh api "repos/${REPO}/actions/cache/usage" --jq '.active_caches_size_in_bytes')
          {
            echo "after: $((after / 1048576)) MB"
            echo ""
            echo "apply: ${APPLY}"
          } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 3: Validate the workflow parses before pushing**

Run:

```bash
node -e 'const{readFileSync}=require("node:fs");readFileSync(".github/workflows/cache-prune.yml","utf8");console.log("read ok")'
gh workflow list 2>/dev/null | head -20
```

Then push the branch and run the workflow in report-only mode:

```bash
gh workflow run cache-prune.yml -f apply=false
sleep 30 && gh run list --workflow=cache-prune.yml --limit 1
```

Expected: the run is green and the log lists `KEEP (newest <lang>)` lines and `DELETE` lines, with **no** deletions actually performed.

⚠ Read the `DELETE` list before proceeding. If it names anything that is not a `codeql-overlay-base-database-*` key, stop — the filter is wrong.

- [ ] **Step 4: Apply it once by hand**

```bash
gh workflow run cache-prune.yml -f apply=true
```

Run: `gh api repos/sister-software/mailwoman/actions/cache/usage`
Expected: `active_caches_size_in_bytes` drops below 8 GB (from 10,715,161,750).

- [ ] **Step 5: Confirm the yarn cache now survives**

Push an empty commit to the branch and check the install step across two consecutive runs:

```bash
git commit --allow-empty -m "chore: probe install timing after cache prune"
git push
# wait for the run, then:
gh api repos/sister-software/mailwoman/actions/runs/<id>/jobs \
  --jq '.jobs[] | select(.name=="unit-fast") | .steps[] | select(.name=="Install dependencies") | {name, dur: ((.completed_at|fromdateiso8601)-(.started_at|fromdateiso8601))}'
```

Expected: ≤ 30s on both runs (was 83s cold / 24s warm). Record both numbers.

- [ ] **Step 6: Commit**

```bash
yarn oxfmt .github/workflows/cache-prune.yml
git add .github/workflows/cache-prune.yml
git commit -m "$(cat <<'EOF'
ci(cache): prune the Actions cache so the yarn entry stops being evicted

The repo sat at 10.7 GB against a 10 GB limit, 78 entries. Over quota
GitHub evicts LRU, and what it evicted was the hosted legs' yarn cache:
Fetch measured 0.6s / 56.4s / 61.0s across three runs of the same branch
on the same day, with "yarn cache is not found" in the Setup Node log.
Nothing about the yarn config was wrong — there was no room.

CodeQL default-setup overlay-base databases were 4324 MB of it across 54
entries. This keeps the newest per language and drops the rest; entries
touched in the last hour are never eligible, so a prune landing mid-run
cannot take a cache a live job is about to read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 2: Materialize weights from the data root, not GitHub's cache

The `weights-*` cache payload is 76.3 MB of real files and takes 48–54s to restore on the two `mailwoman-data` legs — about 1.6 MB/s over the lab's degraded path to the cache service. The source model is already on local disk on that same host (`release.config.json` → `dataRoot: /mnt/playpen/mailwoman-data`). Only the derived `postcode-*.bin` / `pair-index-*.bin` are expensive to produce; those get a content-keyed store in the data root.

**Files:**

- Create: `scripts/derived-weights-key.ts`
- Create: `scripts/derived-weights-key.test.ts`
- Modify: `scripts/copy-weights.ts`
- Modify: `.github/workflows/test.yml` (remove the two `actions/cache` weights blocks)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `derivedWeightsKey(): string` — a 16-hex-char content key over every input the derived binaries are generated from, **including the CLI modules that generate them**.
  - `derivedWeightsDir(key: string): string` — absolute path to `$MAILWOMAN_DATA_ROOT/derived/weights/<key>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/derived-weights-key.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The derived-weights store's key. The 2026-08-02 currency-filter incident is the reason this has
 *   its own test: the workflow's cache key hashed `release.config.json` + `data/gazetteer/*` only,
 *   so a change to the EXTRACTOR produced new artifacts while the cache served the old ones and the
 *   pair-index↔card parity guard failed with `expected 47878 to be 49033`. A key that omits the code
 *   generating the cached thing is a stale-artifact machine.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { derivedWeightsDir, derivedWeightsKeyFrom } from "./derived-weights-key.ts"

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "derived-weights-key-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

describe("derivedWeightsKeyFrom", () => {
	it("is stable for identical inputs", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, '{"x":1}')

		expect(derivedWeightsKeyFrom([a])).toBe(derivedWeightsKeyFrom([a]))
	})

	it("changes when a hashed input's CONTENT changes", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, '{"x":1}')
		const before = derivedWeightsKeyFrom([a])

		await writeFile(a, '{"x":2}')

		expect(derivedWeightsKeyFrom([a])).not.toBe(before)
	})

	it("changes when a GENERATING MODULE changes — the currency-filter regression", async () => {
		const config = join(scratch, "release.config.json")
		const generator = join(scratch, "pair-index.tsx")
		await writeFile(config, '{"weights":{"model":"m.onnx"}}')
		await writeFile(generator, "export const delta = 1")
		const before = derivedWeightsKeyFrom([config, generator])

		// The config is untouched; only the code that produces the binaries changed.
		await writeFile(generator, "export const delta = 2")

		expect(derivedWeightsKeyFrom([config, generator])).not.toBe(before)
	})

	it("is order-independent across the input list", async () => {
		const a = join(scratch, "a.json")
		const b = join(scratch, "b.json")
		await writeFile(a, "1")
		await writeFile(b, "2")

		expect(derivedWeightsKeyFrom([a, b])).toBe(derivedWeightsKeyFrom([b, a]))
	})

	it("treats a MISSING input as a distinct state, not as empty", async () => {
		const a = join(scratch, "a.json")
		await writeFile(a, "1")
		const present = derivedWeightsKeyFrom([a])

		await rm(a)

		// A file that is absent must not hash the same as a file that is empty — absence is not zero.
		expect(derivedWeightsKeyFrom([a])).not.toBe(present)
	})

	it("returns a 16-hex-char key", () => {
		expect(derivedWeightsKeyFrom([])).toMatch(/^[0-9a-f]{16}$/)
	})
})

describe("derivedWeightsDir", () => {
	it("lands under the data root's derived/weights namespace", () => {
		expect(derivedWeightsDir("deadbeefdeadbeef")).toMatch(/\/derived\/weights\/deadbeefdeadbeef$/)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run scripts/derived-weights-key.test.ts`
Expected: FAIL — `Failed to resolve import "./derived-weights-key.ts"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/derived-weights-key.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The content key for the derived-weights store at `$MAILWOMAN_DATA_ROOT/derived/weights/<key>`.
 *
 *   WHY A LOCAL STORE: the `weights-*` actions/cache entry carried 76.3 MB and took 48–54s to
 *   restore on the `mailwoman-data` legs (~1.6 MB/s over the lab's degraded path to GitHub's cache
 *   service) — to a host that already has the source model on local disk. Only `postcode-<cc>.bin`
 *   and `pair-index-<cc>.bin` are expensive to produce, so those are what the store holds.
 *
 *   WHY THE GENERATORS ARE HASHED: on 2026-08-02 the workflow key hashed `release.config.json` and
 *   `data/gazetteer/*` but not the extractor, so a currency-filter change produced new artifacts
 *   while the cache served old ones and the pair-index↔card parity guard failed with
 *   `expected 47878 to be 49033`. The generating code is part of the input.
 */

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * Every input the derived binaries are a function of, repo-relative.
 *
 * The first group mirrors the retired workflow cache key. The second is what that key MISSED: the
 * modules that generate the binaries. Add to this list whenever a new input starts feeding the
 * build — a key that omits an input serves stale artifacts silently.
 */
export const DERIVED_WEIGHTS_INPUTS: readonly string[] = [
	"release.config.json",
	"data/gazetteer/borough-pairs.json",
	"data/gazetteer/london-pairs-v2.jsonl",
	"mailwoman/gazetteer-pipeline/borough-pairs.ts",
	"mailwoman/gazetteer-pipeline/lieudit-pairs.ts",
	"mailwoman/commands/gazetteer/pair-index.tsx",
	"mailwoman/commands/gazetteer/postcode-binary.tsx",
]

/**
 * Hash an explicit list of absolute paths. Exported for testing; production callers want
 * {@link derivedWeightsKey}.
 *
 * A missing path contributes a distinct `\0absent` marker rather than nothing, so "the file is gone"
 * and "the file is empty" produce different keys.
 */
export function derivedWeightsKeyFrom(paths: readonly string[]): string {
	const hash = createHash("sha256")

	for (const path of [...paths].sort()) {
		hash.update(path)

		try {
			statSync(path)
			hash.update(readFileSync(path))
		} catch {
			hash.update("\0absent")
		}
	}

	return hash.digest("hex").slice(0, 16)
}

/**
 * The key for this checkout's derived weights.
 */
export function derivedWeightsKey(): string {
	return derivedWeightsKeyFrom(DERIVED_WEIGHTS_INPUTS.map((p) => resolve(repoRootPath(), p)))
}

/**
 * Where the derived binaries for `key` live. Persistent across CI runs — the `mailwoman-data`
 * runners are self-hosted, so this filesystem survives.
 */
export function derivedWeightsDir(key: string): string {
	return String(dataRootPath("derived", "weights", key))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run scripts/derived-weights-key.test.ts`
Expected: PASS, 7 tests.

⚠ If `DERIVED_WEIGHTS_INPUTS` names a path that does not exist in this checkout, that is fine at runtime (it hashes as absent) but wrong as a spec. Verify each one:

```bash
for f in release.config.json data/gazetteer/borough-pairs.json data/gazetteer/london-pairs-v2.jsonl \
         mailwoman/gazetteer-pipeline/borough-pairs.ts mailwoman/gazetteer-pipeline/lieudit-pairs.ts \
         mailwoman/commands/gazetteer/pair-index.tsx mailwoman/commands/gazetteer/postcode-binary.tsx; do
  [ -f "$f" ] && echo "ok   $f" || echo "MISSING $f"
done
```

Fix any `MISSING` line by correcting the path to the real one before continuing.

- [ ] **Step 5: Teach `copy-weights.ts` to use the store**

In `scripts/copy-weights.ts`, add the import alongside the existing ones:

```ts
import { derivedWeightsDir, derivedWeightsKey } from "./derived-weights-key.ts"
```

Add this helper above `materializeSoftFeed`:

```ts
/**
 * Serve `filename` for `workspace` out of the derived store if this checkout's key already has it.
 *
 * Returns true when the file was placed (the caller skips the expensive CLI spawn). A miss returns
 * false and the caller builds; {@link stashDerived} then deposits the result for next time.
 */
function tryServeDerived(dir: string, filename: string): boolean {
	const cached = resolve(derivedWeightsDir(derivedWeightsKey()), filename)

	if (!existsSync(cached)) return false

	const dest = resolve(dir, filename)

	// Same unlink-then-copy discipline as the rest of this script: fs.copyFile FOLLOWS a symlink at
	// the destination and writes THROUGH it, leaving the symlink in place — and yarn refuses to
	// publish a tarball containing one (HTTP 415, YN0035).
	try {
		unlinkSync(dest)
	} catch {
		// Not present; nothing to remove.
	}

	copyFileSync(cached, dest)
	process.stderr.write(`derived store HIT → ${filename}\n`)

	return true
}

/**
 * Deposit a freshly-built `filename` into the derived store under this checkout's key.
 *
 * Best-effort: a store write that fails must never fail a release. The build already succeeded and
 * the workspace already has the artifact; the store is an optimization, not a source of truth.
 */
function stashDerived(dir: string, filename: string): void {
	try {
		const storeDir = derivedWeightsDir(derivedWeightsKey())
		mkdirSync(storeDir, { recursive: true })
		copyFileSync(resolve(dir, filename), resolve(storeDir, filename))
		process.stderr.write(`derived store WRITE → ${filename}\n`)
	} catch (error) {
		process.stderr.write(`derived store write skipped for ${filename}: ${String(error)}\n`)
	}
}
```

Add `copyFileSync`, `mkdirSync`, and `unlinkSync` to the existing `node:fs` import (the file already imports `existsSync` and `readFileSync` from there).

- [ ] **Step 6: Wire the two build sites**

In the postcode-binary block, replace the spawn with a store check first. The existing code is:

```ts
	const binDest = resolve(dir, `postcode-${country}.bin`)
	await removeIfPresent(binDest)
	const cli = resolve(repoRoot, "mailwoman/out/cli.js")

	const r = spawnSync(
```

Becomes:

```ts
	const binDest = resolve(dir, `postcode-${country}.bin`)

	if (tryServeDerived(dir, `postcode-${country}.bin`)) return

	await removeIfPresent(binDest)
	const cli = resolve(repoRoot, "mailwoman/out/cli.js")

	const r = spawnSync(
```

and immediately after the existing post-build assertion:

```ts
if (!existsSync(binDest)) throw new Error(`gazetteer postcode-binary ran but ${binDest} was not produced`)
stashDerived(dir, `postcode-${country}.bin`)
process.stderr.write(`built soft-feed → ${workspace}/postcode-${country}.bin\n`)
```

Apply the identical shape to the pair-index block, substituting `pair-index-${country}.bin`:

```ts
const binDest = resolve(dir, `pair-index-${country}.bin`)

if (tryServeDerived(dir, `pair-index-${country}.bin`)) return

await removeIfPresent(binDest)
```

and after its assertion:

```ts
if (!existsSync(binDest)) throw new Error(`gazetteer pair-index failed for ${country} (exit ${r.status})`)
stashDerived(dir, `pair-index-${country}.bin`)
process.stderr.write(`built soft-feed → ${workspace}/pair-index-${country}.bin (delta=${entry.delta})\n`)
```

- [ ] **Step 7: Verify the round trip locally**

⚠ This writes real files into `neural-weights-*/`. That is what `copy-weights.ts` does by design, and it is idempotent — but it replaces the `link-dev-weights` symlinks with real copies. Re-run `yarn vitest run neural/test/weights.test.ts` afterwards to restore them.

```bash
yarn compile
# Cold: builds and deposits.
rm -rf "$(node -e 'import("@mailwoman/core/utils").then(m=>console.log(String(m.dataRootPath("derived","weights"))))')"
time node scripts/copy-weights.ts 2>&1 | grep -E "derived store|built soft-feed"
# Warm: serves.
time node scripts/copy-weights.ts 2>&1 | grep -E "derived store|built soft-feed"
```

Expected: the first run prints `derived store WRITE →` lines and takes minutes; the second prints `derived store HIT →` for every `.bin` and completes in seconds.

- [ ] **Step 8: Verify the artifacts are byte-identical**

```bash
node -e '
const {execFileSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const {readFileSync, readdirSync} = require("node:fs");
for (const d of readdirSync(".").filter(x => x.startsWith("neural-weights-")))
  for (const f of readdirSync(d).filter(x => x.endsWith(".bin")))
    console.log(createHash("md5").update(readFileSync(`${d}/${f}`)).digest("hex"), `${d}/${f}`);
'
```

Record the md5s. They must match what the pre-change `copy-weights.ts` produced — run the parity guard to confirm:

Run: `yarn vitest run neural/test/pair-index-card-parity.test.ts`
Expected: PASS. This is the guard that caught the 2026-08-02 stale-artifact incident; it is the backstop here too.

- [ ] **Step 9: Remove the two weights cache blocks from `test.yml`**

In `.github/workflows/test.yml`, delete from both the `unit-slow` and `smoke` jobs:

- the `Restore weights cache (model + soft-feed siblings)` step,
- the `if: steps.weights-cache.outputs.cache-hit != 'true'` conditions on `Materialize weights` and `Symlink base-latn model` (the steps stay; they become unconditional, modulo the smoke leg's existing path-gate condition).

For `unit-slow` the two steps become:

```yaml
# Weights come from the DERIVED STORE at $MAILWOMAN_DATA_ROOT/derived/weights/<key>, not from
# actions/cache. The cache entry carried 76.3 MB and restored at ~1.6 MB/s over the lab's path
# to GitHub's cache service (48–54s) — to a host that already has the source model on local
# disk. `copy-weights.ts` now serves the derived binaries from that store and only pays the
# ~5 min build on a genuine key change. See scripts/derived-weights-key.ts.
- name: Materialize weights (derived store; ~5 min only on a key change)
  run: node scripts/copy-weights.ts

- name: Symlink base-latn model (en-us already materialized)
  run: |
    mkdir -p neural-weights-base-latn
    for f in model.onnx tokenizer.model model-card.json calibration.json calibration-per-locale.json anchor-lexicon-v1.json country-surface-lexicon-v1.json; do
      [ -f "neural-weights-base-latn/$f" ] || ln -sf "../neural-weights-en-us/$f" "neural-weights-base-latn/$f"
    done
```

For `smoke`, keep the existing `if: github.event_name != 'pull_request' || steps.changes.outputs.smoke == 'true'` on both steps and drop only the `cache-hit` half of the condition.

- [ ] **Step 10: Run the full slow leg**

Run: `yarn compile && yarn ci:test:slow`
Expected: PASS. Note the wall-clock — it should be unchanged from the ~240s baseline at this point (Task 4 is what moves it).

- [ ] **Step 11: Commit**

```bash
yarn oxfmt scripts/derived-weights-key.ts scripts/derived-weights-key.test.ts scripts/copy-weights.ts .github/workflows/test.yml
yarn lint:oxlint
git add scripts/derived-weights-key.ts scripts/derived-weights-key.test.ts scripts/copy-weights.ts .github/workflows/test.yml
git commit -m "$(cat <<'EOF'
ci(weights): serve the derived binaries from the data root, not GitHub's cache

The weights-* actions/cache entry carried 76.3 MB of real files and took
48-54s to restore on the two mailwoman-data legs — about 1.6 MB/s over the
lab's degraded path to the cache service. The source model is already on
local disk on that host; only postcode-<cc>.bin and pair-index-<cc>.bin are
expensive to produce.

copy-weights.ts now keeps those under $MAILWOMAN_DATA_ROOT/derived/weights/
<key> and pays the ~5 min build only on a genuine key change. The key hashes
the generating CLI modules as well as the config and data inputs — the 2026-
08-02 currency-filter incident is exactly what happens when it does not
(new artifacts, cache serving old ones, parity guard at "expected 47878 to
be 49033"). That guard stays as the backstop.

Also returns 2870 MB of the repo's Actions cache quota.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 3: Memoize the two full-DB scans

`buildLocalitySurfaceLexicon` calls `computeSurfaceCountryCounts(dbPath)` (a full scan of `spr` + `names`) and `loadPersonNameSurfaces()` on every invocation. The FR and US builds run in one process and share neither. This is worth doing on its own — it halves the full build wherever it runs — and Tasks 4 and 5 build on top of it.

**Files:**

- Modify: `mailwoman/gazetteer-pipeline/fst.ts`
- Modify: `mailwoman/gazetteer-pipeline/evidence-lexicons.ts`
- Create: `mailwoman/gazetteer-pipeline/scan-memo.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `computeSurfaceCountryCounts(dbPath: string): Map<string, number>` keeps its exact signature and return type; only its caching changes. Same for `loadPersonNameSurfaces(): Set<string>`.

- [ ] **Step 1: Write the failing test**

Create `mailwoman/gazetteer-pipeline/scan-memo.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The full-DB scans behind the locality-surface build are memoized by (path, mtime, size). Two
 *   builds in one process — the FR and US passes — used to pay the scan twice.
 *
 *   The invalidation key is deliberately (mtime, size) and not path alone: the WOF admin DB is a
 *   sealed readonly artifact that gets REPLACED by a rebuild, and a path-only memo would serve the
 *   old scan against the new file for the life of the process.
 */

import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { computeSurfaceCountryCounts } from "./fst.ts"

let scratch: string

/**
 * The columns `computeSurfaceCountryCounts` reads: `spr` primaries and the `names` alias table.
 */
function buildFixture(path: string, extraName?: string): void {
	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER
		);
		CREATE TABLE names (id INTEGER, name TEXT);

		INSERT INTO spr VALUES (1, 'Springfield', 'locality', 'US', 1);
		INSERT INTO spr VALUES (2, 'Springfield', 'locality', 'CA', 1);
		INSERT INTO spr VALUES (3, 'Rennes', 'locality', 'FR', 1);
	`)

	if (extraName) {
		const stmt = db.prepare("INSERT INTO names VALUES (?, ?)")
		stmt.run(3, extraName)
	}

	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "scan-memo-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

describe("computeSurfaceCountryCounts memoization", () => {
	it("counts distinct countries per folded surface", () => {
		const path = join(scratch, "a.db")
		buildFixture(path)

		const counts = computeSurfaceCountryCounts(path)

		expect(counts.get("springfield")).toBe(2)
		expect(counts.get("rennes")).toBe(1)
	})

	it("returns the SAME map instance on a repeat call for an unchanged file", () => {
		const path = join(scratch, "a.db")
		buildFixture(path)

		expect(computeSurfaceCountryCounts(path)).toBe(computeSurfaceCountryCounts(path))
	})

	it("re-scans when the file is REPLACED — the sealed-artifact rebuild case", async () => {
		const path = join(scratch, "a.db")
		buildFixture(path)
		const first = computeSurfaceCountryCounts(path)

		// Rebuild the artifact in place with different content, exactly as a gazetteer rebuild does.
		await rm(path)
		buildFixture(path, "Roazhon")
		const second = computeSurfaceCountryCounts(path)

		expect(second).not.toBe(first)
		expect(second.get("roazhon")).toBe(1)
	})

	it("keeps separate entries for separate paths", () => {
		const a = join(scratch, "a.db")
		const b = join(scratch, "b.db")
		buildFixture(a)
		buildFixture(b, "Roazhon")

		expect(computeSurfaceCountryCounts(a)).not.toBe(computeSurfaceCountryCounts(b))
		expect(computeSurfaceCountryCounts(b).get("roazhon")).toBe(1)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run mailwoman/gazetteer-pipeline/scan-memo.test.ts`
Expected: the first and last tests PASS (the function already works); "returns the SAME map instance" FAILS with two distinct Map objects. That failing test is the one this task fixes.

- [ ] **Step 3: Add the memo to `computeSurfaceCountryCounts`**

In `mailwoman/gazetteer-pipeline/fst.ts`, add above the function:

```ts
/**
 * Memo for {@link computeSurfaceCountryCounts}, keyed on (path, mtimeMs, size).
 *
 * The scan streams the whole `spr` + `names` surface — millions of rows — and the locality-surface
 * build calls it once per country set. The FR and US passes in one process paid it twice; measured
 * 2026-08-02, that pair was 236.9s of a 253s CI leg.
 *
 * NOT keyed on path alone. The WOF admin DB is a sealed readonly artifact that a rebuild REPLACES,
 * so a path-only memo serves a stale scan against a new file for the life of the process.
 */
const surfaceCountryCountsMemo = new Map<string, Map<string, number>>()
```

Rename the existing function body to a private worker and wrap it. The existing line 162 signature:

```ts
export function computeSurfaceCountryCounts(dbPath: string): Map<string, number> {
	const db = new DatabaseSync(dbPath, { open: true })
```

becomes:

```ts
export function computeSurfaceCountryCounts(dbPath: string): Map<string, number> {
	const { mtimeMs, size } = statSync(dbPath)
	const memoKey = `${dbPath}\0${mtimeMs}\0${size}`
	const hit = surfaceCountryCountsMemo.get(memoKey)

	if (hit) return hit

	const counts = scanSurfaceCountryCounts(dbPath)
	surfaceCountryCountsMemo.set(memoKey, counts)

	return counts
}

function scanSurfaceCountryCounts(dbPath: string): Map<string, number> {
	const db = new DatabaseSync(dbPath, { open: true })
```

Add `statSync` to the file's `node:fs` import.

⚠ The returned Map is now SHARED between callers. Confirm no caller mutates it:

```bash
grep -rn "computeSurfaceCountryCounts" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v "\.claude/"
```

Every call site must only read (`.get` / `.has` / iteration). If one mutates, return a copy instead of the shared instance and note why in the docstring.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run mailwoman/gazetteer-pipeline/scan-memo.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Memoize `loadPersonNameSurfaces`**

In `mailwoman/gazetteer-pipeline/evidence-lexicons.ts`, find `export function loadPersonNameSurfaces` and wrap it the same way. It reads static curation files rather than the DB, so a plain module-level memo is enough:

```ts
/**
 * Memo for {@link loadPersonNameSurfaces}. The curation inputs are static per process; the FR and US
 * locality-surface passes were each re-reading and re-folding them.
 */
let personNameSurfacesMemo: Set<string> | undefined
```

```ts
export function loadPersonNameSurfaces(): Set<string> {
	personNameSurfacesMemo ??= scanPersonNameSurfaces()

	return personNameSurfacesMemo
}
```

with the original body renamed to `function scanPersonNameSurfaces(): Set<string>`.

Apply the same shared-instance check:

```bash
grep -rn "loadPersonNameSurfaces" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v "\.claude/"
```

- [ ] **Step 6: Measure the full build**

Run: `time yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts`
Expected: PASS, and meaningfully faster than the 236.9s baseline. Record the number — the spec estimates ~130s.

⚠ If it is not faster, the memo is not being hit. Add a temporary `console.error` in the miss branch and re-run to see how many times it scans.

- [ ] **Step 7: Commit**

```bash
yarn oxfmt mailwoman/gazetteer-pipeline/fst.ts mailwoman/gazetteer-pipeline/evidence-lexicons.ts mailwoman/gazetteer-pipeline/scan-memo.test.ts
yarn lint:oxlint
git add mailwoman/gazetteer-pipeline/fst.ts mailwoman/gazetteer-pipeline/evidence-lexicons.ts mailwoman/gazetteer-pipeline/scan-memo.test.ts
git commit -m "$(cat <<'EOF'
perf(gazetteer): memoize the two full-DB scans the lexicon build repeats

computeSurfaceCountryCounts streams the whole spr + names surface and
loadPersonNameSurfaces re-reads the curation files; the FR and US locality-
surface passes in one process each paid both. Measured 2026-08-02 that pair
was 236.9s of a 253s CI leg.

Keyed on (path, mtimeMs, size), NOT path alone: the WOF admin DB is a sealed
readonly artifact that a rebuild replaces, and a path-only memo would serve
the old scan against the new file for the life of the process.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 4: Split evidence-lexicons into a fixture layer and a full-scale layer

The two `describe.skipIf(!existsSync(ADMIN_DB))` tests are 236.9s of the slow leg's 253s and grow with the gazetteer. They move to a separate file that CI runs only when the pipeline changes, nightly, and at release. A new fixture file asserts the same laws against a seeded DB in under a second, on every PR.

**Files:**

- Create: `mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts`
- Create: `mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts`
- Modify: `mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts` (remove the integration `describe`)
- Modify: `package.json` (`ci:test:fast` / `ci:test:slow` globs)

**Interfaces:**

- Consumes: `buildLocalitySurfaceLexicon(opts: BuildLocalitySurfaceLexiconOpts): BuiltLexicon` from Task 3's file, unchanged. `opts.dbPath` and `opts.output` already exist. `BuiltLexicon` carries `{ path, entries, homographs, skippedDegenerate, skippedRegionVocabulary, skippedSubPhrase, skippedProminence, maxNgram }`.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the fixture test**

Create `mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four-law selectivity end to end against a SEEDED admin DB — the every-PR layer.
 *
 *   Same idiom as `resolver-wof-sqlite/candidate-lookup.test.ts`: production DDL, hand-picked rows,
 *   and the REAL `buildLocalitySurfaceLexicon` driven through `opts.dbPath`. Every row here is one
 *   the full-scale test named, so the laws are asserted at full fidelity — and, unlike the full
 *   build, this file is invariant to gazetteer size. The 2026-08-02 measurement that motivated the
 *   split: the two full-DB tests were 236.9s of a 253s CI leg and growing.
 *
 *   What does NOT live here: `entries > 10_000` and the other coverage-scale assertions. Those are
 *   claims about the gazetteer, not about the laws — see `evidence-lexicons.full.test.ts`.
 */

import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { BuiltLexicon } from "./evidence-lexicons.ts"
import { buildLocalitySurfaceLexicon } from "./evidence-lexicons.ts"

let scratch: string

/**
 * A minimal admin WOF carrying the tables `buildLocalitySurfaceLexicon` reads: `spr` (primaries),
 * `names` (aliases), `place_population` (the law-2/3 importance input), and `ancestors` (the v4
 * parent-prominence proxy).
 *
 * Importance is `min(1, log2(1 + pop/1000) / 14)`, so the thresholds this fixture needs are:
 *   - ONE_TOKEN_IMPORTANCE_FLOOR   0.25 → pop ≈ 11.3 k
 *   - PERSON_NAME_IMPORTANCE_FLOOR 0.45 → pop ≈ 622 k
 */
function buildFixtureAdmin(path: string): void {
	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER
		);
		CREATE TABLE names (id INTEGER, name TEXT);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);

		-- FR: law-3 flip rows. Paris/Lyon are metro-tier person-name HOMOGRAPHS that must survive;
		-- Joseph is a given name at ordinary-town prominence that must not.
		INSERT INTO spr VALUES (10, 'Paris',       'locality', 'FR', 1);
		INSERT INTO spr VALUES (11, 'Lyon',        'locality', 'FR', 1);
		INSERT INTO spr VALUES (12, 'Joseph',      'locality', 'FR', 1);
		INSERT INTO spr VALUES (13, 'Rennes',      'locality', 'FR', 1);
		-- Law 1: compositional stopword surface + a letters-free surface.
		INSERT INTO spr VALUES (14, 'De La',       'locality', 'FR', 1);
		INSERT INTO spr VALUES (15, '12',          'locality', 'FR', 1);
		-- Law 2: below the one-token floor. This is the row that makes skippedProminence EXACTLY
		-- countable, which is stronger than the full build's "> 0".
		INSERT INTO spr VALUES (16, 'Smallville',  'locality', 'FR', 1);
		-- Law-3 guard: a neighbourhood named after a person inside a prominent parent. Parent
		-- prominence must NOT launder it; the non-name sibling DOES inherit (the Montmartre case).
		INSERT INTO spr VALUES (17, 'Joseph',      'neighbourhood', 'FR', 1);
		INSERT INTO spr VALUES (18, 'Belleville',  'neighbourhood', 'FR', 1);

		-- US: law-4 region vocabulary + directional closure + sub-phrase hygiene.
		INSERT INTO spr VALUES (30, 'Washington',     'locality', 'US', 1);
		INSERT INTO spr VALUES (31, 'Wyoming',        'locality', 'US', 1);
		INSERT INTO spr VALUES (32, 'Vermont',        'locality', 'US', 1);
		INSERT INTO spr VALUES (33, 'Missouri',       'locality', 'US', 1);
		INSERT INTO spr VALUES (34, 'North Dakota',   'locality', 'US', 1);
		INSERT INTO spr VALUES (35, 'East',           'neighbourhood', 'US', 1);
		INSERT INTO spr VALUES (36, 'Southwest',      'neighbourhood', 'US', 1);
		-- Ordinary localities the census rows NEED to survive.
		INSERT INTO spr VALUES (40, 'Fargo',          'locality', 'US', 1);
		INSERT INTO spr VALUES (41, 'Minot',          'locality', 'US', 1);
		INSERT INTO spr VALUES (42, 'Rutland',        'locality', 'US', 1);
		INSERT INTO spr VALUES (43, 'Plainfield',     'locality', 'US', 1);
		INSERT INTO spr VALUES (44, 'Cheyenne',       'locality', 'US', 1);
		-- Multi-token entry with a directional INSIDE — only WHOLE-surface exclusion applies.
		INSERT INTO spr VALUES (45, 'East Nashville', 'locality', 'US', 1);
		-- Sub-phrase alias hygiene: "East" as an alias of "East Nashville" is refused.
		INSERT INTO spr VALUES (46, 'Mount Washington', 'locality', 'US', 1);

		-- Metro tier (>= 622 k) clears the person-name floor.
		INSERT INTO place_population VALUES (10, 2100000);
		INSERT INTO place_population VALUES (11, 1700000);
		-- Ordinary town: clears law 2 but NOT the person-name tier.
		INSERT INTO place_population VALUES (12, 40000);
		INSERT INTO place_population VALUES (13, 220000);
		INSERT INTO place_population VALUES (14, 500000);
		INSERT INTO place_population VALUES (15, 500000);
		-- Below the one-token floor (11.3 k).
		INSERT INTO place_population VALUES (16, 4000);
		INSERT INTO place_population VALUES (30, 700000);
		INSERT INTO place_population VALUES (31, 700000);
		INSERT INTO place_population VALUES (32, 700000);
		INSERT INTO place_population VALUES (33, 700000);
		INSERT INTO place_population VALUES (34, 700000);
		INSERT INTO place_population VALUES (35, 700000);
		INSERT INTO place_population VALUES (36, 700000);
		INSERT INTO place_population VALUES (40, 130000);
		INSERT INTO place_population VALUES (41, 48000);
		INSERT INTO place_population VALUES (42, 15000);
		INSERT INTO place_population VALUES (43, 50000);
		INSERT INTO place_population VALUES (44, 65000);
		INSERT INTO place_population VALUES (45, 90000);
		INSERT INTO place_population VALUES (46, 90000);

		-- Both FR neighbourhoods hang off Paris, so parent prominence is available to both.
		INSERT INTO ancestors VALUES (17, 10, 'locality');
		INSERT INTO ancestors VALUES (18, 10, 'locality');

		-- Sub-phrase aliases: refused. A genuine nickname: kept.
		INSERT INTO names VALUES (45, 'East');
		INSERT INTO names VALUES (46, 'Washington');
		INSERT INTO names VALUES (13, 'Roazhon');
	`)

	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "evidence-lexicons-fixture-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

/**
 * Build against the fixture and return the emitted surface map plus the build's counters.
 *
 * NAMING TRAP, called out because both halves are called "entries": `built.entries` is a COUNT
 * (`BuiltLexicon.entries: number`) while the lexicon file's `entries` is the surface→bitmask MAP.
 * This returns the map as `surfaces` so the two can never be confused at a call site.
 */
function buildAgainstFixture(
	countries: string[],
	placetypes: string[]
): { built: BuiltLexicon; surfaces: Record<string, number> } {
	const dbPath = join(scratch, "admin.db")
	const output = join(scratch, "lexicon.json")
	buildFixtureAdmin(dbPath)

	const built = buildLocalitySurfaceLexicon({ countries, placetypes, dbPath, output })
	const lexicon = JSON.parse(readFileSync(output, "utf8")) as { entries: Record<string, number> }

	return { built, surfaces: lexicon.entries }
}

describe("locality-surface build — fixture (four laws end to end)", () => {
	it("law 3: metros survive, given-name homographs do not", () => {
		const { surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		// Paris clears the person-name tier on its own metro prominence.
		expect(surfaces.paris).toBeDefined()
		expect(surfaces.lyon).toBeDefined()
		// A given name at ordinary-town prominence is refused — the Rue-Joseph hazard.
		expect(surfaces.joseph).toBeUndefined()
		// A non-name surface at the same prominence passes; only law 2 applies to it.
		expect(surfaces.rennes).toBeDefined()
	})

	it("law-3 guard: parent prominence never launders a person-name neighbourhood", () => {
		const { surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin", "neighbourhood"])

		// Joseph-the-neighbourhood sits inside Paris and STILL does not clear.
		expect(surfaces.joseph).toBeUndefined()
		// Belleville is not a person name, so it DOES inherit Paris's prominence.
		expect(surfaces.belleville).toBeDefined()
	})

	it("law 1: compositional stopwords and letters-free surfaces are refused", () => {
		const { built, surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces["de la"]).toBeUndefined()
		expect(surfaces["12"]).toBeUndefined()
		expect(built.skippedDegenerate).toBeGreaterThanOrEqual(2)
	})

	it("law 2: the one-token prominence floor refuses exactly the below-floor row", () => {
		const { built, surfaces } = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(surfaces.smallville).toBeUndefined()
		// Stronger than the full build's `> 0`: the fixture seeds exactly one below-floor surface,
		// so the count is exact and a change in the floor's behaviour cannot hide in a large number.
		expect(built.skippedProminence).toBe(1)
	})

	it("law 4: region vocabulary and the directional closure are out", () => {
		const { built, surfaces } = buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		for (const surface of ["washington", "wyoming", "vermont", "missouri", "north dakota"]) {
			expect(surfaces[surface], surface).toBeUndefined()
		}

		for (const surface of ["east", "southwest"]) {
			expect(surfaces[surface], surface).toBeUndefined()
		}

		expect(built.skippedRegionVocabulary).toBeGreaterThan(0)
	})

	it("keeps the ordinary localities the census rows need", () => {
		const { surfaces } = buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		for (const surface of ["fargo", "minot", "rutland", "plainfield", "cheyenne"]) {
			expect(surfaces[surface], surface).toBeDefined()
		}

		// A directional INSIDE a multi-token surface survives — exclusion is whole-surface only.
		expect(surfaces["east nashville"]).toBeDefined()
	})

	it("sub-phrase aliases are refused, genuine nicknames are kept", () => {
		const us = buildAgainstFixture(["US"], ["locality", "localadmin", "neighbourhood"])

		// "East" ⊂ "East Nashville" and "Washington" ⊂ "Mount Washington" — the names-table leak.
		expect(us.built.skippedSubPhrase).toBeGreaterThanOrEqual(2)

		const fr = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		// "Roazhon" is a real Breton nickname for Rennes, not a sub-phrase.
		expect(fr.surfaces.roazhon).toBeDefined()
	})

	it("is invariant to gazetteer size — the reason this layer exists", () => {
		const first = buildAgainstFixture(["FR"], ["locality", "localadmin"])
		const second = buildAgainstFixture(["FR"], ["locality", "localadmin"])

		expect(second.built.entries).toBe(first.built.entries)
		expect(second.built.skippedProminence).toBe(first.built.skippedProminence)
	})
})
```

- [ ] **Step 2: Run it and read the failures**

Run: `yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts`

Expected: it runs in under a second. Some assertions will likely fail on the first pass — the seeded populations are computed from the importance formula but the curation sets (`loadDegenerateSurfaces`, `loadUSRegionVocabulary`, `loadPersonNameSurfaces`) are real files, so a surface may be excluded for a different reason than the test assumes.

⚠ For each failure, diagnose before adjusting. Print the build's counters and the produced keys:

```bash
yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts --reporter=verbose
```

Adjust the **fixture rows** (populations, names) to make the intended law fire. Do NOT weaken an assertion to match observed output — that inverts the test. If a law cannot be provoked with a seeded row, that is a finding worth reporting, not a reason to delete the case.

- [ ] **Step 3: Move the full-scale tests to their own file**

Create `mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts` containing **exactly** the `describe.skipIf(!existsSync(ADMIN_DB))("locality-surface build — integration (admin DB)", …)` block currently at the bottom of `evidence-lexicons.test.ts` (lines 195–261), with this header:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FULL-SCALE locality-surface build against the live WOF admin DB.
 *
 *   NOT ON THE PR PATH by default. Measured 2026-08-02 this file was 236.9s of a 253s CI leg, and it
 *   grows with the gazetteer. It runs in three places, each catching something the others cannot:
 *
 *     - `test.yml` job `lexicon-full`, path-gated — a PR that changes the builder or its inputs.
 *     - `lexicon-nightly.yml` — DATA drift. The gazetteer is rebuilt outside any PR, so no path
 *       filter can see it. This is the only layer that catches that.
 *     - `publish.yml` prepare — the release gate.
 *
 *   The every-PR law coverage lives in `evidence-lexicons.fixture.test.ts`, which is invariant to
 *   gazetteer size. What stays HERE is the coverage-scale claims — `entries > 10_000` and the
 *   nonzero skip counters — because those are claims about the gazetteer, not about the laws.
 */

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"

import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

const ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))
```

Then delete lines 195–261 from `evidence-lexicons.test.ts` (the `const ADMIN_DB` line and the whole `describe.skipIf` block), and drop the now-unused `existsSync` / `dataRootPath` imports from it.

- [ ] **Step 4: Verify the split**

Run:

```bash
yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts
yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts
```

Expected: both PASS, both in under two seconds.

Run: `time yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts`
Expected: PASS, ~130s (Task 3's memo applies).

- [ ] **Step 5: Update the CI globs**

In `package.json`, `ci:test:fast` currently excludes the whole old file. Replace that exclusion so the fixture and pure-unit files run on the fast leg and only the full one is held back:

```json
    "ci:test:fast": "vitest --run --exclude './mailwoman/test/**' --exclude './mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts' --exclude './mailwoman/commands/geocode.test.ts' --exclude './resolver-wof-sqlite/**' --exclude './neural/test/**'",
    "ci:test:slow": "vitest --run mailwoman/test mailwoman/commands/geocode.test.ts resolver-wof-sqlite neural/test",
```

Note `evidence-lexicons.full.test.ts` is now in **neither** leg — Task 5 gives it its own job.

- [ ] **Step 6: Verify both legs**

Run: `time yarn ci:test:fast`
Expected: PASS. The fixture file is now included; wall-clock should stay near the ~7.5s baseline.

Run: `time yarn ci:test:slow`
Expected: PASS in ~90s (was ~240s). This is the headline number for the whole plan — record it.

- [ ] **Step 7: Commit**

```bash
yarn oxfmt mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts package.json
yarn lint:oxlint
git add mailwoman/gazetteer-pipeline/evidence-lexicons.test.ts mailwoman/gazetteer-pipeline/evidence-lexicons.fixture.test.ts mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts package.json
git commit -m "$(cat <<'EOF'
test(gazetteer): assert the four laws against a fixture, not the whole WOF

evidence-lexicons.test.ts was 236.9s of a 253s CI leg — two tests each
building the locality-surface lexicon over the full admin DB, FR then US.
It was also the one file that grows with the gazetteer.

The laws now have a seeded fixture DB (same idiom as candidate-lookup.test:
production DDL, hand-picked rows, the REAL builder via opts.dbPath) that
runs in under a second and does not move when the gazetteer does. Every row
is one the full-scale test named.

The scale assertions did not migrate, they got sharper: the fixture seeds
exactly one below-floor surface, so skippedProminence is asserted as === 1
rather than > 0. entries > 10_000 stays with the full build, because that is
a claim about the gazetteer rather than about the laws.

Slow leg: ~240s -> ~90s locally.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 5: Give the full-scale build its three CI homes

`evidence-lexicons.full.test.ts` is in no leg after Task 4. It gets a path-gated job, a nightly workflow, and a release-time run — plus an annotation so a PR that skipped it says so.

**Files:**

- Modify: `.github/workflows/test.yml`
- Create: `.github/workflows/lexicon-nightly.yml`
- Modify: `.github/workflows/publish.yml`

**Interfaces:**

- Consumes: the test file from Task 4, and the derived-store materialization from Task 2.
- Produces: a `lexicon-full` job that the `test` aggregator gates on.

- [ ] **Step 1: Add the path-gated job to `test.yml`**

Insert after the `unit-slow` job:

```yaml
# The FULL-SCALE locality-surface build. Measured 2026-08-02 at 236.9s and growing with the
# gazetteer, which is why it is not in unit-slow: it WAS unit-slow's wall-clock, 93% of the leg's
# test time in two tests. The every-PR law coverage is the fixture layer
# (evidence-lexicons.fixture.test.ts), which is gazetteer-invariant and runs in unit-fast.
#
# This job is what a PR touching the BUILDER or its inputs has to clear. Data drift — the
# gazetteer being rebuilt outside any PR — is invisible to a path filter and is covered by
# lexicon-nightly.yml instead.
#
# NOT PORTABLE: reads the 4.9 GB admin DB, same as unit-slow.
lexicon-full:
  needs: data-fleet
  if: needs.data-fleet.outputs.up == 'true'
  runs-on:
    - self-hosted
    - mailwoman-data
  timeout-minutes: 25
  steps:
    - uses: actions/checkout@v7

    - name: Detect lexicon-affecting changes
      id: changes
      if: github.event_name == 'pull_request'
      uses: dorny/paths-filter@7b450fff21473bca461d4b92ce414b9d0420d706 # v4.0.2
      with:
        filters: |
          lexicon:
            - 'mailwoman/gazetteer-pipeline/**'
            - 'data/gazetteer/**'
            - 'core/data/**'
            - 'codex/**'

    - name: Setup Node
      if: github.event_name != 'pull_request' || steps.changes.outputs.lexicon == 'true'
      uses: actions/setup-node@v7
      with:
        node-version-file: .nvmrc

    - name: Enable Corepack (yarn 4)
      if: github.event_name != 'pull_request' || steps.changes.outputs.lexicon == 'true'
      run: corepack enable

    - name: Install dependencies
      if: github.event_name != 'pull_request' || steps.changes.outputs.lexicon == 'true'
      run: yarn install --immutable

    - name: Compile
      if: github.event_name != 'pull_request' || steps.changes.outputs.lexicon == 'true'
      run: yarn compile

    - name: Full-scale locality-surface build
      if: github.event_name != 'pull_request' || steps.changes.outputs.lexicon == 'true'
      run: yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts

    # A gate that silently means less while reporting the same is worse than one that is honestly
    # unavailable — the same rule the data-fleet skip path follows. When the path filter holds this
    # job back, the run says so rather than showing an unexplained green tick.
    - name: Say what this run did NOT cover
      if: github.event_name == 'pull_request' && steps.changes.outputs.lexicon != 'true'
      run: |
        echo "::notice title=lexicon-full SKIPPED::No path under mailwoman/gazetteer-pipeline/, data/gazetteer/, core/data/ or codex/ changed, so the FULL-SCALE locality-surface build did not run. The four laws were still asserted against the fixture layer (evidence-lexicons.fixture.test.ts) in unit-fast. Coverage-scale claims (entries > 10_000, the nonzero skip counters) were NOT exercised on this run; lexicon-nightly.yml and the release gate carry those."
        {
          echo "## lexicon-full: skipped (path-gated)"
          echo ""
          echo "Laws asserted: **yes** — fixture layer, in \`unit-fast\`."
          echo "Full-scale build: **no** — no lexicon-affecting path changed."
          echo "Covered instead by: \`lexicon-nightly.yml\`, and \`publish.yml\` at release."
        } >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Add `lexicon-full` to the aggregator**

In the `test` job, change:

```yaml
needs: [data-fleet, static, unit-fast, unit-slow, react, smoke]
```

to:

```yaml
needs: [data-fleet, static, unit-fast, unit-slow, react, smoke, lexicon-full]
```

and add a row to the partial-gate summary table, after the `smoke` row:

```yaml
echo "| lexicon-full | \`mailwoman-data\` | ${{ needs.lexicon-full.result }} |"
```

Also update the file-header comment: the leg count changes from five to six, and the header's `STRUCTURE` paragraph must name `lexicon-full` and say what it covers.

- [ ] **Step 3: Create the nightly workflow**

Create `.github/workflows/lexicon-nightly.yml`:

```yaml
# The full-scale locality-surface build, nightly, against the LIVE data root.
#
# WHY A NIGHTLY AND NOT JUST A PATH GATE: the path-gated `lexicon-full` job in test.yml catches a PR
# that changes the BUILDER. It cannot catch the other failure mode — the gazetteer itself being
# rebuilt. That happens outside any pull request, so no path filter will ever see it, and the first
# symptom would otherwise be a bad lexicon shipping at release. This job is the control for the
# fixture layer: if the fixture stops representing the real data, this is what says so.
#
# Failure here is not a broken build — it is a data finding. It annotates loudly rather than
# silently going red in a tab nobody opens.
name: Lexicon nightly

on:
  schedule:
    # 03:41 UTC — after the gazetteer build window, before the working day.
    - cron: "41 3 * * *"
  workflow_dispatch:

permissions:
  contents: read

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
  ONNXRUNTIME_NODE_INSTALL: skip

jobs:
  full-build:
    runs-on:
      - self-hosted
      - mailwoman-data
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v7

      - name: Setup Node
        uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc

      - name: Enable Corepack (yarn 4)
        run: corepack enable

      - name: Install dependencies
        run: yarn install --immutable

      - name: Compile
        run: yarn compile

      - name: Full-scale locality-surface build
        id: build
        run: yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts

      - name: Report a data-drift failure
        if: failure() && steps.build.outcome == 'failure'
        run: |
          echo "::error title=LEXICON DATA DRIFT::The full-scale locality-surface build failed against the live data root, and no PR changed the builder. Either the gazetteer was rebuilt with different content, or the fixture layer has stopped representing it. Check the gazetteer build log before assuming the test is wrong."
```

- [ ] **Step 4: Add the release-time run to `publish.yml`**

`publish.yml` already runs `yarn vitest run neural/test/pair-index-card-parity.test.ts` at line 376. Add immediately after it, in the same job:

```yaml
# The full-scale locality-surface build. On the PR path this is gated behind a path filter
# (test.yml `lexicon-full`), so a release must exercise it explicitly rather than inheriting a
# green tick that meant "no lexicon path changed".
- name: Full-scale locality-surface build
  run: yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts
```

- [ ] **Step 5: Validate all three workflows**

Run:

```bash
for f in .github/workflows/test.yml .github/workflows/lexicon-nightly.yml .github/workflows/publish.yml; do
  node -e "require('node:fs').readFileSync('$f','utf8'); console.log('read ok: $f')"
done
yarn oxfmt .github/workflows/test.yml .github/workflows/lexicon-nightly.yml .github/workflows/publish.yml
```

Then push and confirm on a real PR:

```bash
git push
gh pr create --fill --base main
```

Expected on a PR that does **not** touch the gazetteer pipeline: `lexicon-full` is green in seconds and the run summary carries the "skipped (path-gated)" block. On a PR that does touch it: the job runs the full build.

⚠ Verify the aggregator still reports. `test` is the required status check and both the ruleset and publish.yml's auto-merge match on that exact context name — adding a `needs` entry must not rename it.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/test.yml .github/workflows/lexicon-nightly.yml .github/workflows/publish.yml
git commit -m "$(cat <<'EOF'
ci(lexicon): give the full-scale build a path gate, a nightly, and a release run

Task 4 took the full-scale locality-surface build off the PR path. It comes
back in three places, each catching what the others cannot:

  - test.yml `lexicon-full`, path-gated on the pipeline and its inputs —
    catches a PR that changes the builder.
  - lexicon-nightly.yml — catches DATA DRIFT. The gazetteer is rebuilt
    outside any PR, so no path filter can see it. This is the control for
    the fixture layer.
  - publish.yml — the release gate, run explicitly rather than inherited.

When the path gate holds the job back the run says so, in the style of the
existing PARTIAL GATE annotation. A gate that silently means less while
reporting the same is worse than one that is honestly unavailable.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 6: Stop reloading the model in `weights.test.ts`

96.6s across 14 tests. Five in the pair-prior block each call `execFileSync` on **two** `link-dev-weights.ts` scripts and then `loadFromWeights({locale: "en-gb"})`, at 12–13s apiece — while varying only decode-time configuration. The link scripts are idempotent symlink creation; running them five times is pure waste.

**Files:**

- Modify: `neural/test/weights.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: nothing other tasks import.

- [ ] **Step 1: Record the baseline**

Run:

```bash
yarn vitest run neural/test/weights.test.ts --reporter=json --outputFile=/tmp/weights-before.json
node -e '
const j=require("/tmp/weights-before.json");
const r=j.testResults[0];
console.log("file:", ((r.endTime-r.startTime)/1000).toFixed(1)+"s");
for (const a of r.assertionResults.sort((x,y)=>(y.duration||0)-(x.duration||0)).slice(0,8))
  console.log("  "+((a.duration||0)/1000).toFixed(1)+"s  "+a.fullName.slice(0,100));
'
```

Write the numbers down. The file was 96.6s at baseline.

- [ ] **Step 2: Hoist the link scripts**

The file currently repeats this inside each test:

```ts
const enUSLinkScript = repoRootPath("neural-weights-en-us", "scripts", "link-dev-weights.ts")
execFileSync(process.execPath, [enUSLinkScript], { stdio: "pipe" })

const enGBLinkScript = repoRootPath("neural-weights-en-gb", "scripts", "link-dev-weights.ts")
execFileSync(process.execPath, [enGBLinkScript], { stdio: "pipe" })
```

Add a module-scope helper near the top of the file, after the imports:

```ts
/**
 * Run each locale's `link-dev-weights.ts` at most ONCE per process.
 *
 * The scripts are idempotent symlink creation, and every test in the pair-prior block was invoking
 * two of them — five tests, ten spawns, for a result that cannot change after the first. Measured
 * 2026-08-02, this file was 96.6s of a 253s CI leg.
 *
 * Kept lazy rather than moved to a top-level `beforeAll`: the tests that need it are `skipIf`-gated
 * on the dev model being present, and a `beforeAll` would spawn the scripts even on a host where
 * every one of those tests skips.
 */
const linkedLocales = new Set<string>()

function ensureDevWeightsLinked(...locales: readonly string[]): void {
	for (const locale of locales) {
		if (linkedLocales.has(locale)) continue

		execFileSync(process.execPath, [repoRootPath(`neural-weights-${locale}`, "scripts", "link-dev-weights.ts")], {
			stdio: "pipe",
		})
		linkedLocales.add(locale)
	}
}
```

Replace every occurrence of the four-line block above with:

```ts
ensureDevWeightsLinked("en-us", "en-gb")
```

Find them all:

```bash
grep -n "link-dev-weights.ts" neural/test/weights.test.ts
```

⚠ Some call sites link only one locale (e.g. `en-nz`). Match each site's locale list exactly — do not widen it.

- [ ] **Step 3: Run to verify the assertions still pass**

Run: `yarn vitest run neural/test/weights.test.ts`
Expected: PASS, same test count as baseline. Record the new wall-clock.

- [ ] **Step 4: Share the en-gb classifier where the load does not vary**

Inspect what each pair-prior test passes to `loadFromWeights`:

```bash
grep -n "loadFromWeights(" neural/test/weights.test.ts
```

For the tests that call the bare `loadFromWeights({ locale: "en-gb" })` with no other options, add a lazily-built shared instance inside that `describe`:

```ts
/**
 * One en-gb classifier for the tests that load it with NO varying options.
 *
 * The tests in this block differ in decode-time configuration (`placetypePair`, `pairIndexPath`,
 * `transitionBeta`), not in how the session was constructed — so the ones that take the plain
 * `{ locale: "en-gb" }` path were each paying a 12–13s load for an identical object.
 *
 * Tests that are ABOUT load behaviour keep their own load: the auto-resolve cases, the tolerant
 * loader paths, and the error cases all assert on the act of loading and must not share.
 */
let sharedGB: Awaited<ReturnType<typeof NeuralAddressClassifier.loadFromWeights>> | undefined

async function gbClassifier() {
	ensureDevWeightsLinked("en-us", "en-gb")
	sharedGB ??= await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })

	return sharedGB
}
```

and in those tests replace `const cls = await NeuralAddressClassifier.loadFromWeights({ locale: "en-gb" })` with `const cls = await gbClassifier()`.

⚠ Do NOT share into a test that passes any option beyond `{ locale: "en-gb" }`, and do not share into `resolveWeights` tests — those assert on resolution, not on a loaded model. If a test mutates the classifier or relies on fresh decode state, leave it with its own load and say so in a comment.

- [ ] **Step 5: Run to verify**

Run: `yarn vitest run neural/test/weights.test.ts`
Expected: PASS, same test count. Wall-clock target ~45s (from 96.6s).

⚠ If any assertion now fails, the shared instance is carrying state between tests. Revert that specific test to its own load rather than weakening the assertion.

- [ ] **Step 6: Run the whole slow leg**

Run: `time yarn ci:test:slow`
Expected: PASS. Record the wall-clock.

- [ ] **Step 7: Commit**

```bash
yarn oxfmt neural/test/weights.test.ts
yarn lint:oxlint
git add neural/test/weights.test.ts
git commit -m "$(cat <<'EOF'
test(neural): load the en-gb weights once, not once per assertion

weights.test.ts was 96.6s. Five tests in the pair-prior block each spawned
TWO link-dev-weights.ts scripts and then loaded the model, at 12-13s apiece
— while varying only decode-time configuration (placetypePair, pairIndexPath,
transitionBeta), not how the session was built. The link scripts are
idempotent symlink creation; ten spawns could not produce a different result
than one.

Tests that are ABOUT loading keep their own load: the auto-resolve cases,
the tolerant-loader paths, and the error cases all assert on the act of
loading.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 7: Cache the compiled `out/` tree

`tsc -b` costs 29–36s in every leg — five times per PR on the same commit. Measured: cold is 32.9s; with `out/` and the `.tsbuildinfo` files present but `node_modules` freshly reinstalled it is 13.0s. So this is 33s → ~13s per leg, not → 0s.

**Files:**

- Modify: `.github/workflows/test.yml`

**Interfaces:**

- Consumes: the freed cache quota from Task 1.
- Produces: nothing other tasks import.

- [ ] **Step 1: Confirm `out/` is not tracked**

Run:

```bash
git check-ignore -q core/out && echo "ignored: ok" || echo "NOT IGNORED — stop"
du -shc $(find . -maxdepth 2 -type d -name out -not -path "./node_modules/*" -not -path "./.claude/*") 2>/dev/null | tail -1
find . -maxdepth 2 -name "*.tsbuildinfo" -not -path "./node_modules/*" -not -path "./.claude/*" | wc -l
```

Expected: ignored, 274 MB, 88 tsbuildinfo files.

- [ ] **Step 2: Add the cache step to each leg**

In `.github/workflows/test.yml`, insert immediately **before** every `- name: Compile` step (there are five: `static`, `unit-fast`, `unit-slow`, `react`, and the new `lexicon-full`; `smoke` too if it compiles):

```yaml
# The compiled tree, keyed on the sources it is a function of. `tsc -b` costs 29–36s in every
# leg — the same build, five times, on the same commit. Measured 2026-08-02: cold 32.9s;
# with out/ and the .tsbuildinfo files restored but node_modules freshly installed, 13.0s.
# It does NOT go to zero — `tsc -b` still stats the project graph — so this is ~20s per leg.
#
# The key hashes every tsconfig and every source file the build reads. It deliberately does
# NOT use restore-keys: a partial restore would leave a stale out/ that `tsc -b` might accept
# as current, which is the stale-artifact shape this repo has been bitten by before.
- name: Restore compiled tree
  uses: actions/cache@v6
  with:
    path: |
      */out
      */*.tsbuildinfo
      tsconfig.tsbuildinfo
    key: out-${{ runner.os }}-${{ hashFiles('**/tsconfig.json', 'tsconfig.base.json', 'yarn.lock') }}-${{ github.sha }}
```

⚠ The `github.sha` component means every commit is a fresh key and a fresh save. That is intentional for correctness but it fills the cache quickly — which is exactly why Task 1 has to land first and why the prune runs daily. If quota pressure returns, narrow the key to a hash of the source files rather than the SHA, and re-verify that a source-only change still busts it.

- [ ] **Step 3: Verify the compile step shortens**

Push and read the step timings across two consecutive runs:

```bash
gh api repos/sister-software/mailwoman/actions/runs/<id>/jobs \
  --jq '.jobs[] | {job: .name, steps: [.steps[] | select(.name=="Compile" or .name=="Restore compiled tree") | {name, dur: ((.completed_at|fromdateiso8601)-(.started_at|fromdateiso8601))}]}'
```

Expected on the second run: `Compile` ≤ 15s (was 29–36s), and `Restore compiled tree` a few seconds.

⚠ On the first run the cache misses on every leg and `Compile` is unchanged. That is correct, not a failure — the key includes `github.sha`, so within one PR the legs of the _same_ run all miss. The win lands on re-runs and on the pushes after the first. If that trade is not worth it, drop `github.sha` from the key and hash the sources directly.

- [ ] **Step 4: Confirm the cache is not blowing the quota**

Run: `gh api repos/sister-software/mailwoman/actions/cache/usage`
Expected: still under 8 GB after several runs. If not, tighten the key as described above and re-run the Task 1 prune.

- [ ] **Step 5: Commit**

```bash
yarn oxfmt .github/workflows/test.yml
git add .github/workflows/test.yml
git commit -m "$(cat <<'EOF'
ci(compile): cache the compiled tree so tsc -b is not run five times a commit

`tsc -b` costs 29-36s in every leg — the same build, five times, on the same
commit, 171s of the 1049s machine budget. Measured: cold 32.9s; with out/ and
the .tsbuildinfo files restored but node_modules freshly installed, 13.0s. It
does not go to zero (tsc -b still stats the project graph), so this is ~20s
per leg.

No restore-keys on purpose: a partial restore leaves a stale out/ that tsc -b
may accept as current, which is a shape this repo has been bitten by.

Depends on the cache prune landing first — there was no quota for this.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

### Task 8: Free items — vitest excludes and a measured worker cap

Two small things. The excludes fix a confirmed local flake. The worker cap has to be **measured after Task 4**, because before it the slow leg is one-file-bound and capping workers would measure the wrong thing.

**Files:**

- Modify: `vitest.config.ts`
- Modify: `package.json` (only if the measurement supports a cap)

**Interfaces:**

- Consumes: Task 4's slow-leg split (the cap measurement is invalid before it).
- Produces: nothing other tasks import.

- [ ] **Step 1: Reproduce the `.venv` collection**

Run (from the **main checkout**, which has the virtualenv — the worktree does not):

```bash
cd /home/lab/Projects/mailwoman
yarn vitest list --run 2>/dev/null | grep -c "corpus-python/.venv" || echo 0
```

Expected: a nonzero count — five files under `corpus-python/.venv/lib/python3.12/site-packages/trackio/frontend/`.

Return to the worktree afterwards: `cd /home/lab/Projects/mailwoman/.claude/worktrees/perf+test-suite`

- [ ] **Step 2: Add the excludes**

In `vitest.config.ts`, add to the `exclude` array, after the `.claude/worktrees` entry:

```ts
			// `corpus-python/.venv` is a Python virtualenv that vendors a Svelte app (trackio) carrying
			// its own *.test.js files. Vitest collected five of them; at `--maxWorkers=4` one FAILED the
			// run outright ("No test suite found in file .../legend.test.js"), and the rest showed up as
			// an unexplained `1 skipped`. Not a CI cost — .venv is not checked in, and a fresh checkout
			// collects 316 files against the main tree's 327 — but a real local and agent-worktree flake.
			"**/.venv/**",
			// scratchpad/ holds staged release trees and probe output, some of which is copied source.
			"**/scratchpad/**",
```

- [ ] **Step 3: Verify the collection is clean**

Run (from the main checkout again):

```bash
cd /home/lab/Projects/mailwoman
yarn vitest list --run 2>/dev/null | grep -c "corpus-python/.venv" || echo 0
cd /home/lab/Projects/mailwoman/.claude/worktrees/perf+test-suite
```

Expected: `0`.

Run: `yarn vitest run --maxWorkers=4 --exclude './mailwoman/test/**' --exclude './mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts' --exclude './mailwoman/commands/geocode.test.ts' --exclude './resolver-wof-sqlite/**' --exclude './neural/test/**'`
Expected: PASS with **no** `1 skipped` and no `legend.test.js` failure.

- [ ] **Step 4: Measure the worker cap on the post-Task-4 slow leg**

```bash
for w in 4 8 16; do
  echo "=== maxWorkers=$w ==="
  /usr/bin/time -f "WALL %e s CPU %P" yarn ci:test:slow --maxWorkers=$w 2>&1 | grep -E "Test Files|Duration|WALL"
done
```

Record all three. Pick the value only if one is clearly better on wall-clock **or** materially cheaper in CPU at equal wall-clock — the lab runs two data legs concurrently on 16 cores, so CPU matters.

- [ ] **Step 5: Apply the cap only if the measurement supports it**

If a cap wins, add it to the CI script in `package.json`:

```json
    "ci:test:slow": "vitest --run --maxWorkers=8 mailwoman/test mailwoman/commands/geocode.test.ts resolver-wof-sqlite neural/test",
```

If no value beats the default on either axis, **change nothing** and record the measurement in the commit message. A cap that does not help is config debt.

- [ ] **Step 6: Commit**

```bash
yarn oxfmt vitest.config.ts package.json
yarn lint:oxlint
git add vitest.config.ts package.json
git commit -m "$(cat <<'EOF'
test(config): stop collecting the Python virtualenv's vendored suites

vitest's excludes covered node_modules but not .venv, so it collected five
*.test.js files from corpus-python/.venv/.../trackio/frontend/ — a Svelte app
vendored inside a Python virtualenv. At --maxWorkers=4 one of them failed the
run outright; the rest were the unexplained `1 skipped`.

Local and agent-worktree only: .venv and scratchpad/ are not checked in, and
a fresh checkout collects 316 files against the main tree's 327. CI was never
affected.

Worker-count measurement on the post-split slow leg is in the PR body.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0193E36N6nVJKonvQyXjCWXg
EOF
)"
```

---

## Final verification

- [ ] **Run the whole suite clean**

```bash
yarn compile
yarn ci:test:fast
yarn ci:test:slow
yarn vitest run mailwoman/gazetteer-pipeline/evidence-lexicons.full.test.ts
yarn lint
yarn typecheck
```

All must pass.

- [ ] **Measure the acceptance criteria over three consecutive CI runs**

```bash
for i in 1 2 3; do
  git commit --allow-empty -m "chore: acceptance probe $i"
  git push
done

# For each run:
gh run view <id> --json jobs \
  --jq '.jobs[] | {name, dur: ((.completedAt|fromdateiso8601)-(.startedAt|fromdateiso8601))}'
```

Check every criterion from the spec:

| criterion                                                     | target                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| green wall-clock, no-op PR                                    | ≤ 3m00s on all three runs (was 6m29s)                           |
| hosted-leg install                                            | ≤ 30s on all three legs, all three runs (was 24s/83s coin-flip) |
| `active_caches_size_in_bytes`                                 | < 8 GB (was 10.7 GB)                                            |
| `unit-slow` test step, non-gazetteer PR                       | ≤ 120s (was 253s)                                               |
| full-scale build still runs, still asserts `entries > 10_000` | in nightly and release                                          |
| a run that skips it says so                                   | step summary present                                            |
| `evidence-lexicons` PR path invariant to gazetteer size       | fixture test unchanged by a rebuild                             |
| no net loss of assertions                                     | every law still asserted on every PR                            |

⚠ Report every number, including any that miss. A criterion that is not met is a finding, not something to quietly drop — say which one and by how much.

- [ ] **Update the spec with the measured outcome**

Add a `## Outcome` section to `docs/superpowers/specs/2026-08-02-test-suite-performance-design.md` with the three-run table and any criterion that missed. Commit.
