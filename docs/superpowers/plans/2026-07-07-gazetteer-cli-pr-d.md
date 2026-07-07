# Gazetteer CLI PR D: zero mutators — the sealed postcode-shard command + drawer classification

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Checkbox steps.

**Goal:** Eliminate the last two DB mutators (`fill-zcta-centroids`, `backfill-postcode-centroids`) by folding their fills into a sealed `gazetteer build postcode-shard` command; classify every remaining drawer resident (audit → eval, codegen renamed, remaining builders seal-retrofitted); file PR E for the pure ports.

**Spec:** `docs/superpowers/specs/2026-07-07-scripts-cleanup-gazetteer-cli-design.md` §5 (PR C/D slice). **Deferred to PR E:** verbatim ports of `build-postcode-locality{,-cjk,-kr,-tw}`, `build-postalcode-nl-pc6`, `build-supplemental-gazetteer` (~2.2k lines, each needing source-data E2E), and the corpus tooling (`build-corpus-stats`, `align-canonical-shard`, `assemble-overlay-manifest`) — mechanical ports with per-artifact validation, their own session. `build-pilot-anchor-lookup` is LIVE (neural/scorer + eval consume its output) — stays until PR E decides its home.

## Global Constraints

As PR A–C. Branch `feat/gazetteer-cli-pr-d`.

### Task 1: `gazetteer-pipeline/postcode/` — the shard build with fills folded

**Files:**
- Move: `scripts/zcta-centroids.ts` → `mailwoman/gazetteer-pipeline/postcode/zcta-centroids.ts`; `scripts/zcta-centroids.test.ts` → sibling (import fixes only — the lib is sync + tested, stays raw SQL per AGENTS)
- Create: `mailwoman/gazetteer-pipeline/postcode/index.ts` — `buildPostcodeShard(opts)`:
  1. staging `.ingest` + `createUnifiedSchema` + `ingestWOF(db, { dataDir: <repos>/whosonfirst-data-postalcode-<cc>, placetypes: new Set(["postalcode"]) })`
  2. country fills: `us` → the ZCTA pass + GeoNames-postal pass (from zcta-centroids lib); others → the GeoNames-postal string-match fill + WOF admin-parent borrow (port the two fill passes of `backfill-postcode-centroids.ts` as functions)
  3. `VACUUM INTO out` → `buildFTS` → **seal**; returns fill provenance counts (the CC-BY attribution note rides the docstring)
- Create: `mailwoman/commands/gazetteer/build/postcode-shard.tsx` — thin command (`--country us`, `--out`, source-dir overrides)
- Delete: `scripts/fill-zcta-centroids.ts`, `scripts/backfill-postcode-centroids.ts`
- Modify: RELEASING.md postcode mentions; manifest `postcode_build*` sections gain a "superseded by `gazetteer build postcode-shard`" note

**Steps:**
- [ ] Move lib + test; fix imports; existing zcta tests stay green.
- [ ] `buildPostcodeShard` + fills (lazy resolver-wof-sqlite imports); fixture test: tiny staging DB with a `(0,0)` postcode row → fill from a fixture centroid map → sealed output.
- [ ] Command + compile + `gazetteer build postcode-shard --help` smoke.
- [ ] Delete the two mutators; straggler `rg`; docs touch-ups; typecheck + tests green; commit.

### Task 2: drawer classification sweep

- [ ] `git mv scripts/audit-po-box-cedex-shard.ts scripts/eval/` (an audit is an eval; fix any `./lib` depth).
- [ ] `git mv scripts/build-country-reference.ts scripts/generate-country-reference.ts`; `git mv scripts/build-official-languages.ts scripts/generate-official-languages.ts` (codegen family naming; update self-references + any doc pointing at them).
- [ ] Seal-retrofit the six remaining standalone builders (one-line `sealDatabase(out)` at each build's end): `build-postcode-locality{,-cjk,-kr,-tw}.ts`, `build-postalcode-nl-pc6.ts`, `build-supplemental-gazetteer.ts`.
- [ ] `typecheck:scripts` green; commit.

### Task 3: E2E + PR

- [ ] E2E: `gazetteer build postcode-shard --country us` → compare row/fill counts vs the live `postalcode-us.db` (filled-coordinate count must be ≥ live; provenance tags present); artifact sealed. Do NOT swap (operator-gated; the current live shard is fine).
- [ ] File the PR E tracking issue (the six ports + corpus tooling + pilot-anchor home + `scripts/` endgame).
- [ ] Push, open PR D.
