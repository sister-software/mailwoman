# Gazetteer CLI PR C: the #1026 cure + mutator deletions + diagnostics triage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canonical recipe produce the country/region nodes it has been silently missing (#1026 — the GeoNames admin fold), delete the four superseded admin-mutation scripts, and corral the loose diagnostics — the PR C slice of the cleanup spec.

**Architecture:** `foldGeonames` gains the existing (never-wired) `adminForCountries` capability from `ingestGeonamesAliases` (#267); `buildAdmin` computes the zero-coverage gap set (geonames − overture − WOF-priority) and passes it. An E2E rebuild through `gazetteer build admin` must then pass the full verify gate — that artifact is the #1026 swap candidate.

**Tech Stack:** as PR A+B (`docs/superpowers/plans/2026-07-07-sealed-artifacts-gazetteer-cli.md`).

**Spec:** `docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md` §5/§6 (PR C). **Deferred to PR D:** the postcode-family builders (`build-postcode-locality*`, `build-postalcode-nl-pc6`, `backfill-postcode-centroids`, `fill-zcta-centroids`) and the codegen/supplemental builders — a distinct artifact family deserving its own focused pass.

## Global Constraints

Same as PR A+B (branch `feat/gazetteer-cli-pr-c` off main; oxlint/oxfmt + `typecheck:scripts` green per commit; sealed artifacts; no hardcoded data roots).

## Diagnosis (locked)

- The pre-936 DB's 102 GeoNames-era country nodes (+ GE's 12 regions) were created by `ingestGeonamesAliases`'s `opts.adminForCountries` (#267: PCLI country + ADM1 regions + locality `parent_id`/ancestry linking) — passed ONLY by `scripts/build-coverage-expansion.ts:129`, never by the canonical build. The recipe therefore never produced them (E2E-confirmed on #1026).
- The correct fold set is the **zero-coverage gap**: `DEFAULT_GEONAMES_COUNTRIES − DEFAULT_OVERTURE_COUNTRIES − DEFAULT_WOF_PRIORITY_COUNTRIES` (147 countries; per the #267 docstring, a country with WOF/Overture admin would double up — the gap set excludes them by construction). Every #1026-flattened country is in the gap set; the extra ~45 are dependencies/territories that gain nodes too (strictly additive).

---

### Task 1: `foldGeonames` admin-fold wiring + the gap-set default (the #1026 cure)

**Files:**

- Modify: `mailwoman/gazetteer-pipeline/defaults.ts` — add `geonamesAdminGapCountries()` helper
- Modify: `mailwoman/gazetteer-pipeline/admin/fold-geonames.ts` — `adminForCountries` option, passed through
- Modify: `mailwoman/gazetteer-pipeline/admin/index.ts` — `buildAdmin` passes the gap set by default
- Test: `mailwoman/gazetteer-pipeline/defaults.test.ts` — gap-set shape test

**Steps:**

- [ ] Test first: `geonamesAdminGapCountries()` returns 147 codes, disjoint from Overture + WOF lists, contains GE and every #1026-flattened country, excludes BE/AT/CH/LU (Overture-covered). Run RED.
- [ ] Implement: `defaults.ts` exports the helper (pure set difference). `FoldGeonamesOptions.adminForCountries?: ReadonlySet<string>` → passed to `ingestGeonamesAliases` opts. `buildAdmin` default: `adminForCountries: new Set(geonamesAdminGapCountries())` (overridable).
- [ ] GREEN + `tsc -b mailwoman` + commit.

### Task 2: delete the four superseded admin-mutation scripts

**Files:** Delete `scripts/augment-admin-overture.ts`, `scripts/augment-admin-official-names.ts`, `scripts/build-admin-geonames-fold.ts`, `scripts/build-coverage-expansion.ts`.

Each is subsumed: incremental Overture augment → edit `defaults.ts` + rebuild (`build admin`); #936 official-names bridge → the #940 ingest bit is native (its own docstring says "until the next full rebuild"); the standalone geonames fold → `foldGeonames`; coverage expansion → the recipe IS the coverage (edit defaults, rebuild, verify gates it).

**Steps:**

- [ ] `rg` each filename for imports (comments are lineage, fine); `git rm` the four; `typecheck:scripts` green; commit.

### Task 3: diagnostics triage (the drawer's loose papers)

**Files:** `git mv` into the gitignored homes per `scripts/AGENTS.md`:

- → `scripts/diagnostic/`: `diag-functional-morphology.ts`, `diag-geocode-earth.ts`, `diag-nyc-reconcile.ts`, `diag-postcode-anchor.ts`, `diag-postcode.ts`, `diag-saintalbans.ts`
- → `scripts/eval/`: `eval-de-coverage.ts`, `eval-error-analysis.ts`, `eval-gate.ts`, `eval-joint-reconcile.ts`, `eval-morphology-fst.ts`, `harness-postcode.ts`, `harness-v0-neural.ts`, `extract-tuples.ts`, `extract-tuples-de-gb.ts`, `log-scale-chart.ts`, `training-chart.ts`, `parse-training-log.ts`

**Steps:**

- [ ] Check `.gitignore` treatment of `scripts/diagnostic/` + `scripts/eval/` (AGENTS says diagnostics are ignored by default — if these dirs are tracked, keep the moves tracked; do NOT let a gitignore rule silently delete history).
- [ ] `rg` for imports of each moved file (none expected — they're leaf diagnostics); move; `typecheck:scripts` green; commit.

### Task 4: E2E — the recipe now reproduces the artifact (the #1026 candidate)

- [ ] `yarn compile && node mailwoman/out/cli.js gazetteer build admin --out /mnt/playpen/mailwoman-data/wof/admin-global-priority.PRC.db` (~12 min).
- [ ] Expected: **verify PASS 21/21** (node-census restored — the gate that failed on the E2E in PR B), sealed, build-log appended.
- [ ] Per-country/per-placetype census diff vs the live DB + vs the pre-936 backup (GE must have country+regions again). Post findings to #1026.
- [ ] **Do NOT swap** — present the artifact + census to the operator (runbook swap is a deliberate step: bak → mv → seal check → service restarts → demo propagation).
- [ ] Push branch, open PR C referencing the spec + #1026.
