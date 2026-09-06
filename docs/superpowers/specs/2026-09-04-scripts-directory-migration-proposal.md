# Moving out of `scripts/` — proposal

Status: proposal, revised after operator review on 2026-09-04. The diagnosis (sections 1 and 2) stands;
the destination model (sections 3 to 7) is the revised one. Nothing moves until section 8's decisions
are confirmed. Measured on `main` at 86f050d99.

## 1. What is in the drawer

| Family                             | Files                         | Lines  | Referenced by                                                                           | Referenced by nothing                                                                         |
| ---------------------------------- | ----------------------------- | ------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| release and weights pipeline       | 25 (6 tests)                  | 5,215  | 6 workflows (publish.yml 8 paths), `.release-it.json` 2, `package.json` 2, each other   | 4: `bless-package`, `scaffold-weights-overlay`, `link-weights-overlay`, `stage-weights-cache` |
| eval and probes                    | 31 `.ts` + 3 `.py` + fixtures | 5,650  | each other only (`value-match.ts`, `two-model-probe.ts` are internal libraries)         | all 31                                                                                        |
| repository health and verification | 13 (5 tests)                  | 2,245  | `package.json` (`health:*`, `typecheck:tests`) 4, workflows 2, husky 1                  | 2: `verify-slice-acks`, `verify-export-quant-versions`                                        |
| other                              | 14 (2 tests)                  | 1,302  | workflows 2 (`merge-admin`, `check-board-pins`), `package.json` 1                       | 7: four probes, `generate-sbom`, `rewrite-workspace-imports`, `process-util`                  |
| total                              | 95 files, 83 `.ts` (12 tests) | 14,412 | 19 paths from workflows, 8 from `package.json`, 2 from `.release-it.json`, 1 from husky | 44 of 71 non-test `.ts` files                                                                 |

Liveness by receipt: 24 of the 31 eval scripts are cited by at least one record under `docs/` or
`evals/`; `per-locale-f1.ts` (11 citations) and `oa-resolver-eval.ts` (8) lead. Ten are cited by
nothing: `value-match`, `two-model-probe`, `summarize-arenas`, `score-suffix-boundary`,
`pip-containment`, `locality-regression-probe`, `fr-parse-recall`, `fit-per-locale-calibration.py`,
`de-duplicate-locality-diag`, `build-situs-holdout`. Commit dates say nothing here: every file was
touched by the August and September repo-wide sweeps.

## 2. Why it became a drawer

Three properties of the directory, each a mechanism rather than a habit:

1. **`knip.json` lists `scripts/**/*.ts` as an entry point.** An entry is never unused, so no file in
   the directory can be reported dead. The 44 unreferenced files above are invisible to the one tool
   that reports unused files.
2. **`scripts/` is its own TypeScript project that no package can import.** Nine scripts are libraries
   for other scripts (`release-stage`, `pack-workspace`, `publish-exports`, `verify-tarball`,
   `derived-weights-key`, `weights-recipe`, `ts-ast`, `tracked-sources`, `process-util`,
   `value-match`, `two-model-probe`). A package that needs the same thing re-types it. Today's review
   found exactly this twice: the release-config reader (fixed by moving it to
   `@mailwoman/core/release-config`) and `process-util.ts`, which duplicates
   `@mailwoman/core/process`.
3. **It has no owner.** A package has a README, an `exports` map, a `files` array and a test
   directory that CI reasons about; `scripts/` has a tsconfig. The `sdk/` regroup and the `tools/`
   census in AGENTS.md happened to packages because packages have boundaries to enforce.

## 3. The rule that replaces the directory: capability, then interface

A file under `scripts/` is an implementation and an interface at once: the path is the API. The revised
model separates the two.

```
release operation (release-kit)
      │
      ├── private CLI adapter  →  CI and humans      (mwops release …)
      │
      └── MCP adapter          →  agents             (release-mcp, separately enabled)
```

Capabilities live in domain packages that contain the logic and nothing else. Interfaces are thin
adapters that expose a capability set to a consumer: a private CLI for CI and humans, an MCP server
for agents, the public `mailwoman` CLI for users. Neither adapter carries meaningful logic.

| Kind                              | Home                                                           | Admission rule (mechanical)                                                                                                                |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| a release capability              | private `packages/release-kit` (`@mailwoman/release-kit`)      | the operation participates in the construction, verification, staging, or publication of a release artifact                                |
| a repository health check         | private `packages/repo-health`                                 | inspects the repository and returns diagnostics or pass/fail; no mutation, generation, publishing, benchmark, probe, or one-shot migration |
| a measurement                     | `packages/mailwoman/lib/dev-tools/*.run.ts` (33 today)         | reproducible, and it produces evidence a record can cite                                                                                   |
| an agent adapter over diagnostics | `@mailwoman/dev-mcp` (24 tools today)                          | an adapter over maintained diagnostic and measurement capabilities, never a second implementation home                                     |
| an agent adapter over release     | new private `@mailwoman/release-mcp`                           | an adapter over `release-kit`'s registry, separately enabled, the only MCP surface with external-write effects                             |
| the private operator CLI          | `mwops`, either `packages/ops-cli` or a `bin` of `release-kit` | views over the two registries below; no logic                                                                                              |
| a one-shot task or codemod        | nowhere                                                        | deleted after use, or graduated into a capability                                                                                          |

Two rules apply everywhere: no directory-wide knip entry glob anywhere in the repository, and no
workflow executes a `lib/*.ts` path. The earlier draft's `node packages/release-kit/lib/release/x.ts`
was `scripts/` with a longer name; it exposed implementation files as an operational API and is
withdrawn.

## 4. Registries are the only executable entry points

Each capability package exports one registry; the registry is the package's knip entry point, so an
implementation file nobody registers is dead code again — which is exactly the failure mode section 2
names and `scripts/**/*.ts` as an entry glob made impossible to see.

`repo-health`:

```ts
interface RepoCheck {
	id: string
	description: string
	run(context: RepoContext): Promise<Diagnostic[]>
}

export const checks: readonly RepoCheck[] = [
	verifyExports,
	verifyVersionSync,
	verifyTestContract,
	nodeModulesReacharound,
	debtCounters,
	vocabCensus,
]
```

`release-kit`:

```ts
interface ReleaseOperation<In, Out> {
	id: string // "release.publish"
	effect: "read" | "local-write" | "external-write"
	inputSchema: ZodType<In>
	outputSchema: ZodType<Out>
	run(input: In, context: ReleaseContext): Promise<Out>
}

export const operations = [preflight, prepare, pack, verify, stage, publish, publishWeights, sbom]
```

The CLI and the MCP adapter are views over these arrays: `mwops release <id>` binds flags from
`inputSchema` and prints `outputSchema`; `release-mcp` exposes each operation as a tool with the same
schemas and surfaces `effect` as the tool's annotation. A capability added to the registry appears in
both; a file added beside the registry appears in neither and knip reports it.

## 5. External writes are plan → execute

Publishing has credentials and irreversible effects, so no adapter runs it in one step. The contract,
shared by CI and agents:

```
release_plan(…)     → { gitHead, version, packages, artifacts, destinations, planDigest }
release_publish({ planDigest })
```

`release_publish` recomputes the plan and refuses when HEAD is dirty or has moved, or when the recomputed
digest differs from the one presented. The CLI uses the same two operations:

```
mwops release plan --json > release-plan.json
mwops release publish --plan release-plan.json
```

One implementation, one contract, two consumers; CI's publish workflow becomes those two lines plus
`mwops release preflight`, in place of eight `node scripts/…` invocations.

`dev-mcp` stays non-publishing. Its package description is a warm geocoder and measurement; an
ordinary agent session that receives it must not thereby receive npm, Hugging Face or R2 publishing
authority. `release-mcp` is enabled separately, and its every tool carries `effect`.

## 6. Destinations, file by file

**Release and weights (25) → `release-kit` operations.** `release-stage`, `release-preflight`,
`prepare-release-version`, `release-config-version`, `release-generated-surfaces`, `publish-workspace`,
`publish-exports`, `pack-workspace`, `bless-package`, `verify-release-metadata`, `check-release-parity`,
`verify-tarball`, `copy-weights`, `fetch-hf-weights`, `derived-weights-key`, `weights-recipe` (now a
re-export of `@mailwoman/core/release-config`), `link-weights-overlay`, `stage-weights-cache`,
`scaffold-weights-overlay`, `smoke-clean-install`, `generate-sbom`, and their six tests. Each becomes a
registered operation with an `effect`; the six workflows and `.release-it.json` call `mwops release …`.
`mailwoman release hf` (`commands/release/hf.tsx`), which publishes a release to Hugging Face from
inside the public CLI, moves under the same registry as `release.publish-weights`: an external write
does not belong on the installed product's help tree. RELEASING.md's nine `scripts/` paths and
AGENTS.md's release-pipeline pitfalls follow the operations.

**Health (13) → `repo-health` checks.** `repo-health` (the debt counters), `verify-exports`,
`verify-test-contract`, `verify-version-sync`, `vocab-census`, `node-modules-reacharound.test`,
`typecheck-tests`, with `tracked-sources` and `ts-ast` as its internal helpers. `package.json`'s
`health:*` targets become `mwops health <id>` and `mwops health all`. `generate-man` generates, so it
fails the admission rule; it goes to the CLI's `commands/dev/generate/` beside the generators there.
`verify-slice-acks` and `verify-export-quant-versions` are unreferenced and one carries a retired word:
delete unless a record claims them.

**Eval (31 + 3 `.py`) → three destinations by a per-file triage.**

- A command exists: `oa-resolver-eval` (→ `eval/oa-resolver.tsx`), `per-locale-f1` and `score-affix`
  (→ `eval/parity.tsx` or `eval/score-trends.tsx`, whichever reads the same ledger), `harness-neural`
  and `fullstack-compare` (→ `dev-mcp`'s `compare` and `run`). Delete the script once the command is
  shown to answer the same question, with both row counts in the receipt.
- Cited by a record, no command: port to `dev-tools/<name>.run.ts` unchanged, as the 2026-08-21
  scratchpad ports were.
- Cited by nothing (the ten in section 1): delete; `value-match.ts` and `two-model-probe.ts` go with
  their last consumer.
- The three Python files and `fixtures/` move to `corpus-python/`.

**Other (14).** `merge-admin` and `check-board-pins` become `mailwoman wof merge-admin` and
`mailwoman eval pins` (a `pins.tsx` command exists; confirm it is the same check). `process-util` is
deleted for `@mailwoman/core/process`. `rewrite-workspace-imports` was a one-shot codemod: delete. The
four probes follow the eval triage.

## 7. Sequence

0. **Make the drawer visible.** Remove `scripts/**/*.ts` from knip's `entry`, list the 30 referenced
   paths explicitly, record the count of files knip then reports, and put it in the debt counters as
   `scriptsUnreferenced`, ratcheting to zero. Every later PR is graded against it.
1. **`release-kit` with its registry, and `mwops`.** The release family becomes registered operations;
   `mwops release …` replaces every `node scripts/…` in the six workflows and `.release-it.json`;
   `release plan` and `release publish` carry the digest contract; `mailwoman release hf` moves in.
   Proof before merge: `mwops release preflight` against a staging root, since the publish workflow
   only runs on release day.
2. **`repo-health` with its registry.** `yarn health` becomes `mwops health all`.
3. **`release-mcp`.** An adapter over the registry, separately enabled, `effect` on every tool.
4. **Eval triage**, one PR per destination class, each receipt naming the file and its record.
5. **The remainder of "other"**, then delete `scripts/`, its two `tsconfig.json` references, the knip
   and jscpd `path` entries, and the `scripts/out` ignore. A `repo-health` check refuses any `scripts/`
   path literal outside `docs/records/` from then on, and a second refuses a workflow step that runs a
   `lib/*.ts` path.

Each move follows AGENTS.md "Moving a workspace": sweep for QUOTED path literals in `.github/`,
`.husky/`, `.release-it.json`, `package.json`, `jscpd.json`, `knip.json`, `docs/`, `RELEASING.md` and
`AGENTS.md`, because those strings are read at runtime by something that treats absence as a negative
answer. CodeQL re-raises existing alerts at the new paths; re-dismiss after merge. `smoke-clean-install`
keeps its foreign-install allowlist entry, and `copy-weights` collapses its `REPO_COMMITTED_SOURCES`
into `repoCommittedSoftFeedSources` when it becomes an operation.

## 8. Decisions

1. `release-kit` and `repo-health` stay separate. Yes.
2. Release tooling is a private capability package, a private CLI (`mwops`), and a privileged MCP
   adapter — not public `mailwoman` commands and not bare files. Open: `mwops` as `packages/ops-cli`
   or as a `bin` of `release-kit`.
3. The ten uncited eval scripts are deleted. Yes.
4. CI never executes an arbitrary `lib/*.ts` path; workflows call stable `mwops` commands.
5. Registries are the only executable entry points; knip keeps the power to report an orphan
   implementation file.
6. `dev-mcp` remains non-publishing; external-write operations live behind the separately enabled
   `release-mcp`.

With these, "is this a script?" stops being a question. The question becomes what maintained
capability this is, who consumes it, and what its effect is — and the free-standing executable file is
no longer a category the repository has.

## 9. Status (2026-09-04)

The sequence in §7 ran the same day, with three sub-agents on the families and the operator's revised model as the
target. Receipts, in merge order:

| Step           | Receipt                           | What landed                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0, scaffolds   | #2133                             | `packages/release-kit`, `packages/repo-health`, `packages/ops-cli` (`mwops`); knip's root entry list made explicit; the `scriptsUnreferenced` counter at baseline 27                                                                                                                                                                                                 |
| eval triage    | #2137                             | 25 `dev-tools/*.run.ts`, two libraries, 12 deletions, `mailwoman release merge-admin`, `mailwoman eval pins --check`; two latent defects fixed (the merge-admin pin guard matched a pre-`lib/` path; `honest-eval` spawned a deleted script)                                                                                                                         |
| health family  | #2138                             | eight registered checks, `mwops health <id>                                                                                                                                                                                                                                                                                                                          | all`, `mwops health baseline debt`; `generate-man`became`mailwoman dev generate man-page` |
| release family | #2140                             | fifteen registered operations with effect classes; `mwops release plan` → `planDigest`; `publish-workspace` and `bless-package` take `--plan` and refuse a dirty or moved HEAD; `.release-it.json`, `publish.yml`, `test.yml`, `version-parity.yml` call `mwops`. Found on the way: `auditStagedWorkspaces` never awaited the pack, so preflight had audited 0 of 58 |
| closure        | #2144                             | `scripts/` deleted; residue rehomed (`data/gazetteer/wof-build-manifest.json`, `docs/scripts/publish-demo-assets-to-r2.py`, `dev-tools/verify-export-quant-versions.run.ts`); `no-root-scripts` check registered; `scriptsUnreferenced` retired                                                                                                                      |
| follow-ups     | #2139, #2141, #2145, #2146, #2147 | two release-list workspaces at `0.0.0` raised to the root version; five stale manifest targets removed and the `manifest-targets` check registered (#2142); `version-sync` imports release-kit's release-list reader and `@mailwoman/core/git` replaces seven git shell-outs (#2143)                                                                                 |

Two findings changed the measurement itself. The `scriptsUnreferenced` counter had only ever counted `scripts/eval/`:
git's fnmatch reads `**` as two stars, so `scripts/**/*.ts` needed a directory between `scripts/` and the file, and the
44-of-71 figure in §1 was read by a different instrument than the counter. And the release preflight's tarball audit,
once it ran, refused 2 of 58 packages for manifest entries whose targets had moved (§5's plan → execute would
have stopped there; #2141 and #2147 make that a PR-time check).

Step 4, the `release-mcp` adapter, landed 2026-09-05 as `packages/release-mcp` (private): one tool per registered
operation, named after its id, the declared `effect` opening every description, `dry_run` threaded on the writers, and a
`release_operations` tool listing the whole registry. The operator's contract decision: the two `external-write`
operations are OFF the tool list by default and appear only when the server starts with `--allow-external-write`; they
then still run the plan → execute contract the operations enforce. Packaging follows `ops-cli` (its own private
workspace with a `bin`), which settles decision 2's `bin` question for the MCP view; `release-kit` itself stays bin-less.

Decision 4 is now enforced rather than stated: `no-root-scripts` refuses a workflow or `package.json` target that runs a
bare `lib/*.ts` path, with `packages/ops-cli/lib/cli.ts` as the one named exemption.
