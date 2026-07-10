# Scripts → Pastel commands: the framework-consistency arc

**Date:** 2026-07-09 · **Status:** SHIPPED 2026-07-10 (phases 0–5 merged to main; follow-ups: retrofit pre-existing commands onto useCommandTask, regen-churn stash, docs/scripts/build-demo-assets.ts pinned by run-docs skill)
**Driver:** Operator directive: "all our scripts live in their respective packages and there's a consistent use of the framework instead of all these horrible little scripts."
**Prior art:** `2026-07-07-scripts-drawer-to-zero.md` (executed — moved script logic into packages as modules, deferred commands as "a later nicety"; this arc is that later) and `2026-07-07-scripts-cleanup-gazetteer-cli-design.md` (the gazetteer half, shipped).

## Decisions (operator-confirmed 2026-07-09)

1. **Scope:** corpus/scripts, codegen/lint (`mailwoman dev`), registry/tiger/coarse-placer tools, AND the eval harness. Release-it hook scripts stay plain (release-it invokes them headless; a compile step in the release path buys nothing).
2. **Logic home:** the owning workspace (`corpus/tools/`, `registry/tools/`, …). Command `.tsx` files are thin wrappers in `mailwoman/commands/` (Pastel file-routing requires they live there).
3. **WOF bins:** absorb into `mailwoman gazetteer` and delete all four `resolver-wof-sqlite` bins. **Slim is deprecated — verified:** the demo runtime's `hasWOFDb` branch loads the version-independent candidate table via httpvfs (`docs/src/pages/demo/_app.tsx:431` → `WOFCandidateTableLookup`); `wof-hot.db` is never fetched. `buildSlimWOFDatabase` (the module) survives solely as the resolver-wof-wasm test-fixture builder. **Bellwether: the demo production smoke stays green.**
4. **Lookup bins (timezone/nuts/un-locode):** stay lean `parseArgs` — the sanctioned exception (consumer-facing micro-packages; ink+react+zod+commander dep weight is hostile there). Documented below as policy.
5. **Duplicated helpers** get folded into `@mailwoman/core` or the owning package as part of each phase (operator: "move them to core or their respective packages").
6. **`sdk/` naming:** `sdk` submodules mean _data acquisition_ (`ban/sdk`, `osm/sdk`, `tiger/sdk` fit; `spatial/sdk` is a borderline data-format case, left alone). `mailwoman/sdk` violates this — it holds CLI helper types + the parser test harness. Both move out (§4).

## 1. Target command tree

Every table row = one thin `.tsx` in `mailwoman/commands/…` wrapping a `run()`-style module in the listed workspace. Scripts are deleted once their command exists and references are repointed.

### `mailwoman corpus` (existing group, gains)

| Command                   | Source script                                                                                                                              | Logic lands in                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `corpus audit`            | `corpus/scripts/audit.ts`                                                                                                                  | `corpus/tools/audit.ts`                                                 |
| `corpus ingest-csv`       | `corpus/scripts/ingest-csv.ts`                                                                                                             | `corpus/tools/ingest-csv.ts`                                            |
| `corpus fetch <source>`   | `corpus/scripts/fetch-nad.ts` + `fetch-sources/*` (ban, hrsa, imls-pls, nppes, openaddresses, state-sources, state-hi-schools, tiger-full) | `corpus/tools/fetch/<source>.ts` over one shared fetch util (§3)        |
| `corpus shard kryptonite` | `corpus/scripts/build-kryptonite-shard.ts`                                                                                                 | `corpus/tools/shard-kryptonite.ts`                                      |
| `corpus shard translit`   | `corpus/scripts/build-transliteration-shard.ts`                                                                                            | `corpus/tools/shard-translit.ts`                                        |
| `corpus golden expand`    | `corpus/scripts/expand-golden.ts`                                                                                                          | `corpus/tools/golden-expand.ts`                                         |
| `corpus golden promote`   | `corpus/scripts/promote-golden.ts`                                                                                                         | `corpus/tools/golden-promote.ts`                                        |
| — (fold)                  | `corpus/scripts/run-corpus-build.ts`                                                                                                       | duplicate of existing `corpus run` (`runAdapter`) — verify, then delete |

The source enum makes `fetch` one command, not nine. Existing `mailwoman/corpus-tools/` (3 files backing align-shard/stats/overlay-manifest commands) migrates into `corpus/tools/` in the same phase so the corpus workspace owns all corpus logic — commands repoint, `mailwoman` already depends on `@mailwoman/corpus`.

### `mailwoman dev` (new group)

| Command                           | Source script                                        | Logic lands in                                                                   |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `dev generate country-reference`  | `scripts/generate-country-reference.ts`              | `codex/tools/generate-country-reference.ts`                                      |
| `dev generate official-languages` | `scripts/generate-official-languages.ts`             | `codex/tools/generate-official-languages.ts`                                     |
| `dev generate language-types`     | `scripts/generate-language-types.ts`                 | `core/tools/generate-language-types.ts` (generates core types)                   |
| `dev generate trace-fixture`      | `scripts/generate-trace-fixture.ts`                  | `mailwoman/dev-tools/` (fixture for the docs visualizer; no better owner)        |
| `dev lint corpus-shard`           | `scripts/lint-corpus-shard.ts` (+ `lint-rules.json`) | `corpus/tools/lint-shard.ts` (rules JSON moves with it)                          |
| `dev lint shard-vocab`            | `scripts/lint-shard-vocab.ts`                        | `corpus/tools/lint-shard-vocab.ts`                                               |
| `dev lint mdx-angles`             | `scripts/lint-mdx-angles.ts`                         | `mailwoman/dev-tools/` (docs tooling; docs workspace is private, can't be a dep) |
| `dev jsonl-to-parquet`            | `scripts/jsonl-to-parquet.ts`                        | `corpus/tools/jsonl-to-parquet.ts` (it writes corpus shards)                     |

### `mailwoman eval` (new group)

Logic lands in **`mailwoman/eval-harness/`** — deliberate deviation from owning-workspace: no workspace owns evals, and a private evals workspace can't be a dependency of the published CLI. Follows the `gazetteer-pipeline` precedent. Gate-threshold JSONs (`scripts/eval/gates/*.json`) and fixtures move with it; the ledger (`evals/scores-by-version.json`) stays at repo root (data, not code).

| Command                      | Source script                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `eval gate`                  | `scripts/eval/promotion-gate.ts` (+ `promotion-gate-verdict.ts`)                            |
| `eval gauntlet`              | `scripts/eval/gauntlet/run.ts` (+ harness/schema/regression/metamorphic/holdout as modules) |
| `eval ledger append`         | `scripts/eval/ledger-append.ts`                                                             |
| `eval capability-manifest`   | `scripts/eval/gen-capability-manifest.ts`                                                   |
| `eval oa-resolver`           | `scripts/eval/oa-resolver-eval.ts`                                                          |
| `eval error-analysis`        | `scripts/eval/eval-error-analysis.ts` (night-shift skill repoints)                          |
| `eval preset-compare`        | `scripts/eval/demo-preset-compare.ts` (eval-model skill repoints)                           |
| `eval mask-regression`       | `scripts/eval/mask-regression-gate.ts`                                                      |
| `eval es-postcode-centroids` | `scripts/eval/overture-es-postcode-centroids.ts` (RELEASING.md repoints)                    |

**Probe triage (the ~100-file long tail):** the rule is mechanical — a script referenced by CI, a skill, RELEASING.md, or another surviving script gets a command; every other probe moves to `scripts/diagnostic/` (the gitignored graveyard; git history preserves tracked ones at their old paths). `scripts/eval/record-matcher/` (train-gbt + learned-scorer evals) moves to `registry/tools/` with the registry phase, per the drawer spec's original intent. Python eval scripts (`fit-*.py`, `calibration-drift-guard.py`) are exempt (Python).

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

**Latent bug fixed here:** `mailwoman/package.json` has no `@mailwoman/tiger` dependency though `commands/tiger/` exists — add it.

### `mailwoman placer` (new group)

Logic stays in `core/coarse-placer/tools/`. Namespace name: `placer` (short domain noun matching the existing style; help text says "coarse placer (#244)").

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

All four `bin` entries leave `resolver-wof-sqlite/package.json`. `build-fts-cli.test.ts` retargets the module API (`buildPlaceSearchFTS`) or the new command's run-function. Breaking for the published package — accepted (operator call). Verify `mailwoman` has the `@mailwoman/resolver-wof-sqlite` dep the gazetteer commands need (today it may ride transitively).

## 2. What stays, deliberately

- **Release tooling** (`scripts/copy-weights.ts`, `publish-workspace.ts`, `publish-release-to-hf.ts`, `bless-package.ts`, `check-release-parity.ts`, `rewrite-workspace-imports.ts`, `verify-*`, `smoke-*`, `publish-demo-assets-to-r2.py`) — release-it/CI residents, headless by design.
- **The 3 lookup bins** — lean `parseArgs`, documented policy: _standalone published micro-packages do not take the Ink/Pastel dependency; `node:util` parseArgs is their standard._
- **`scripts/diagnostic/`** — the gitignored graveyard, now also receiving the triaged probes.
- **corpus-python** — Python; `train_with_resume.ts` keeps its documented `cliArguments` passthrough.

**Deletions:** `docs/scripts/build-demo-assets.ts` (self-deprecated), `scripts/generate.ts` (dead WOF port), `corpus/scripts/run-corpus-build.ts` (duplicate of `corpus run` — verify first), stale `RELEASING.md` reference to `build-candidate-geonames-aliases.ts`.

## 3. The dedupe program (2026-07-09 survey; counts = in-scope call sites)

New core helpers follow the acronym-casing convention (`readJSONL`, not `readJsonl`) so they don't join the #875 debt. Phase 0 lands the core helpers; later phases consume them as each script migrates — **no big-bang rewrite of untouched scripts**; a script's dedupe happens when it migrates (probes headed for `diagnostic/` are not rewritten).

| #   | Concern                                                       | Sites                     | Destination                                                                                      |
| --- | ------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | JSONL read/write/iterate (`split("\n")` + `JSON.parse` idiom) | ~88 files                 | `core/utils`: `readJSONL`/`writeJSONL`/`iterateJSONL`                                            |
| 2   | `percentile`/`median`/`quantile` + `formatPercent`            | ~15 + ~40                 | `core/utils` stats module                                                                        |
| 3   | `sha256OfFile` clones                                         | ~12                       | `core/utils`: `sha256File()`                                                                     |
| 4   | `downloadToFile` + `isTransientStatus` + MANIFEST read/write  | ~9 files each, same files | `corpus/tools/fetch/shared.ts` (owning package — corpus-fetch-specific shape)                    |
| 5   | local `mulberry32`/`shuffle` re-rolls                         | 4                         | delete; use `SeededRandom` (`core/utils`, exists)                                                |
| 6   | hardcoded `/mnt/playpen`/`/data` literals                     | ~13                       | `dataRootPath()` (exists) — excludes `build-transliteration-shard`'s deliberate rewrite prefixes |
| 7   | coarse-placer FNV-1a `hash`                                   | 4                         | `core/coarse-placer/tools/shared.ts`                                                             |

**Deliberately left:** byte-size formatting (1 file), CSV parsing (`ingest-csv`'s is deliberate), exec wrappers (three styles, no shared shape), padEnd table grids (37 bespoke), progress ticks (bespoke phrasing).

## 4. cli-kit: the framework layer (and the `sdk` correction)

- `mailwoman/sdk/cli.ts` → **`mailwoman/cli-kit/`**. Gains the shared pieces the migration standardizes on:
  - `useCommandTask<T>(task) → {status, result, error}` — one hook replacing the copy-pasted `useEffect`/`useState`/`setImmediate(process.exit)` dance in every command; owns exit-code discipline (error → 1, result-driven codes supported).
  - `<CheckList checks>` — the ✓/✗ + PASS/FAIL renderer (`gazetteer/verify.tsx` pattern, extracted).
  - The existing `CommandComponent`/`PositionalCommandComponent` types.
- `mailwoman/sdk/test/` → **`mailwoman/test-kit/`**.
- Both `./sdk/cli` and `./sdk/test` are published subpath exports (5.x) — they become **deprecated re-export shims** pointing at the new modules, removed at the next major (bundle with the #875 batch). New subpaths `./cli-kit`, `./test-kit` added to **both** exports maps (dev `node→.ts` and `publishConfig.exports`).
- `sdk` submodule meaning is restored: data acquisition only. Add one line to AGENTS.md saying so.

Commands remain TSX (compiled); tool modules in owning workspaces remain plain `.ts` (run directly under node during dev). A tool module's contract: `export async function run(options: X, report?: (line: string) => void): Promise<Result>` — no argv access, no `process.exit`, throw on failure. The command owns argv (zod), rendering, and exit codes. This is the isolation boundary that makes tools testable without Ink.

## 5. Phasing (one PR each, sequenced)

| Phase | Contents                                                                                           | Gate                                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | core dedupe helpers (§3 #1–3) + cli-kit/test-kit move with shims + `useCommandTask`/`CheckList`    | unit tests for new helpers; `yarn compile`; existing commands still run                                                                |
| 1     | corpus: tools modules + commands + fetch shared util (§3 #4) + corpus-tools absorption + deletions | each command `--help` + one real invocation per command (dry-run flags where network-bound); `corpus/scripts/` empty                   |
| 2     | `mailwoman dev` namespace (codex/core/corpus/dev-tools)                                            | codegen output byte-identical vs old scripts on same inputs                                                                            |
| 3     | WOF bin absorption + demo-assets slim-leg removal + bin deletions                                  | resolver-wof-sqlite tests; **demo production smoke green**; `mailwoman gazetteer build fts` parity vs old bin on a fixture DB          |
| 4     | registry/tiger/placer groups + record-matcher scripts → registry/tools + tiger dep fix             | `--help` smokes; one figure render; placer eval parity on cached dataset                                                               |
| 5     | eval: eval-harness module extraction + commands + probe triage → diagnostic/                       | **promotion-gate + gauntlet before/after parity: identical exit codes + artifacts on the same model**; RELEASING.md + skills repointed |

Phase 5 last because the gates guard releases — nothing else may wobble while they move. Phases 1/2/4 are independent after 0.

## 6. Risks + contracts

- **Gate parity is the hard contract:** `eval gate`/`eval gauntlet` must reproduce the old scripts' exit codes, stdout verdict lines consumed by the operator, and artifact paths (ledger append command printed on PASS). Run both on the same model before deleting.
- **Reference repoints** (enumerated during each phase's plan): RELEASING.md, `.agents/skills/{mailwoman-release,wof-build,night-shift,eval-model}`, `.pi/prompts/release-check.md`, root `package.json` scripts (`ci:smoke` untouched), workflows.
- **Published-surface changes:** resolver-wof-sqlite loses 4 bins (breaking, accepted); `mailwoman` `./sdk/*` shimmed not removed; `mailwoman` gains `@mailwoman/tiger` (+ possibly resolver-wof-sqlite) deps — check publish weight impact is nil (deps already in the workspace tree).
- **Pastel flag-prop caveat** (AGENTS.md): kebab flags bind lowercase-acronym props (`--resolve-db` → `resolveDb`) — schema keys must match Pastel's derivation; keep the existing exception note.
- **Compile requirement:** new commands only run via the compiled CLI (`node mailwoman/out/cli.js`) — dev loop for tool logic stays plain-node via the tool modules.

## 7. Success metrics

- [ ] `corpus/scripts/` deleted; corpus logic lives in `corpus/tools/` behind `mailwoman corpus …`
- [ ] `scripts/` top level = release tooling + configs ONLY (codegen/lint gone to `mailwoman dev`)
- [ ] `scripts/eval/` reduced to Python calibration scripts + `gates` data consumed by eval-harness — or empty if those move cleanly; probes in `diagnostic/`
- [ ] `registry/tools/`, `tiger/tools/`, `core/coarse-placer/tools/` all reachable via commands
- [ ] resolver-wof-sqlite has zero `bin` entries; demo smoke green
- [ ] `mailwoman/sdk/` gone (shims at old subpaths); `sdk` = data acquisition everywhere
- [ ] Every command uses `useCommandTask`/cli-kit; zero copy-pasted runner dances
- [ ] Dedupe table §3 executed for all migrated code; survey re-run shows no new duplicates in migrated trees
- [ ] `yarn lint`, `yarn compile`, full test suite, promotion-gate + gauntlet parity, demo smoke — all green at each phase boundary
