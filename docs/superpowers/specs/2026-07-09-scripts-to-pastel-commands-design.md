# Scripts → Pastel commands: the framework-consistency arc

**Date:** 2026-07-09 · **Status:** Shipped 2026-07-10. Phases 0–5 merged to main. All follow-ups closed on 2026-07-10: the fleet retrofit, the regenerated-output churn, and the deletion of build-demo-assets.ts with the run-docs skill repointed at the plugin.
**Driver:** Operator directive: "all our scripts live in their respective packages and there's a consistent use of the framework instead of all these horrible little scripts."
**Prior art:** `2026-07-07-scripts-drawer-to-zero.md` (executed) moved script logic into packages as modules and deferred commands as "a later nicety". This arc does that deferred work. `2026-07-07-scripts-cleanup-gazetteer-cli-design.md` covered the gazetteer half and has shipped.

## Decisions (operator-confirmed 2026-07-09)

1. **Scope:** corpus/scripts, codegen/lint (`mailwoman dev`), registry/tiger/coarse-placer tools, and the eval harness. Release-it hook scripts stay plain because release-it runs them headless and a compile step in the release path would add nothing.
2. **Logic home:** the owning workspace (`corpus/tools/`, `registry/tools/`, …). Command `.tsx` files are thin wrappers in `mailwoman/commands/`, because Pastel file-routing requires them there.
3. **WOF bins:** absorb them into `mailwoman gazetteer` and delete all four `resolver-wof-sqlite` bins. **Slim is deprecated, and we verified that nothing loads it.** The demo runtime's `hasWOFDB` branch loads the version-independent candidate table through httpvfs (`docs/src/pages/demo/_app.tsx:431` → `WOFCandidateTableLookup`) and never fetches `wof-hot.db`. The `buildSlimWOFDatabase` module survives only as the resolver-wof-wasm test-fixture builder. **The demo production smoke test must stay green.**
4. **Lookup bins (timezone/nuts/un-locode):** these keep lean `parseArgs` as the sanctioned exception. They are consumer-facing micro-packages, and the ink+react+zod+commander dependency weight is too heavy for them. The policy is documented below.
5. **Duplicated helpers** move into `@mailwoman/core` or the owning package during each phase (operator: "move them to core or their respective packages").
6. **`sdk/` naming:** `sdk` submodules mean _data acquisition_. `ban/sdk`, `osm/sdk`, and `tiger/sdk` fit. `spatial/sdk` is a borderline data-format case and stays as is. `mailwoman/sdk` breaks the convention because it holds CLI helper types and the parser test harness. Both move out (§4).

## 1. Target command tree

Each table row is one thin `.tsx` in `mailwoman/commands/…` that wraps a `run()`-style module in the listed workspace. A script is deleted once its command exists and all references point at the command.

### `mailwoman corpus` (existing group, gains)

| Command                     | Source script                                                                                                                              | Logic lands in                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `corpus audit`              | `corpus/scripts/audit.ts`                                                                                                                  | `corpus/tools/audit.ts`                                                 |
| `corpus ingest-csv`         | `corpus/scripts/ingest-csv.ts`                                                                                                             | `corpus/tools/ingest-csv.ts`                                            |
| `corpus fetch <source>`     | `corpus/scripts/fetch-nad.ts` + `fetch-sources/*` (ban, hrsa, imls-pls, nppes, openaddresses, state-sources, state-hi-schools, tiger-full) | `corpus/tools/fetch/<source>.ts` over one shared fetch util (§3)        |
| `corpus extract kryptonite` | `corpus/scripts/build-kryptonite-extract.ts`                                                                                               | `corpus/tools/extract-kryptonite.ts`                                    |
| `corpus extract translit`   | `corpus/scripts/build-transliteration-extract.ts`                                                                                          | `corpus/tools/extract-translit.ts`                                      |
| `corpus golden expand`      | `corpus/scripts/expand-golden.ts`                                                                                                          | `corpus/tools/golden-expand.ts`                                         |
| `corpus golden promote`     | `corpus/scripts/promote-golden.ts`                                                                                                         | `corpus/tools/golden-promote.ts`                                        |
| — (fold)                    | `corpus/scripts/run-corpus-build.ts`                                                                                                       | duplicate of existing `corpus run` (`runAdapter`) — verify, then delete |

The source enum makes `fetch` one command instead of nine. The existing `mailwoman/corpus-tools/` (3 files behind the align-extract/stats/overlay-manifest commands) moves into `corpus/tools/` in the same phase, so the corpus workspace owns all corpus logic. The commands are repointed, and `mailwoman` already depends on `@mailwoman/corpus`.

### `mailwoman dev` (new group)

| Command                           | Source script                                          | Logic lands in                                                                   |
| --------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `dev generate country-reference`  | `scripts/generate-country-reference.ts`                | `codex/tools/generate-country-reference.ts`                                      |
| `dev generate official-languages` | `scripts/generate-official-languages.ts`               | `codex/tools/generate-official-languages.ts`                                     |
| `dev generate language-types`     | `scripts/generate-language-types.ts`                   | `core/tools/generate-language-types.ts` (generates core types)                   |
| `dev generate trace-fixture`      | `scripts/generate-trace-fixture.ts`                    | `mailwoman/dev-tools/` (fixture for the docs visualizer; no better owner)        |
| `dev lint corpus-extract`         | `scripts/lint-corpus-extract.ts` (+ `lint-rules.json`) | `corpus/tools/lint-extract.ts` (rules JSON moves with it)                        |
| `dev lint extract-vocab`          | `scripts/lint-extract-vocab.ts`                        | `corpus/tools/lint-extract-vocab.ts`                                             |
| `dev lint mdx-angles`             | `scripts/lint-mdx-angles.ts`                           | `mailwoman/dev-tools/` (docs tooling; docs workspace is private, can't be a dep) |
| `dev jsonl-to-parquet`            | `scripts/jsonl-to-parquet.ts`                          | `corpus/tools/jsonl-to-parquet.ts` (it writes corpus extracts)                   |

### `mailwoman eval` (new group)

Logic lands in **`mailwoman/eval-harness/`**. This deliberately departs from the owning-workspace rule: no workspace owns evals, and the published CLI cannot depend on a private evals workspace. The `gazetteer-pipeline` module set the same precedent. Check-threshold JSONs (`scripts/eval/checks/*.json`) and fixtures move with the harness. The ledger (`evals/scores-by-version.json`) is data, so it stays at the repo root.

| Command                      | Source script                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `eval promote`               | `scripts/eval/promotion-eval.ts` (+ `promotion-eval-verdict.ts`)                            |
| `eval gauntlet`              | `scripts/eval/gauntlet/run.ts` (+ harness/schema/regression/metamorphic/holdout as modules) |
| `eval ledger append`         | `scripts/eval/ledger-append.ts`                                                             |
| `eval capability-manifest`   | `scripts/eval/gen-capability-manifest.ts`                                                   |
| `eval oa-resolver`           | `scripts/eval/oa-resolver-eval.ts`                                                          |
| `eval error-analysis`        | `scripts/eval/eval-error-analysis.ts` (night-shift skill repoints)                          |
| `eval preset-compare`        | `scripts/eval/demo-preset-compare.ts` (eval-model skill repoints)                           |
| `eval mask-regression`       | `scripts/eval/mask-regression-check.ts`                                                     |
| `eval es-postcode-centroids` | `scripts/eval/overture-es-postcode-centroids.ts` (RELEASING.md repoints)                    |

**Probe triage (the ~100-file long tail):** a script gets a command if CI, a skill, RELEASING.md, or another surviving script references it. Every other probe moves to the gitignored `scripts/diagnostic/`, and git history keeps tracked probes at their old paths. `scripts/eval/record-matcher/` (train-gbt + learned-scorer evals) moves to `registry/tools/` in the registry phase, as the drawer spec originally intended. Python eval scripts (`fit-*.py`, `calibration-drift-guard.py`) are exempt because they are Python.

### `mailwoman registry` (single command → group; existing `registry.tsx` moves to `commands/registry/run.tsx` with `isDefault: true`, so bare `mailwoman registry` behaves exactly as today)

| Command                           | Source                                                         | Logic             |
| --------------------------------- | -------------------------------------------------------------- | ----------------- |
| `registry dedup-ceiling`          | `registry/tools/dedup-ceiling.ts`                              | in place          |
| `registry gold-set-sample`        | `registry/tools/gold-set-sample.ts`                            | in place          |
| `registry matcher-scale`          | `registry/tools/matcher-scale.ts`                              | in place          |
| `registry convert tx-hhsc`        | `registry/tools/txhhsc-to-oarow.ts`                            | in place          |
| `registry viz <figure>`           | `registry/tools/viz/*` (figure enum)                           | in place          |
| `registry train-scorer <variant>` | `scripts/eval/record-matcher/train-*.ts`                       | `registry/tools/` |
| `registry scorer-eval <kind>`     | `scripts/eval/record-matcher/learned-scorer-*.ts` + benchmarks | `registry/tools/` |

### `mailwoman tiger` (existing group, gains)

| Command               | Source                         | Notes                                               |
| --------------------- | ------------------------------ | --------------------------------------------------- |
| `tiger race-dots`     | `tiger/tools/race-dots.ts`     |                                                     |
| `tiger race-dots-map` | `tiger/tools/race-dots-map.ts` | `--serve` flag absorbs `tiger/tools/serve-range.ts` |

**Latent bug fixed here:** `mailwoman/package.json` lacks a `@mailwoman/tiger` dependency even though `commands/tiger/` exists. Add the dependency.

### `mailwoman placer` (new group)

Logic stays in `core/coarse-placer/tools/`. The namespace is `placer`, a short domain noun that matches the existing style. Its help text says "coarse placer (#244)".

| Command                                                    | Source                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `placer train`                                             | `train.ts`                                                                                                                                     |
| `placer eval [--openset\|--latin-offmap\|--quant-compare]` | `eval.ts`, `eval-openset.ts`, `eval-latin-offmap.ts`, `eval-quant-compare.ts` (one command, mode flags — they share the dataset/model loading) |
| `placer quantize`                                          | `quantize.ts`                                                                                                                                  |
| `placer build-dataset [--outliers <kind>]`                 | `build-dataset.ts`, `build-outlier-{exposure,latin,oa}.ts`                                                                                     |
| `placer probe-frontier`                                    | `probe-frontier.ts`                                                                                                                            |

### `mailwoman gazetteer` (existing group, absorbs the WOF bins)

| Command                            | Source                                              | Notes                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gazetteer build fts`              | `resolver-wof-sqlite/build-fts-cli.ts`              | wraps `buildPlaceSearchFTS` (module in place); variadic DB args + `--drop`                                                                    |
| `gazetteer build coincident-roles` | `resolver-wof-sqlite/build-coincident-roles-cli.ts` | wraps `buildCoincidentRoles`; `--no-drop` tri-state                                                                                           |
| — (exists)                         | `resolver-wof-sqlite/build-candidate-cli.ts`        | `gazetteer build candidate` already shipped — bin deleted                                                                                     |
| — (none)                           | `resolver-wof-sqlite/build-slim-cli.ts`             | deprecated: no command; bin deleted; demo-assets plugin's slim leg (`docs/plugins/demo-assets/resolve.ts:405-440`) removed in the same change |

All four `bin` entries leave `resolver-wof-sqlite/package.json`. `build-fts-cli.test.ts` retargets either the module API (`buildPlaceSearchFTS`) or the new command's run function. The operator accepted that this breaks the published package. Verify that `mailwoman` declares the `@mailwoman/resolver-wof-sqlite` dependency the gazetteer commands need, since today it may arrive only transitively.

## 2. What stays, deliberately

- **Release tooling** (`scripts/copy-weights.ts`, `publish-workspace.ts`, `publish-release-to-hf.ts`, `bless-package.ts`, `check-release-parity.ts`, `rewrite-workspace-imports.ts`, `verify-*`, `smoke-*`, `publish-demo-assets-to-r2.py`) stays because release-it and CI run it headless.
- **The 3 lookup bins** keep lean `parseArgs` under a documented policy: _standalone published micro-packages do not take the Ink/Pastel dependency; `node:util` parseArgs is their standard._
- **`scripts/diagnostic/`** stays gitignored and now also receives the triaged probes.
- **corpus-python** stays Python. `train_with_resume.ts` keeps its documented `cliArguments` passthrough.

**Deletions:** `docs/scripts/build-demo-assets.ts` (self-deprecated), `scripts/generate.ts` (dead WOF port), `corpus/scripts/run-corpus-build.ts` (a duplicate of `corpus run`, to be verified first), and the stale `RELEASING.md` reference to `build-candidate-geonames-aliases.ts`.

## 3. The dedupe program (2026-07-09 survey; counts = in-scope call sites)

New core helpers follow the acronym-casing convention (`readJSONL` rather than `readJsonl`) so they do not add to the #875 debt. Phase 0 lands the core helpers, and later phases adopt them as each script migrates. **Untouched scripts are not rewritten in one pass.** A script is deduplicated when it migrates, and probes headed for `diagnostic/` are not rewritten.

| #   | Concern                                                       | Sites                     | Destination                                                                                        |
| --- | ------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | JSONL read/write/iterate (`split("\n")` + `JSON.parse` idiom) | ~88 files                 | `core/utils`: `readJSONL`/`writeJSONL`/`iterateJSONL`                                              |
| 2   | `percentile`/`median`/`quantile` + `formatPercent`            | ~15 + ~40                 | `core/utils` stats module                                                                          |
| 3   | `sha256OfFile` clones                                         | ~12                       | `core/utils`: `sha256File()`                                                                       |
| 4   | `downloadToFile` + `isTransientStatus` + MANIFEST read/write  | ~9 files each, same files | `corpus/tools/fetch/shared.ts` (owning package — corpus-fetch-specific shape)                      |
| 5   | local `mulberry32`/`shuffle` re-rolls                         | 4                         | delete; use `SeededRandom` (`core/utils`, exists)                                                  |
| 6   | hardcoded `$MAILWOMAN_DATA_ROOT`/`/data` literals             | ~13                       | `dataRootPath()` (exists) — excludes `build-transliteration-extract`'s deliberate rewrite prefixes |
| 7   | coarse-placer FNV-1a `hash`                                   | 4                         | `core/coarse-placer/tools/shared.ts`                                                               |

**Deliberately left:** byte-size formatting (1 file), CSV parsing (`ingest-csv`'s parser is deliberate), exec wrappers (three styles without a shared shape), padEnd table grids (37 bespoke), and progress ticks (bespoke phrasing).

## 4. cli-kit: the framework layer (and the `sdk` correction)

- `mailwoman/sdk/cli.ts` → **`mailwoman/cli-kit/`**. It gains the shared pieces the migration standardizes on:
  - `useCommandTask<T>(task) → {status, result, error}` is one hook that replaces the copy-pasted `useEffect`/`useState`/`setImmediate(process.exit)` sequence in every command. It sets exit codes (error → 1) and supports result-driven codes.
  - `<CheckList checks>` is the ✓/✗ + PASS/FAIL renderer, extracted from the `gazetteer/verify.tsx` pattern.
  - The existing `CommandComponent`/`PositionalCommandComponent` types move with it.
- `mailwoman/sdk/test/` → **`mailwoman/test-kit/`**.
- `./sdk/cli` and `./sdk/test` are published subpath exports (5.x). They become **deprecated re-export shims** that point at the new modules and are removed at the next major, together with the #875 batch. The new subpaths `./cli-kit` and `./test-kit` are added to **both** exports maps (dev `node→.ts` and `publishConfig.exports`).
- `sdk` submodules go back to meaning data acquisition only. Add one line to AGENTS.md that says so.

Commands remain compiled TSX. Tool modules in owning workspaces remain plain `.ts` that node runs directly during development. A tool module exposes `export async function run(options: X, report?: (line: string) => void): Promise<Result>`. It does not read argv or call `process.exit`, and it throws on failure. The command owns argv parsing (zod), rendering, and exit codes. This separation lets tools be tested without Ink.

## 5. Phasing (one PR each, sequenced)

| Phase | Contents                                                                                           | Check                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | core dedupe helpers (§3 #1–3) + cli-kit/test-kit move with shims + `useCommandTask`/`CheckList`    | unit tests for new helpers; `yarn compile`; existing commands still run                                                                |
| 1     | corpus: tools modules + commands + fetch shared util (§3 #4) + corpus-tools absorption + deletions | each command `--help` + one real invocation per command (dry-run flags where network-bound); `corpus/scripts/` empty                   |
| 2     | `mailwoman dev` namespace (codex/core/corpus/dev-tools)                                            | codegen output byte-identical vs old scripts on same inputs                                                                            |
| 3     | WOF bin absorption + demo-assets slim-leg removal + bin deletions                                  | resolver-wof-sqlite tests; **demo production smoke green**; `mailwoman gazetteer build fts` parity vs old bin on a fixture DB          |
| 4     | registry/tiger/placer groups + record-matcher scripts → registry/tools + tiger dep fix             | `--help` smokes; one figure render; placer eval parity on cached dataset                                                               |
| 5     | eval: eval-harness module extraction + commands + probe triage → diagnostic/                       | **promotion-eval + gauntlet before/after parity: identical exit codes + artifacts on the same model**; RELEASING.md + skills repointed |

Phase 5 runs last because a release requires these checks to pass, and nothing else should change while they move. Phases 1, 2, and 4 are independent of each other once phase 0 lands.

## 6. Risks + interfaces

- **Check parity is the strictest interface.** `eval promote` and `eval gauntlet` must reproduce the old scripts' exit codes, the stdout verdict lines the operator reads, and the artifact paths, including the ledger append command printed on a pass. Run old and new on the same model before deleting the old scripts.
- **Reference repoints** (listed in each phase's plan): RELEASING.md, `.agents/skills/{mailwoman-release,wof-build,night-shift,eval-model}`, `.pi/prompts/release-check.md`, root `package.json` scripts (`ci:smoke` untouched), and workflows.
- **Published-surface changes:** resolver-wof-sqlite loses 4 bins, which is a breaking change the operator accepted. `mailwoman` keeps `./sdk/*` as shims. `mailwoman` gains the `@mailwoman/tiger` dependency and possibly resolver-wof-sqlite. Check that publish weight does not grow, since these dependencies are already in the workspace tree.
- **Pastel flag-prop caveat** (AGENTS.md): kebab flags bind to lowercase-acronym props (`--resolve-db` → `resolveDB`). Schema keys must match Pastel's derivation. Keep the existing exception note.
- **Compile requirement:** new commands run only through the compiled CLI (`node mailwoman/out/cli.js`). During development, tool logic still runs under plain node through the tool modules.

## 7. Success metrics

- [ ] `corpus/scripts/` deleted; corpus logic lives in `corpus/tools/` behind `mailwoman corpus …`
- [ ] `scripts/` top level = release tooling + configs only (codegen/lint gone to `mailwoman dev`)
- [ ] `scripts/eval/` holds only Python calibration scripts and the `checks` data eval-harness reads, or is empty if those move directly; probes live in `diagnostic/`
- [ ] `registry/tools/`, `tiger/tools/`, `core/coarse-placer/tools/` all reachable via commands
- [ ] resolver-wof-sqlite has zero `bin` entries; demo smoke green
- [ ] `mailwoman/sdk/` gone (shims at old subpaths); `sdk` = data acquisition everywhere
- [ ] Every command uses `useCommandTask`/cli-kit, and no command carries a copy-pasted runner
- [ ] Dedupe table §3 executed for all migrated code; survey re-run shows no new duplicates in migrated trees
- [ ] `yarn lint`, `yarn compile`, full test suite, promotion-eval + gauntlet parity, demo smoke — all green at each phase boundary
