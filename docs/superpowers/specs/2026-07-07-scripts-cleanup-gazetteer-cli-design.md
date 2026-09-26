# Scripts cleanup: sealed data artifacts + the unified `gazetteer` pipeline CLI

**Date:** 2026-07-07 · **Status:** approved design, pre-implementation
**Driver issues:** #1015/#1021 (the rebuild ordeal), #1026 (the flattened-nodes regression), operator directive: "the scripts directory keeps turning into a kitchen junk drawer … I don't want the scripts directory to exist anymore eventually."

## Problem

Three related failures surfaced this week:

1. **Shipped artifacts are mutable.** Every SQLite DB we build is meant to be read-only, but no mechanism enforces it. Scripts like `backfill-ancestors-from-hierarchy.ts` exist to reopen a built DB read-write and patch it. The policy lives in memories and docstrings, and the filesystem does not enforce it.
2. **The recipe does not reproduce the artifact.** The live `admin-global-priority.db` accumulated state from ad-hoc augment scripts (`augment-admin-*`, `build-coverage-expansion`, …) that no recorded recipe reproduces. The #1015 full rebuild reproduced the _manifest recipe_ and so **lost the country/region nodes of ~95 countries** (#1023/#1026). A coverage-count check (rows + distinct countries) passed despite the structural regression.
3. **The build steps are scattered.** Building the admin gazetteer correctly takes one 700-line script plus four post-build steps in a specific order (`add-region-abbrevs` → `place_abbr` → `build-fts`, with `backfill-ancestors` folded in but the others not). Only RELEASING.md prose and a lagging manifest document the order. The #1015 rebuild missed two of the steps on the first pass. `mailwoman wof prepare` is a stale partial duplicate, and `mailwoman gazetteer build` builds a _different_ artifact (the candidate table). A fresh clone cannot tell which command builds which artifact.

## Goals

- **Mechanical read-only enforcement**: the OS refuses to reopen a sealed artifact read-write, and the caller gets a clear error message.
- **First-clone usefulness**: one self-documenting command namespace whose `--help` output describes the data pipeline. The canonical coverage recipe lives in code as defaults. Today it lives in a lagging manifest and in an artifact you have to reverse-engineer.
- **Recipe ≡ artifact**: a full rebuild from the recorded recipe reproduces the shipped artifact. A verify step that checks _structure_ rather than counts enforces this.
- **Endgame**: `scripts/` contains only release-it hooks, CI smoke, and the eval harness. It contains no builders and no mutators.

## Non-goals

- Fixing the #1026 data regression itself. That fix is a rebuild through the new pipeline once it exists. The issue stays open and depends on `gazetteer verify`.
- Migrating the eval harness (`scripts/eval/`, gauntlet). It stays as the third legitimate resident of `scripts/`.
- Changing any runtime resolver or parser behavior. This work covers build tooling only.

## Design

### 1. The sealed-artifact invariant (`core/utils/sealed-db.ts`, exported via `@mailwoman/core/utils`)

```ts
/** Finalize a built DB: WAL-checkpoint → journal_mode=DELETE → chmod 0o444. The LAST step of every builder. */
export function sealDatabase(path: string): void

/** Open a data artifact. Default read-only. A write-mode open of a sealed (0444) file throws
 *  SealedArtifactError("<name> is a sealed read-only artifact — rebuild it via `mailwoman gazetteer build …`,
 *  don't mutate it") instead of a cryptic SQLITE_READONLY. */
export function openBuiltDatabase(path: string, opts?: { write?: boolean }): DatabaseSync
```

- `sealDatabase` also removes `-wal`/`-shm` sidecars and verifies `journal_mode=delete` on a reopen.
- The builder writes to a private temp file (`<out>.ingest`). Only the final artifact is sealed, after verify passes. Unsealing is a deliberate manual step (`chmod u+w`) and no code path does it.
- Every existing builder (the 13 `build-*` scripts and their successors) ends with `sealDatabase`. This covers admin, candidate, postcode extracts, situs/interp extracts, timezone/UN-LOCODE/NUTS, conventions, and polygons.
- Each live production DB is sealed the next time it is rebuilt or promoted. The admin DB has been sealed since #1015.

### 2. The taxonomy: one `gazetteer` namespace, artifact→verb

```
mailwoman gazetteer
  build                # the full chain: admin → candidate, baked defaults, seals each artifact
  build admin          # WOF admin DB: ingest → overture(division_area bbox + country subtype)
                       #   → geonames → freeze(ancestors closure + −4 backfill + coincident_roles)
                       #   → region-abbrevs → place_abbr → FTS(place_search + place_bbox) → VERIFY → SEAL
  build candidate      # the byte-range candidate table (current `gazetteer build`, renamed intent intact)
  build postcode --country <CC>   # postcode extracts (NL PC6, CJK, KR, TW, GB… — one command, per-country recipes)
  build polygons       # wof-polygons sidecar
  verify [--db <path>] # the promotion check (see §4)
  promote / publish / release     # unchanged (already exist)
  inspect tree|graph|mermaid|sync # the ex-`wof` read-only inspection commands, moved
```

- The `mailwoman wof` namespace is **retired**. `prepare` is deleted as a stale partial duplicate, and `tree/graph/mermaid/sync` become `gazetteer inspect …`. A deprecation shim stays for one minor version: `wof <cmd>` prints the new name and exits 1.
- Canonical coverage lives in code as exported constants in the pipeline module: `DEFAULT_OVERTURE_COUNTRIES` (86), `DEFAULT_GEONAMES_COUNTRIES` (161), `DEFAULT_WOF_PRIORITY` (11), and `DEFAULT_OVERTURE_RELEASE`. `build admin --help` prints them. `scripts/wof-build-manifest.json` stops storing a recipe and becomes a **build log** in which each run appends what it built, when, and the md5. The command writes the log itself, so the log cannot lag.

### 3. Logic extraction: `mailwoman/gazetteer-pipeline/` module

`build-unified-wof.ts` (700 lines) splits into step functions that share one signature shape and can each be unit-tested:

```
gazetteer-pipeline/
  admin/ingest-wof.ts        # geojson repos → spr/names/concordances (the Piscina reader absorbed)
  admin/fold-overture.ts     # divisions + division_area bbox + country subtype  (ingestOvertureDivisions moves here)
  admin/fold-geonames.ts     # alias + postal folds (wraps the resolver-wof-sqlite ingest fns)
  admin/freeze.ts            # ancestors closure → ancestors(id) index → −4 backfill(maxId) → coincident_roles → indexes → VACUUM
  admin/enrich.ts            # region-abbrevs + place_abbr (the two steps #1015 missed — now unskippable)
  fts.ts                     # place_search + place_bbox (wraps build-fts)
  verify.ts                  # §4
  defaults.ts                # the coverage constants
```

Ink command files stay thin: they parse flags, call the pipeline, and render progress. The pipeline module lives in the `mailwoman` workspace. Publishing it is acceptable because its only heavy dependency is the optional `@duckdb/node-api`, which is already loaded lazily.

### 4. `gazetteer verify` — the structural check (the #1026 lesson)

`verify` runs against a staging DB and exits non-zero on any failure. `build admin` runs it automatically before sealing, and `promote` refuses an unverified artifact.

| Check                                                                                                                                                              | Catches                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **Country/region node census** vs a committed baseline (`gazetteer-pipeline/verify-baseline.json`: per-country expected `country`/`region`/`county` node presence) | the #1026 class — 95 countries losing their country node while row counts held |
| Reverse EU panel (capitals + border cities → correct country)                                                                                                      | the #1015 class (absorbs `scripts/reverse-eu-panel.ts`)                        |
| US forward spot-checks: `VT`→Vermont abbrev, NYC region-descendant reachable, `place_abbr` rows > 0                                                                | the #440 class + the missed-post-build-step class                              |
| Coverage floor: rows + distinct countries ≥ baseline                                                                                                               | gross truncation                                                               |
| Gauntlet hook: the #1025 country-column cases                                                                                                                      | the #1023 class                                                                |

When coverage changes intentionally, the baseline JSON is updated through a reviewed diff. A baseline that lags the artifact makes `verify` fail visibly.

### 5. Migration map (the whole drawer, 63 top-level files + 8 subdirs)

| Current                                                                                                                                                                               | Fate                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build-unified-wof.ts`, `add-region-abbrevs.ts`, `add-ancestors.ts`, `backfill-ancestors-from-hierarchy.ts`                                                                           | **delete** — subsumed by `gazetteer build admin`                                                                                                 |
| `augment-admin-overture.ts`, `augment-admin-official-names.ts`, `build-admin-geonames-fold.ts`, `build-coverage-expansion.ts`                                                         | **fold** their deltas into `build admin` steps (this is the #1026 fix path: their effects join the recipe), then **delete**                      |
| `backfill-postcode-centroids.ts`, `fill-zcta-centroids.ts`, `build-postcode-locality*.ts` (4), `build-postalcode-nl-pc6.ts`, `audit-po-box-cedex-extract.ts`                          | → `gazetteer build postcode --country …` recipes; mutators folded; **delete**                                                                    |
| `build-supplemental-gazetteer.ts`, `build-pilot-anchor-lookup.ts`, `build-country-reference.ts`, `build-official-languages.ts`                                                        | → `gazetteer build <artifact>` or (for pure codegen: country-reference, official-languages) `generate-*` retained as codegen with sealed outputs |
| `reverse-eu-panel.ts`                                                                                                                                                                 | → `gazetteer verify` (delete script)                                                                                                             |
| `diag-*.ts` (6), `eval-*.ts` (5), `harness-*.ts` (2), `extract-tuples*.ts`, `log-scale-chart.ts`, `training-chart.ts`, `parse-training-log.ts`                                        | → `scripts/eval/` & `scripts/diagnostic/` (gitignored per scripts/AGENTS.md) or **delete if stale** — triaged one by one in the plan             |
| `publish-*.ts`, `copy-weights.ts`, `bless-package.ts`, `check-release-parity.ts`, `verify-*.ts`, `smoke-*.ts`, `rewrite-workspace-imports.ts`, `release-workspace-repository.test.ts` | **stay** — release-it hooks + CI; the legitimate residents                                                                                       |
| `lint-*.ts`, `generate-language-types.ts`, `generate-trace-fixture.ts`, `generate.ts`, `jsonl-to-parquet.ts`, `fst-query.ts`                                                          | stay for now (tooling); candidates for later `mailwoman dev` commands, out of scope                                                              |
| `wof-build-manifest.json`                                                                                                                                                             | becomes the auto-appended build log (§2)                                                                                                         |
| subdirs `eval/ diagnostic/ modal/ coarse-placer/ census/ data/ lib/ record-matcher/`                                                                                                  | untouched this pass (eval/modal are legitimate; the rest triaged in a later phase)                                                               |

### 6. Sequencing (one spec, three PRs)

1. **PR A (read-only enforcement)**: `sealDatabase`/`openBuiltDatabase`, a retrofit into existing builders, and seal-on-promote. This PR is small and enforces read-only artifacts immediately.
2. **PR B (pipeline extraction)**: the `gazetteer-pipeline/` extraction, `build admin`, `verify` with its baseline, the `inspect` move, the 6 deletions, and the manifest-to-build-log change. It also adds the `wof` shim and rewrites RELEASING.md for the new command.
3. **PR C (remaining scripts)**: postcode/polygons/supplemental builders become subcommands, the mutators are folded in (the #1026 fix lands here through the augment folds), diagnostics are triaged, and the remaining scripts are deleted.

Each PR keeps `yarn test` and `typecheck:scripts` green. Before the old scripts are deleted, PR B validates `build admin` by building a staging DB and passing `verify` against it. Old-vs-new equivalence is judged by the per-country/per-placetype `spr` row census. File md5 is unsuitable because timestamps and VACUUM layout differ across runs.

## Testing

- Unit: each pipeline step against an in-memory fixture DB (the scoped-BE harness pattern from #1015 verification).
- `sealDatabase`/`openBuiltDatabase`: seal → RW-open throws `SealedArtifactError`; RO-open works; unseal path documented.
- `verify`: fixture DBs that each violate one check (missing country node, degenerate bbox, missing abbrevs) must fail with the named check.
- End-to-end (manual, runbook): `gazetteer build admin` → `verify` 15/15 + census green → compare vs live DB per-country placetype census.

## Risks

- **Reconstructing the augment scripts' effects** (PR C) is the riskiest step. The recipe equals the artifact only once we know what `augment-admin-*` contributed. The census baseline reduces the risk: diff the live DB against a recipe-only rebuild, then fold each delta into the recipe or declare it obsolete in the build log.
- **Retiring `wof`** breaks habits and existing docs. The shim and a docs sweep reduce that cost.
- The DuckDB/S3 dependency in `build admin` stays optional and lazily loaded, as it is today, so `mailwoman --help` never fails on it.
