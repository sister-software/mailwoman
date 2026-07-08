# UNFUCK_SCRIPTS.md — Triaging the scripts drawer to zero

**Date:** 2026-07-07 · **Status:** APPROVED as amended (operator: "you've got the helm")
**Standardization addendum (PR #1033):** the argv/env cleanup the migration left behind is DONE —
57 local-helper/inline-scan files → `parseArgs` (codemod v2), the 4 gitignored diagnostic files with
broken cli-args imports fixed (`rg` respects .gitignore — always recount with `--no-ignore`),
promotion-gate converted STRICT with exit-2 parity, photon/libpostal/nominatim dispatch →
positionals, smoke-resolve's hardcoded playpen path → `dataRootPath`. Deliberately NOT converted:
the lookup CLIs' documented negative-coordinate hand-parse and the resolver build CLIs' structured
tested parsers — neither is the scan anti-pattern.

**Amendments at approval:** Phase 0 is COMPLETE (PRs #1027/#1028/#1030/#1031 — see
`project-gazetteer-cli-sealed-artifacts`); Phase 2 lands as **module files in `core/coarse-placer/`**
(not Ink commands); Phase 3 lands as **`registry/tools/` modules** (commands are a later nicety).
**Driver:** Operator directive: "the scripts directory keeps turning into a kitchen junk drawer … I don't want the scripts directory to exist anymore eventually."
**Prior art:** `docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md` (the gazetteer builder half — approved, pre-implementation)

---

## The current state (hard numbers)

```
scripts/ — 294 files total (272 source files)
├── eval/              168 files (166 tracked, 2 gitignored)   — eval harness + probes
├── diagnostic/         55 files (9 tracked, 46 gitignored)    — one-off investigations
├── record-matcher/     22 files                                — learned-scorer + viz
├── coarse-placer/      11 files                                — model training
├── modal/               2 files                                — remote training launcher
├── lib/                 4 files (cli-args, python-json, python-random, zip-csv)
├── census/              3 files                                — race-dot map builder
├── data/                1 JSON                                 — county population
└── top-level           16 files                                — release tooling, codegen, lint, configs
```

**Duplication highlight reel:**

| Anti-pattern                                      | Count                                 | Fix                                                                  |
| ------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- |
| `process.argv` indexed/scanned directly           | 69 scripts                            | `parseArgs` from `node:util` (already used by 71)                    |
| `scripts/lib/cli-args` helper                     | 45 imports                            | retire; `parseArgs` is the standard                                  |
| `readFileSync`/`writeFileSync`/`mkdirSync` ad-hoc | 140/108/26                            | fine for one-offs; flag when it's reimplementing `fs/promises` badly |
| `$public`/`$private` env access                   | 12 scripts                            | correct pattern; 200+ scripts ignore it entirely                     |
| `.mjs` references in docstrings/comments          | 11 scripts                            | stale — AGENTS.md bans `.mjs`                                        |
| lone surviving `.mjs`                             | 1 (`diagnostic/gate-nl-postcode.mjs`) | convert or delete                                                    |

---

## The endgame: scripts/ holds ONLY three things

1. **Release-it hooks + CI tooling** — the publish/verify/smoke scripts that the release pipeline invokes
2. **The eval harness** — `eval/` (promotion gate, gauntlet, gates, probes) and `diagnostic/` (one-offs)
3. **Minimal codegen/lint** — the generate-_/lint-_ scripts that don't yet have a `mailwoman dev` home

Everything else either moves into a package (as a module), becomes an Ink command (`mailwoman <group> <verb>`), or gets deleted because it's stale/duplicated/superseded.

---

## Full inventory with disposition

### ▸ Phase 0 — Already covered by the gazetteer-CLI spec (do not duplicate)

These are addressed in `docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md`. The spec is approved; implementation is pending (3 PRs). The items below are listed for completeness — their fate is already decided.

| Script(s)                                                                                                                                                                                                                                                                                                                                                                                   | Fate                                                      | Details                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Gazetter builders (build-unified-wof, add-region-abbrevs, add-ancestors, backfill-ancestors-from-hierarchy, augment-admin-_, build-admin-geonames-fold, build-coverage-expansion, backfill-postcode-centroids, fill-zcta-centroids, build-postcode-locality_, build-postalcode-nl-pc6, audit-po-box-cedex-shard, build-supplemental-gazetteer, build-pilot-anchor-lookup, reverse-eu-panel) | **Migrate → `mailwoman/gazetteer-pipeline/`** then delete | Subsumed by `mailwoman gazetteer build [admin\|candidate\|postcode\|polygons]`. See spec §5. |
| `wof-build-manifest.json`                                                                                                                                                                                                                                                                                                                                                                   | Becomes auto-appended build log                           | Written by the command, not a recipe store.                                                  |
| `scripts/data/county-population-ranked.json`                                                                                                                                                                                                                                                                                                                                                | Moves into the pipeline module as a constant or data file |                                                                                              |

### ▸ Phase 1 — The `lib/` dissolution (low-hanging fruit, highest duplication payoff)

| File                           | Fate                                                                          | Rationale                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib/cli-args.ts`      | **Delete** after migrating all 45 callers to `node:util` `parseArgs`          | The file itself _admits_ it should not exist: "For NEW scripts with a real flag schema, prefer `node:util`'s `parseArgs`." 71 scripts already use `parseArgs`; the 45 `cli-args` users are the laggards. Convert them. |
| `scripts/lib/python-json.ts`   | **Move to `@mailwoman/core/utils`** (as `pythonJson.ts` or `pythonCompat.ts`) | 7 eval scripts import it. It's a thin compat layer (`json.dumps` → `JSON.stringify` etc). Belongs in core where eval scripts can import it normally.                                                                   |
| `scripts/lib/python-random.ts` | **Move to `@mailwoman/core/utils`** alongside python-json                     | Same pattern. 3 imports.                                                                                                                                                                                               |
| `scripts/lib/zip-csv.ts`       | **Move to `@mailwoman/core/utils`** (or the corpus tools module if it exists) | Streams a ZIP entry as CSV rows. 3 imports. Reusable enough for core.                                                                                                                                                  |

**Phase 1 delivers:** `scripts/lib/` → zero files. All 45 `cli-args` users converted to `parseArgs`. The 3 utility modules find proper homes in core.

### ▸ Phase 2 — The coarse-placer (should never have been in scripts/)

The #244 coarse-placer is a real model with a training pipeline. It has no business in a scripts drawer.

| File                                      | Fate                                                                          | Rationale                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `coarse-placer/train.ts`                  | **Move to `@mailwoman/core/coarse-placer/`** (as `train.ts` or a CLI command) | Trains the multinomial logistic regression. Imported by no other script — standalone entry point. |
| `coarse-placer/eval.ts`                   | **Move to `@mailwoman/core/coarse-placer/`** (as `eval.ts`)                   | Evaluation.                                                                                       |
| `coarse-placer/quantize.ts`               | **Move to `@mailwoman/core/coarse-placer/`**                                  | Int8 quantization.                                                                                |
| `coarse-placer/build-dataset.ts`          | **Move to `@mailwoman/core/coarse-placer/`**                                  | Dataset assembly.                                                                                 |
| `coarse-placer/build-outlier-exposure.ts` | **Move to `@mailwoman/core/coarse-placer/`**                                  | Outlier exposure set builder.                                                                     |
| `coarse-placer/build-outlier-latin.ts`    | **Move to `@mailwoman/core/coarse-placer/`**                                  | Latin-script outliers.                                                                            |
| `coarse-placer/build-outlier-oa.ts`       | **Move to `@mailwoman/core/coarse-placer/`**                                  | OpenAddresses outliers.                                                                           |
| `coarse-placer/eval-latin-offmap.ts`      | **Move to `@mailwoman/core/coarse-placer/`**                                  | Off-map eval.                                                                                     |
| `coarse-placer/eval-openset.ts`           | **Move to `@mailwoman/core/coarse-placer/`**                                  | Open-set eval.                                                                                    |
| `coarse-placer/eval-quant-compare.ts`     | **Move to `@mailwoman/core/coarse-placer/`**                                  | Quant comparison.                                                                                 |
| `coarse-placer/probe-frontier.ts`         | **Move to `@mailwoman/core/coarse-placer/`**                                  | Frontier probe.                                                                                   |

All 11 files are tightly coupled to the coarse-placer model. `@mailwoman/core` already exports `CoarsePlacer` from `core/coarse-placer/` — the training/eval scripts belong alongside it. Alternatively, make `mailwoman coarse-placer train` and `mailwoman coarse-placer eval` Ink commands. **Decision needed:** package module vs Ink command — either is fine; the key is "not in scripts/".

### ▸ Phase 3 — Record-matcher (wrong home entirely)

22 files for training, evaluating, and visualizing the learned-scorer model for entity resolution. This belongs in the `registry/` workspace or the `match/` workspace — the two packages that actually do record matching.

| File                                               | Fate                                                                           | Rationale                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `record-matcher/train-gbt.ts`                      | **Move to `registry/`** (as a module behind `mailwoman registry train-scorer`) | Trains the production GBT model, writes output into `registry/models/`. Already imports from `@mailwoman/match` and `@mailwoman/record`. |
| `record-matcher/train-cross-gbt.ts`                | **Move to `registry/`**                                                        | Cross-state variant.                                                                                                                     |
| `record-matcher/train-org-cross-gbt.ts`            | **Move to `registry/`**                                                        | Organization cross-state variant.                                                                                                        |
| `record-matcher/learned-scorer-eval.ts`            | **Move to `registry/`**                                                        | Evaluation of the learned scorer.                                                                                                        |
| `record-matcher/learned-scorer-clustering-eval.ts` | **Move to `registry/`**                                                        | Clustering A/B eval.                                                                                                                     |
| `record-matcher/learned-scorer-crossstate-eval.ts` | **Move to `registry/`**                                                        | Cross-state eval.                                                                                                                        |
| `record-matcher/dedup-ceiling.ts`                  | **Move to `registry/`**                                                        | Dedup upper-bound analysis.                                                                                                              |
| `record-matcher/nppes-dedup-benchmark.ts`          | **Move to `registry/`**                                                        | NPPES benchmark.                                                                                                                         |
| `record-matcher/matcher-scale.ts`                  | **Move to `registry/`**                                                        | Scale testing.                                                                                                                           |
| `record-matcher/gold-set-sample.ts`                | **Move to `registry/`**                                                        | Gold set sampling.                                                                                                                       |
| `record-matcher/coverage-reconciliation.ts`        | **Move to `registry/`**                                                        | Coverage reconciliation.                                                                                                                 |
| `record-matcher/cross-dataset-correlation.ts`      | **Move to `registry/`**                                                        | Cross-dataset correlation.                                                                                                               |
| `record-matcher/cross-source-threshold-sweep.ts`   | **Move to `registry/`**                                                        | Threshold sweep.                                                                                                                         |
| `record-matcher/geocoder-namesake-probe.ts`        | **Move to `registry/`**                                                        | Namesake probe.                                                                                                                          |
| `record-matcher/geocoder-vs-provided-coords.ts`    | **Move to `registry/`**                                                        | Coordinator comparison.                                                                                                                  |
| `record-matcher/txhhsc-to-oarow.ts`                | **Move to `registry/`**                                                        | Texas HHS → OAROW conversion.                                                                                                            |
| `record-matcher/viz/*` (6 files)                   | **Move to `registry/`**                                                        | Map renderers, yardstick figures.                                                                                                        |

**Phase 3 delivers:** `scripts/record-matcher/` → zero files. The `registry/` workspace gains a proper `scripts/` or `tools/` subdirectory, or (better) these become `mailwoman registry <verb>` Ink commands.

### ▸ Phase 4 — Census → `tiger/` or a command

Three files that extend the TIGER pipeline. They directly depend on `@mailwoman/tiger` and the TIGER DB. They belong with tiger.

| File                      | Fate                                                                                                             | Rationale                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `census/race-dots.ts`     | **Move to `tiger/` workspace** (as a `tools/` or `scripts/` subdir behind a `mailwoman tiger race-dots` command) | Race-dot density map builder. Already imports from `@mailwoman/tiger`.                                             |
| `census/race-dots-map.ts` | **Move to `tiger/`**                                                                                             | Map renderer companion.                                                                                            |
| `census/serve-range.ts`   | **Move to `tiger/`** or delete                                                                                   | Minimal HTTP Range server for PMTiles. 50-line utility; could be replaced by `npx serve` or a small tiger utility. |

### ▸ Phase 5 — Modal (stays, but not in scripts/ long-term)

| File                    | Fate                                                                    | Rationale                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `modal/train_remote.py` | **Move to `corpus-python/`** (the Python corpus package)                | It's a Modal training script for the Python training pipeline. Belongs with the Python code, not in the TS scripts drawer. |
| `modal/AGENTS.md`       | **Move to `corpus-python/docs/`** (or inline in train_remote.py header) | Runbook for the training flow.                                                                                             |

`scripts/modal/` → zero files. The `corpus-python/` package already exists and is where Python training code lives.

### ▸ Phase 6 — Codegen & lint (stays for now, candidates for `mailwoman dev`)

These are tooling scripts — not builders, not eval, not release. They belong in `scripts/` until there's a `mailwoman dev` command namespace to absorb them.

| File                             | Fate                                                                | Rationale                                                    |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `generate-country-reference.ts`  | **Stay**, candidate for `mailwoman dev generate-country-reference`  | Codegen from upstream sources.                               |
| `generate-language-types.ts`     | **Stay**, candidate for `mailwoman dev generate-language-types`     | Generates TypeScript types from CLDR data.                   |
| `generate-official-languages.ts` | **Stay**, candidate for `mailwoman dev generate-official-languages` | Official languages codegen.                                  |
| `generate-trace-fixture.ts`      | **Stay**, candidate for `mailwoman dev generate-trace-fixture`      | Trace fixture generator. Uses `parseArgs` correctly already. |
| `generate.ts`                    | **Stay**                                                            | Unknown purpose — evaluate during Phase 6. May be dead.      |
| `jsonl-to-parquet.ts`            | **Stay**, candidate for `mailwoman dev jsonl-to-parquet`            | Simple conversion utility.                                   |
| `lint-corpus-shard.ts`           | **Stay**, candidate for `mailwoman corpus lint`                     | Corpus shard linter — should live with corpus commands.      |
| `lint-mdx-angles.ts`             | **Stay**, candidate for `mailwoman dev lint-mdx`                    | MDX angle-bracket linter.                                    |
| `lint-shard-vocab.ts`            | **Stay**, candidate for `mailwoman corpus lint-vocab`               | Shard vocabulary linter.                                     |
| `lint-rules.json`                | **Stay**                                                            | The rules config for lint-corpus-shard. Moves with it.       |

### ▸ Phase 7 — Release tooling (legitimate permanent residents)

These are invoked by `.release-it.json` hooks, CI, or the operator at release time. They stay in `scripts/` — this is the one category that genuinely belongs there.

| File                                   | Fate                                | Rationale                                                                                                  |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `copy-weights.ts`                      | **Stay**                            | `.release-it.json` `before:init` hook. Materializes model binaries into weights workspaces.                |
| `publish-workspace.ts`                 | **Stay**                            | Invoked by `@release-it-plugins/workspaces` per workspace. Pack → publish with symlink deref + provenance. |
| `publish-release-to-hf.ts`             | **Stay**                            | Hugging Face release companion.                                                                            |
| `publish-demo-assets-to-r2.py`         | **Stay** (convert to TS eventually) | Demo asset upload. Only remaining `.py` in release path.                                                   |
| `bless-package.ts`                     | **Stay**                            | Validates a workspace's `package.json` before publish.                                                     |
| `check-release-parity.ts`              | **Stay**                            | Verifies all workspace versions match the release tag.                                                     |
| `rewrite-workspace-imports.ts`         | **Stay**                            | Post-release import rewriting.                                                                             |
| `release-workspace-repository.test.ts` | **Stay**                            | Test for the release flow.                                                                                 |
| `verify-shard-acks.ts`                 | **Stay**                            | Verifies shard acknowledgements.                                                                           |
| `verify-export-quant-versions.ts`      | **Stay**                            | Verifies quantized model version exports.                                                                  |
| `smoke-clean-install.ts`               | **Stay**                            | CI smoke test — clean install from npm.                                                                    |
| `smoke-resolve.ts`                     | **Stay**                            | CI smoke test — resolution check.                                                                          |

### ▸ Phase 8 — Config & docs files (staying)

| File                            | Fate                                        | Rationale                                                                                   |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `AGENTS.md`                     | **Stay**                                    | Agent instructions for the scripts directory. Update to reflect the new slimmed-down world. |
| `CLAUDE.md`                     | **Stay** (symlink to AGENTS.md)             | Already just `@AGENTS.md`.                                                                  |
| `tsconfig.json`                 | **Stay**                                    | TypeScript config for `yarn typecheck:scripts`.                                             |
| `v062-model-card-template.json` | **Stay** or move to `neural-weights-en-us/` | Model card template. Belongs with the model metadata, not scripts.                          |
| `lint-rules.json`               | **Stay** (moves with lint-corpus-shard.ts)  | See Phase 6.                                                                                |

### ▸ Phase 9 — Eval harness (legitimate permanent resident)

The 166 tracked files in `scripts/eval/` (plus the 2 gitignored), plus the 55 diagnostic scripts in `scripts/diagnostic/` (46 gitignored, 9 tracked). These are the eval/diagnostic harness — the promotion gate, the gauntlet, per-tag probes, calibration scripts, golden-set builders, and one-off investigation scripts.

**Disposition: stay as-is.** These are by design — ad-hoc evaluation probes and diagnostic investigations that don't belong in a package. The distinction between `eval/` and `diagnostic/` is already fuzzy (diagnostic is gitignored; eval has many tracked probes that read like diagnostics). Consider consolidating: `eval/` for the _gates_ (promotion-gate, gauntlet, gates/) and `diagnostic/` for everything else — but that's cleanup, not migration.

**One cleanup task:** 2 files in `eval/` are gitignored (residual probes). Ensure the gitignore is correct and nothing tracked should be gitignored or vice versa.

### ▸ Phase 10 — The lone `.mjs` and stale references

| File                                                                                   | Fate                           | Rationale                                                    |
| -------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `scripts/diagnostic/gate-nl-postcode.mjs`                                              | **Convert to `.ts` or delete** | The ONLY surviving `.mjs`. AGENTS.md explicitly bans `.mjs`. |
| 11 `.mjs` references in docstrings/comments                                            | **Update comments**            | Stale references to scripts that no longer exist as `.mjs`.  |
| `scripts/lib/zip-csv.ts:15` references `ingest-openaddresses.mjs`                      | **Fix during Phase 1**         | Stale reference.                                             |
| `scripts/eval/audit-po-box-cedex-shard.ts:8` references `build-po-box-cedex-shard.mjs` | **Fix during Phase 0**         | Handled by gazetteer spec.                                   |

---

## The framework: where things BELONG

```
mailwoman/
  commands/          ← Ink commands (parse, geocode, gazetteer build, registry train-scorer, ...)
  gazetteer-pipeline/ ← builder logic extracted from scripts (Phase 0 per existing spec)

@mailwoman/core/
  coarse-placer/     ← training + eval scripts for the coarse-placer model (Phase 2)
  utils/             ← python-json, python-random, zip-csv (Phase 1)

@mailwoman/registry/  (or @mailwoman/match/)
  tools/             ← record-matcher training + eval + viz (Phase 3)

@mailwoman/tiger/
  tools/             ← census race-dots + serve-range (Phase 4)

corpus-python/
  modal/             ← train_remote.py + AGENTS.md (Phase 5)

scripts/             ← what remains:
  eval/              ← promotion gate, gauntlet, gates, eval probes (Phase 9)
  diagnostic/        ← one-off investigations (Phase 9)
  *.ts               ← release tooling (Phase 7)
  *.ts               ← codegen/lint (Phase 6)
  tsconfig.json, AGENTS.md, CLAUDE.md  ← config (Phase 8)
```

---

## The `parseArgs` standard (kill `cli-args.ts`)

The `scripts/lib/cli-args.ts` file provides three functions (`arg`, `numArg`, `flag`) that scan `process.argv` with `indexOf`. 45 scripts import it. 71 scripts already use `node:util`'s `parseArgs` instead. The file's OWN DOCSTRING says to prefer `parseArgs`.

**The conversion pattern:**

```typescript
// BEFORE (cli-args.ts)
import { arg, numArg, flag } from "../lib/cli-args.js"
const model = arg("model", "default.onnx")
const n = numArg("n", 100)
const verbose = flag("verbose")

// AFTER (parseArgs)
import { parseArgs } from "node:util"
const { values } = parseArgs({
	options: {
		model: { type: "string", default: "default.onnx" },
		n: { type: "string", default: "100" }, // parseArgs has no "number" type; coerce
		verbose: { type: "boolean", default: false },
	},
})
const model = values.model!
const n = Number(values.n!)
const verbose = values.verbose!
```

**Migration order:** convert the 45 `cli-args` importers → verify `yarn typecheck:scripts` passes → delete `lib/cli-args.ts`.

---

## The env-var standard (use `$public` / `$private`)

200+ scripts use ad-hoc `process.env.X` or bare `process.env` access. 12 scripts already correctly use `$public` / `$private` from `@mailwoman/core/env`.

Not all 200 need conversion (many are one-off probes where ad-hoc env is fine), but any script that ships or gates a release MUST use the typed env accessors. At minimum, ensure the release-tooling and promotion-gate scripts use them.

---

## Sequencing (execution order)

| Phase  | What                                                             | Effort        | Risk                          | Dependency                         |
| ------ | ---------------------------------------------------------------- | ------------- | ----------------------------- | ---------------------------------- |
| **0**  | Gazetteer builders → pipeline + CLI                              | Large (3 PRs) | Medium (data correctness)     | Already spec'd, pre-implementation |
| **1**  | `lib/` dissolution + `parseArgs` migration                       | Small         | Low                           | None                               |
| **2**  | Coarse-placer → `@mailwoman/core`                                | Small         | Low                           | None                               |
| **3**  | Record-matcher → `registry/`                                     | Medium        | Low                           | None                               |
| **4**  | Census → `tiger/`                                                | Tiny          | Low                           | None                               |
| **5**  | Modal → `corpus-python/`                                         | Tiny          | Low                           | None                               |
| **6**  | Codegen/lint → decide on `mailwoman dev` namespace               | LATER         | Low                           | None (these stay until Phase 6)    |
| **7**  | Release tooling audit (ensure `$public`/`$private`, `parseArgs`) | Tiny          | Medium (don't break releases) | None                               |
| **8**  | Config/docs cleanup                                              | Tiny          | None                          | After Phase 1-5                    |
| **9**  | Eval/diagnostic audit (consolidation, gitignore correctness)     | Small         | None                          | Anytime                            |
| **10** | `.mjs` extermination                                             | Tiny          | None                          | Anytime                            |

Phases 1, 2, 4, 5, 10 can run in parallel — they touch disjoint file sets. Phase 3 can run independently. Phase 0 is the heavy lift (already spec'd). Phase 7 must come last (don't break release while moving other things).

---

## Success metrics

- [x] `scripts/lib/` is empty and deleted
- [x] Zero imports of `scripts/lib/cli-args` anywhere
- [x] Zero `.mjs` files in `scripts/`
- [x] `scripts/coarse-placer/` → empty, code lives in `@mailwoman/core`
- [x] `scripts/record-matcher/` → empty, code lives in `registry/`
- [x] `scripts/census/` → empty, code lives in `tiger/`
- [x] `scripts/modal/` → empty, code lives in `corpus-python/`
- [x] `scripts/data/` → empty
- [x] `scripts/eval/` and `scripts/diagnostic/` remain (legitimate permanent residents)
- [x] Release tooling scripts still work (verified by dry-run publish)
- [x] `yarn typecheck:scripts` passes
- [x] `scripts/AGENTS.md` updated to describe the slimmed-down reality
- [x] `scripts/` contains ≤ 20 top-level files (down from 16 now, after removing the builder/modal stubs)
- [x] `scripts/` top-level contains ONLY: release tooling, codegen/lint, config files, and the two eval/diagnostic subdirectories
- [x] No file imports anything from `../lib/` or `./lib/`
