# Scripts cleanup: sealed data artifacts + the unified `gazetteer` pipeline CLI

**Date:** 2026-07-07 · **Status:** approved design, pre-implementation
**Driver issues:** #1015/#1021 (the rebuild ordeal), #1026 (the flattened-nodes regression), operator directive: "the scripts directory keeps turning into a kitchen junk drawer … I don't want the scripts directory to exist anymore eventually."

## Problem

Three compounding failures, all demonstrated live this week:

1. **Mutable shipped artifacts.** Every SQLite DB we build is supposed to be a read-only asset, but nothing enforces it. Scripts like `backfill-ancestors-from-hierarchy.ts` exist precisely to reopen an already-built DB read-write and patch it. The policy lives in memories and docstrings; the filesystem doesn't know about it.
2. **The recipe is not the artifact.** The live `admin-global-priority.db` accumulated state from ad-hoc augment scripts (`augment-admin-*`, `build-coverage-expansion`, …) that no recorded recipe reproduces. The #1015 full rebuild faithfully reproduced the *manifest recipe* and thereby **lost ~95 countries' country/region nodes** (#1023/#1026) — the recipe and the artifact had silently diverged. A coverage-count gate (rows + distinct countries) passed while the structural regression slipped through.
3. **The build is a scattered dance.** Building the admin gazetteer correctly takes one 700-line script plus four post-build steps in a specific order (`add-region-abbrevs` → `place_abbr` → `build-fts`, with `backfill-ancestors` folded but the others not), documented only in RELEASING.md prose and a lagging manifest. The #1015 rebuild missed two of them on the first pass. `mailwoman wof prepare` is a stale partial duplicate; `mailwoman gazetteer build` builds a *different* artifact (the candidate table). A fresh clone cannot tell what builds what.

## Goals

- **Mechanical read-only enforcement**: a sealed artifact cannot be reopened read-write, at the OS layer, with a clear error message.
- **First-clone usefulness**: one self-documenting command namespace where `--help` IS the data pipeline; the canonical coverage recipe lives in code as defaults, not in a manifest that lags or an artifact you reverse-engineer.
- **Recipe ≡ artifact**: a full rebuild from the recorded recipe reproduces the shipped artifact (gated by a verify step that checks *structure*, not just counts).
- **Endgame**: `scripts/` contains only release-it hooks, CI smoke, and the eval harness. No builders, no mutators.

## Non-goals

- Fixing #1026's data regression itself (that's a rebuild run through the new pipeline once it exists — the issue stays open and gates on `gazetteer verify`).
- Migrating the eval harness (`scripts/eval/`, gauntlet) — it stays, it's the third legitimate resident.
- Changing any runtime resolver/parser behavior. This is build-tooling only.

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
- Writable staging is the builder's private temp (`<out>.ingest`); the seal happens on the final artifact only, after verify passes. Unseal is deliberate and manual (`chmod u+w`), never programmatic.
- Every existing builder (the 13 `build-*` scripts and their successors) ends with `sealDatabase`. Applied to: admin, candidate, postcode shards, situs/interp shards, timezone/UN-LOCODE/NUTS, conventions, polygons.
- The live production DBs get sealed as they are next rebuilt/promoted (the admin DB already is, since #1015).

### 2. The taxonomy: one `gazetteer` namespace, artifact→verb

```
mailwoman gazetteer
  build                # the full chain: admin → candidate, baked defaults, seals each artifact
  build admin          # WOF admin DB: ingest → overture(division_area bbox + country subtype)
                       #   → geonames → freeze(ancestors closure + −4 backfill + coincident_roles)
                       #   → region-abbrevs → place_abbr → FTS(place_search + place_bbox) → VERIFY → SEAL
  build candidate      # the byte-range candidate table (current `gazetteer build`, renamed intent intact)
  build postcode --country <CC>   # postcode shards (NL PC6, CJK, KR, TW, GB… — one command, per-country recipes)
  build polygons       # wof-polygons sidecar
  verify [--db <path>] # the promotion gate (see §4)
  promote / publish / release     # unchanged (already exist)
  inspect tree|graph|mermaid|sync # the ex-`wof` read-only inspection commands, moved
```

- `mailwoman wof` namespace is **retired**: `prepare` deleted (stale partial duplicate), `tree/graph/mermaid/sync` become `gazetteer inspect …`. A deprecation shim (`wof <cmd>` → prints the new name, exits 1) for one minor version.
- Canonical coverage lives in code: `DEFAULT_OVERTURE_COUNTRIES` (86), `DEFAULT_GEONAMES_COUNTRIES` (161), `DEFAULT_WOF_PRIORITY` (11), `DEFAULT_OVERTURE_RELEASE` — exported constants in the pipeline module, printed by `build admin --help`. `scripts/wof-build-manifest.json` stops being a recipe store and becomes a pure **build log** (each run appends what/when/md5) — written automatically by the command, so it can't lag.

### 3. Logic extraction: `mailwoman/gazetteer-pipeline/` module

`build-unified-wof.ts` (700 lines) decomposes into step functions with one signature shape, each unit-testable:

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

Ink command files stay thin (parse flags → call pipeline → render progress). The pipeline module lives in the `mailwoman` workspace (publishable is fine — no heavy deps beyond the optional `@duckdb/node-api` already handled lazily).

### 4. `gazetteer verify` — the structural gate (the #1026 lesson)

Runs against a staging DB, exits non-zero on any failure; `build admin` runs it automatically before sealing; `promote` refuses an unverified artifact.

| Check | Catches |
| --- | --- |
| **Country/region node census** vs a committed baseline (`gazetteer-pipeline/verify-baseline.json`: per-country expected `country`/`region`/`county` node presence) | the #1026 class — 95 countries losing their country node while row counts held |
| Reverse EU panel (capitals + border cities → correct country) | the #1015 class (absorbs `scripts/reverse-eu-panel.ts`) |
| US forward spot-checks: `VT`→Vermont abbrev, NYC region-descendant reachable, `place_abbr` rows > 0 | the #440 class + the missed-post-build-step class |
| Coverage floor: rows + distinct countries ≥ baseline | gross truncation |
| Gauntlet hook: the #1025 country-column cases | the #1023 class |

The baseline JSON is updated deliberately (a reviewed diff) when coverage intentionally changes — a lagging baseline fails loudly instead of silently.

### 5. Migration map (the whole drawer, 63 top-level files + 8 subdirs)

| Current | Fate |
| --- | --- |
| `build-unified-wof.ts`, `add-region-abbrevs.ts`, `add-ancestors.ts`, `backfill-ancestors-from-hierarchy.ts` | **delete** — subsumed by `gazetteer build admin` |
| `augment-admin-overture.ts`, `augment-admin-official-names.ts`, `build-admin-geonames-fold.ts`, `build-coverage-expansion.ts` | **fold** their deltas into `build admin` steps (this is the #1026 cure path: their effects join the recipe), then **delete** |
| `backfill-postcode-centroids.ts`, `fill-zcta-centroids.ts`, `build-postcode-locality*.ts` (4), `build-postalcode-nl-pc6.ts`, `audit-po-box-cedex-shard.ts` | → `gazetteer build postcode --country …` recipes; mutators folded; **delete** |
| `build-supplemental-gazetteer.ts`, `build-pilot-anchor-lookup.ts`, `build-country-reference.ts`, `build-official-languages.ts` | → `gazetteer build <artifact>` or (for pure codegen: country-reference, official-languages) `generate-*` retained as codegen with sealed outputs |
| `reverse-eu-panel.ts` | → `gazetteer verify` (delete script) |
| `diag-*.ts` (6), `eval-*.ts` (5), `harness-*.ts` (2), `extract-tuples*.ts`, `log-scale-chart.ts`, `training-chart.ts`, `parse-training-log.ts` | → `scripts/eval/` & `scripts/diagnostic/` (gitignored per scripts/AGENTS.md) or **delete if stale** — triaged one by one in the plan |
| `publish-*.ts`, `copy-weights.ts`, `bless-package.ts`, `check-release-parity.ts`, `verify-*.ts`, `smoke-*.ts`, `rewrite-workspace-imports.ts`, `release-workspace-repository.test.ts` | **stay** — release-it hooks + CI; the legitimate residents |
| `lint-*.ts`, `generate-language-types.ts`, `generate-trace-fixture.ts`, `generate.ts`, `jsonl-to-parquet.ts`, `fst-query.ts` | stay for now (tooling); candidates for later `mailwoman dev` commands, out of scope |
| `wof-build-manifest.json` | becomes the auto-appended build log (§2) |
| subdirs `eval/ diagnostic/ modal/ coarse-placer/ census/ data/ lib/ record-matcher/` | untouched this pass (eval/modal are legitimate; the rest triaged in a later phase) |

### 6. Sequencing (one spec, three PRs)

1. **PR A — the invariant**: `sealDatabase`/`openBuiltDatabase` + retrofit into existing builders + seal-on-promote. Small, ships the guarantee immediately.
2. **PR B — the anchor**: `gazetteer-pipeline/` extraction + `build admin` + `verify` (with baseline) + `inspect` move + the 6 deletions + manifest→build-log. The `wof` shim. RELEASING.md rewritten to the new command.
3. **PR C — the sweep**: postcode/polygons/supplemental builders → subcommands, mutator folds (#1026's cure lands here via the augment folds), diagnostics triage, remaining deletions.

Each PR keeps `yarn test` + `typecheck:scripts` green; PR B's `build admin` is validated by building a staging DB and passing `verify` against it before the old scripts are deleted. Old-vs-new equivalence is judged by the per-country/per-placetype `spr` row census (not file md5 — timestamps and VACUUM layout differ across runs).

## Testing

- Unit: each pipeline step against an in-memory fixture DB (the scoped-BE harness pattern from #1015 verification).
- `sealDatabase`/`openBuiltDatabase`: seal → RW-open throws `SealedArtifactError`; RO-open works; unseal path documented.
- `verify`: fixture DBs that each violate one gate (missing country node, degenerate bbox, no abbrevs) must fail with the named check.
- End-to-end (manual, runbook): `gazetteer build admin` → `verify` 15/15 + census green → compare vs live DB per-country placetype census.

## Risks

- **The augment-script archaeology** (PR C) is the risky part: reconstructing what `augment-admin-*` contributed so the recipe finally equals the artifact. Mitigated by the census baseline: diff the live DB against a recipe-only rebuild, and every delta must be either folded or explicitly declared obsolete in the build log.
- **`wof` retirement** breaks muscle memory/docs; mitigated by the shim + docs sweep.
- DuckDB/S3 dependency in `build admin` stays optional-lazy (same pattern as today) so `mailwoman --help` never faults.
