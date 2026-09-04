# Moving out of `scripts/` — proposal

Status: proposal for operator decision. Nothing moves until the three decisions in section 6 are
made. Measured on `main` at 86f050d99 (2026-09-04).

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

## 3. The rule that replaces the directory

Every file under `scripts/` is one of four things, and each already has a home in the repository:

| Kind                                                                                        | Home                                                                                                                                                        | Existing examples                                                               |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| a maintainer pipeline that must not ship to npm (release, publish, weights materialization) | a **private workspace** `packages/release-kit` (`@mailwoman/release-kit`, `private: true`, like `dev-mcp`) with `lib/release/`, `lib/weights/`, `lib/pack/` | none yet; `@mailwoman/dev-mcp` is the private-workspace precedent               |
| a repository health check                                                                   | a **private workspace** `packages/repo-health`                                                                                                              | none yet; `scripts/repo-health.ts` is the seed                                  |
| a product or maintainer command                                                             | the mailwoman CLI: `commands/release/` (has `hf.tsx`), `commands/dev/` (`download`, `generate`, `lint`), `commands/eval/` (23 commands)                     | `eval/oa-resolver.tsx` already exists beside `scripts/eval/oa-resolver-eval.ts` |
| a measurement                                                                               | `packages/mailwoman/lib/dev-tools/*.run.ts` (33 today) or a `dev-mcp` tool (24 today)                                                                       | the five scratchpad ports of 2026-08-21                                         |

Anything that is none of the four is deleted, with its receipt naming the record that already carries
its result.

## 4. Destinations, file by file

**Release and weights (25) → `packages/release-kit`.** `release-stage`, `release-preflight`,
`prepare-release-version`, `release-config-version`, `release-generated-surfaces`,
`publish-workspace`, `publish-exports`, `pack-workspace`, `bless-package`, `verify-release-metadata`,
`check-release-parity`, `verify-tarball`, `copy-weights`, `fetch-hf-weights`, `derived-weights-key`,
`weights-recipe` (now a re-export of core), `link-weights-overlay`, `stage-weights-cache`,
`scaffold-weights-overlay`, `smoke-clean-install`, `generate-sbom`, and their six tests. The
workflows and `.release-it.json` call `node packages/release-kit/lib/<area>/<name>.ts` — type-stripped
source, as today, so the pipeline still runs on a checkout with no compile step. RELEASING.md's nine
`scripts/` paths and AGENTS.md's release-pipeline pitfalls section move with them.

**Health and verification (13) → `packages/repo-health`.** `repo-health`, `verify-exports`,
`verify-test-contract`, `verify-version-sync`, `vocab-census`, `node-modules-reacharound.test`,
`typecheck-tests`, `tracked-sources`, `ts-ast`, and their tests. `package.json`'s `health:*` and
`typecheck:tests` point there. `generate-man` goes to the CLI's `commands/dev/generate/` beside the
generators already there, and the husky hook calls the command. `verify-slice-acks` and
`verify-export-quant-versions` are unreferenced and carry a retired word in one name: delete unless
a record claims them.

**Eval (31 + 3 `.py`) → three destinations by a per-file triage.**

- A command exists: `oa-resolver-eval` (→ `eval/oa-resolver.tsx`), `per-locale-f1` and `score-affix`
  (→ `eval/parity.tsx` or `eval/score-trends.tsx`, whichever already reads the same ledger),
  `harness-neural` and `fullstack-compare` (→ `dev-mcp`'s `compare` and `run`). Delete the script
  after confirming the command answers the same question; the receipt states the row count both
  produce.
- Cited by a record, no command: port to `dev-tools/<name>.run.ts` unchanged, the way the 2026-08-21
  scratchpad ports were done.
- Cited by nothing (the ten above): delete. Their internal libraries `value-match.ts` and
  `two-model-probe.ts` go with the last consumer.
- The three Python files (`fit-isotonic-calibration`, `fit-per-locale-calibration`,
  `calibration-drift-guard`) and `fixtures/` move to `corpus-python/`, where the other Python lives.

**Other (14).** `merge-admin` and `check-board-pins` become `mailwoman wof merge-admin` and
`mailwoman eval pins` (a `pins.tsx` command already exists; confirm it is the same check, then the
workflow calls the command). `process-util` is deleted in favor of `@mailwoman/core/process`.
`rewrite-workspace-imports` was a one-shot codemod: delete. The four probes (`probe-gb-anchor-fire`,
`probe-shaped-obligation`, `overlay-channel-smoke`, `smoke-resolve`) follow the eval triage.

## 5. Sequence

0. **Make the drawer visible before moving anything.** Remove `scripts/**/*.ts` from knip's `entry`
   and list the referenced paths explicitly (the 19 + 8 + 2 + 1 above). knip then reports the
   unreferenced files; record the number and put it in `repo-health` as `scriptsUnreferenced` with
   that baseline, ratcheting to zero as files move or die. This is the measurement every later PR is
   graded against.
1. `packages/release-kit`: the release and weights family, workflows, `.release-it.json`, RELEASING.md,
   AGENTS.md. One PR, exercised by `release:preflight` against a staging root before merge, since the
   publish workflow is the consumer that only runs on release day.
2. `packages/repo-health`: the health family and the `package.json` targets. `yarn health` is the
   proof.
3. Eval triage, one PR per destination class, each with the receipt named per file.
4. The remainder of "other", then delete `scripts/`, its two tsconfig references in the root
   `tsconfig.json`, the knip and jscpd `path` entries, and the `scripts/out` ignore.

Each move follows AGENTS.md "Moving a workspace": after the move, sweep for QUOTED `scripts/`
literals in `.github/`, `.husky/`, `.release-it.json`, `package.json`, `jscpd.json`, `knip.json`,
`docs/`, `RELEASING.md` and `AGENTS.md`, because those strings are read at runtime by something that
treats absence as a negative answer. A one-line check in `repo-health` that fails on any remaining
`scripts/` path literal outside `docs/records/` closes the sweep permanently. CodeQL re-raises
existing alerts at the new paths; re-dismiss after merge.

Two things that must keep their shape when they move: `smoke-clean-install.ts` reads a FOREIGN
install's layout on purpose and holds an allowlist entry in `node-modules-reacharound.test.ts`, which
moves with it; `copy-weights.ts` still holds its own `REPO_COMMITTED_SOURCES` beside
`repoCommittedSoftFeedSources`, and the move is the moment to collapse them.

## 6. Decisions

1. **One private workspace or two.** `release-kit` and `repo-health` have different consumers (the
   publish workflow versus every PR's `test` context) and different failure costs. Recommendation:
   two.
2. **Release tooling as CLI commands or as a private package.** `commands/release/hf.tsx` exists, so
   the CLI route is open. Recommendation: the private package. The CLI ships to npm and its help tree
   is a documented surface (`generate-man`, the CLI reference page); a publish pipeline belongs in
   neither.
3. **Delete versus archive for the ten uncited eval scripts.** Recommendation: delete. The results
   they produced, where they produced any, are in the records that would have cited them; git keeps
   the source.
