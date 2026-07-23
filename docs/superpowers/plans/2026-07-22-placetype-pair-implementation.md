# Placetype-pair prior — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Design authority: `2026-07-22-placetype-census-bias.md` (rev 2) + Kimi feedback. Every contract below was recon-verified against HEAD (`.superpowers/sdd/` recon report) — line refs are verified, not Kimi's estimates.

**Goal:** Ship the placetype-pair emission prior end to end: PIX1 pair-index artifact (GB) → sixth emission prior in `classifier.ts#decode` → falsifier boards → calibrated δ + full battery → `@mailwoman/neural-weights-en-gb` ship train.

**Tech:** TS only (no Python); Pastel CLI for the builder; vitest; the existing prior-stack contracts.

## Global Constraints

- Branch: `feat/placetype-pair-prior` from origin/main (the plan branch merges first or rebases in).
- Identifier family: `placetype-pair` / `pairIndex` / `PIX1` — never bare "census".
- Naming/casing, `.ts` imports, erasableSyntaxOnly, oxlint/oxfmt, compiled CLI, zero raw env/argv, `dataRootPath()` — all house rules apply.
- **Verified contracts (do not re-derive):** prior block = `classifier.ts:573–655`, `matrixHasBias` at 554, all priors receive `(source, pieces, this.labels, opts)` and fold via `addEmissionMatrix` (exported from `query-shape-prior.ts:205`); `TRACE_PRIOR_KINDS` at `trace.ts:28` (ordered; empty-input mirror at `classifier.ts:438`); `parseWithLogits` returns RAW pre-prior logits by contract (`classifier.ts:397–398`) — all public parse entries share `#decode`'s Viterbi path; word grouping = `groupPiecesIntoWords` (`fst-prior.ts:193`, exported) with `WordGroup {fstToken, pieceIndices}`; sibling resolution mirror = `resolveAnchorLookupSibling` (`weights.ts:283–297`) with `locale.split("-")[1]` country subtag; binary precedent = PCB1 (`postcode-binary-resolver.ts`, writer+reader one file); Pastel auto-discovers `commands/gazetteer/*.tsx` (zod `options` export + `useCommandTask`).
- Flag policy: a new flag = a `ParseOpts` field with the heavy JSDoc convention + a row in `docs/articles/plan/reference/runtime-flags.mdx` in the same PR (SCOPE invariant 5). No `registerFlag()` API exists.
- Frozen-scale headers: measured values carry eval date + delta inline (the `span-proposal-prior.ts:33–54` style).
- Data inputs (frozen snapshots): `$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/gb-tuples.csv` (CITY=dep-loc, DISTRICT=post town), FSA/CQC in the acquisition dirs, EPC for out-of-register coverage.

---

### Task 1: Export the normalization fold (single-source prerequisite)

**Files:** Modify `neural/fst-prior.ts` (line 234 `normalizeFSTToken` gains `export`; fix the stale JSDoc at 189–191 that already claims it's exported). Test: extend `neural/fst-prior.test.ts` (or create) with fold cases: NFKC, lowercase, `\p{P}\p{S}` strip; "Stockton-on-Tees" → "stocktonontees"; "Álava" vs "Alava" (document the observed diacritic behavior — NFKC does NOT strip diacritics; both sides of the index use the same fold so it's consistent; state this in the JSDoc).
Steps: failing test → export + doc fix → green → `yarn vitest run neural/` → commit `fix(neural): export normalizeFSTToken — the shared gazetteer fold (stale JSDoc already claimed it)`.

### Task 2: PIX1 pair-index format (writer + reader, one file)

**Files:** Create `neural/pair-index-resolver.ts` + `neural/pair-index-resolver.test.ts`.

**Interfaces (Produces):**

```ts
export interface PairIndexEntry {
	child: string
	parent: string
	tag: ComponentTag
} // folded strings
export interface PairIndexHeader {
	country: string
	delta: number
	schemaVersion: 1
	foldVersion: 1
	sourceMD5s: string[]
	buildDate: string
}
export function serializePairIndex(header: PairIndexHeader, entries: PairIndexEntry[]): Uint8Array
export class PairIndexResolver {
	constructor(bytes: Uint8Array) // validates magic "PIX1", throws on mismatch/schema>known
	readonly header: PairIndexHeader
	probe(childFolded: string, parentFolded: string): ComponentTag | undefined
}
export interface PairIndexLike {
	probe(child: string, parent: string): ComponentTag | undefined
	readonly delta?: number
}
```

Layout (PCB1 pattern, magic `PIX1`): header block (JSON-encoded, u32-length-prefixed — pairs are strings of variable length, a fixed-width key table buys nothing at 20k entries; document the departure from PCB1's fixed keys) + u32 pairCount + per-pair `u16 childLen, child utf8, u16 parentLen, parent utf8, u8 tagIdx` sorted by (child,parent) bytes; `probe` via binary search or a built Map (20k entries → Map is fine; build once in ctor). Tag table = `COMPONENT_TAGS` index (core types).
TDD: round-trip test (serialize → construct → probe hits/misses), bad-magic throw, unknown-schema throw, header fidelity. Commit `feat(neural): PIX1 pair-index format — writer + reader (PCB1 single-file pattern)`.

### Task 3: Builder command + the GB artifact

**Files:** Create `mailwoman/commands/gazetteer/pair-index.tsx` (template: `postcode-binary.tsx` — zod `options` export, `useCommandTask`, `dataRootPath`, value-import `serializePairIndex` from the resolver subpath). Options: `--out` (default `docs/static/mailwoman`), `--country` (default gb), `--source` (default the PPD tuples path), `--delta` (REQUIRED, no default — calibration task supplies it; refuse to default silently).

Behavior: stream the tuples CSV (CSVSpliterator idiom from `shard-recipes/locale.ts`), fold child=CITY/parent=DISTRICT via `normalizeFSTToken`, skip empty-CITY rows, dedupe pairs, count; print the **CITY word-length distribution percentiles** (sets window N for Task 4 — record p99 in the output and the report); write `pair-index-gb.bin` with provenance header (source md5 via existing hash utils). Run it for real (expect ≈19,431 pairs — the rung-3 number is the cross-check; mismatch = STOP). Tests: builder unit on fixture CSV (dedupe, fold, empty-CITY skip). Commit incl. the real-run stats line.

### Task 4: The prior module (sixth emission prior)

**Files:** Create `neural/placetype-pair-prior.ts` + test. Modify `neural/trace.ts` (append `"placetypePair"` to `TRACE_PRIOR_KINDS` — ORDER = application order, after `spanProposer`, before `conventionsMask`? No: composition order in `#decode` decides; add it after `spanProposer` and before `conventionsMask` in BOTH the constant and the push-site placement so the mask still applies last). Modify `neural/classifier.ts`: `ParseOpts` field `placetypePair?: { index: PairIndexLike; biasScale?: number }` (heavy JSDoc: default behavior, evidence line, no-country semantics), compose block after spanProposer (`buildPlacetypePairPriors(opts.placetypePair, pieces, this.labels, ...)` + `matrixHasBias` push), empty-input mirror stays derived from `TRACE_PRIOR_KINDS` (verify test `test/trace-parse.test.ts` fails RED on the constant change until the push site lands — that's the designed trip-wire, use it as the TDD RED).

**Prior semantics (the validated rung-3 rule, generalized to windows):**

- Build word groups via `groupPiecesIntoWords(pieces)`; candidate windows = contiguous non-empty groups, 1..N words (N from Task 3's p99, expected ≤3), folded by joining group tokens.
- Two-sided rule: window X gets bias iff ∃ window Y (disjoint, anywhere in input) with `probe(x, y) = tag`. Order-free (matches rung-3 evidence); note order/distance as a future tunable with the frozen-scale header style.
- **Marker suppression:** X immediately followed by a word in the structural-marker set (house/road/street/flat/court/…, table in-module with rationale) → no bias (the DeepSeek venue-confound filter).
- Bias write: `+delta` (from `PairIndexLike.delta ?? biasScale`) on `B-<tag>` first piece / `I-<tag>` rest, per `fst-prior.ts`'s `applyBias` pattern (per-PIECE matrix `[pieces.length][labels.length]`).
- No index / no country context → zero matrix (composes harmlessly; explicit test).

Tests: matrix-cell exactness (query-shape-prior.test.ts style + the street-morphology mock idiom); the two registered decode-order classes (bias-united word survives the vote; encoder-confident word vetoes) — these exercise `#decode` end-to-end with a stub runner if the harness supports it, else at the documented unit boundary with a note; marker suppression; comma-free input (windows over "fishburn stockton on tees" — multi-word parent "stockton on tees" must match via 3-word window). Commit per piece (trace constant + module + wiring can be one reviewed commit if the trip-wire choreography demands it).

### Task 5: Weights sibling + country gating

**Files:** Modify `neural/weights.ts` (add `resolvePairIndexSibling` mirroring `resolveAnchorLookupSibling:283–297`; `ResolvedWeights.pairIndexPath?: string`; spread in both the package-dir and overlay paths — the en-gb overlay resolves it locally like postcode-gb.bin). Modify `neural/classifier.ts` load path (`classifier.ts:296–304` region): construct `PairIndexResolver` when `pairIndexPath` present AND the resolved locale's country matches the index header's country (the hard country gate — mismatch = skip + one warn). Extend `neural/test/weights.test.ts` en-gb case: `pairIndexPath` resolves; parse smoke with a GB dep-loc address emits the tag (this is the arc's end-to-end proof).
Note: the runtime country context = the locale the weights resolved for (en-gb → gb). The plan's "no-country → no bias" case is structurally covered (base en-us package ships no pair index), but ALSO test: en-us weights + GB-looking input → prior inert.

### Task 6: Falsifier boards + holdout evals (data + scripts, minimal commits)

1. **Venue-confound board** (≥5k): FSA (600k GB venues) ∩ index child names, parent in-string; through the FULL pipeline with the prior ON; bar FP = 0 for window mode. Committed board sample (~200 rows) + the full-run report; generator script in scratchpad, numbers in the SDD report.
2. **Comma-stripped variants** of gb-golden + nz-suburb-golden re-run (window mode): recall vs comma-mode −5pp bar.
3. **Pair-holdout**: rebuild index minus random 10% of pairs (builder `--holdout-seed/--holdout-fraction` dev flags or a scratch build), boards re-run, degradation curve recorded — **acceptance bars re-anchor to these numbers**.
4. **Out-of-register coverage**: EPC-derived GB addresses (from the 2026-07-22 acquisition) — % whose (dep-loc, town) pair is in the index. Pure measurement, reported.

### Task 7: δ calibration + full battery + checkpoint matrix

- δ_gb calibrated on held-out register rows (sweep at the calibrated candidate ±; the rung-3 δ=6.0 is the prior expectation, not the answer); frozen-scale header written with date + numbers; builder re-run with the final δ.
- Checkpoint matrix: feed-2k vs feed-8k (peer options) × prior ON — full battery each: golden us/fr ±0.7pp, bare-locality ≥0.90, digit adjudication, 4 dep-loc boards (full pipeline), presets byte-identical for non-GB, val ±1.0pp, 2pp error-analysis, gauntlet. **cRT probe (v3.12.0, running) folds in here** — if its 8k held emission, it joins the matrix as a third checkpoint candidate.
- `runtime-flags.mdx` row + the surface-audit paragraph (which public surfaces ride Viterbi; `parseWithLogits` raw contract).

### Task 8: Packaging + ship + docs

- `pair-index-gb.bin` into `neural-weights-en-gb` (files array, link-dev-weights, copy-weights/publish.yml/HF staging — re-walk the #1249 13-list audit), README updated.
- Ship train per mailwoman-release skill (operator promotes). Demo GB preset lands here.
- Research note + eval-ledger row incl. the census-prior flip-attribution count (talk material). Memory + SCOPE updates.

## Pre-registered acceptance

As rev-2 design §acceptance, with bars re-anchored to Task 6.3's holdout numbers; plus: Task 5's en-gb parse smoke green; trace snapshot test green with the new kind; non-GB byte-identity proven by test, not assertion.

### Task 9: Paired-punctuation audit — quotes, brackets, braces, parens (final task)

**Scope:** characterize + harden the decode path's handling of paired punctuation, end to end: tokenizer pieces → `groupPiecesIntoWords` (the pending-start machine's treatment of quote/bracket pieces — leading-quote word starts, trailing quote+comma) → `normalizeFSTToken` fold (quotes strip via `\p{P}` — verify probeable windows survive quoting) → priors (a quoted venue/place name must still probe) → decoder spans (do stray quote/bracket chars leak into component values at span edges? `build-tree` raw slicing) → formatter round-trip.

**Explicit cases (table-driven, fixture tier + skipIf-production tier per the Task-4 pattern):** `"The Grange", Fishburn, Stockton-on-Tees` (quoted venue); `12 High St (rear entrance), Leeds` (parenthetical aside); `Unit 4 [Block B]` (bracketed designator); braces; curly vs straight quotes (what does NFKC map?); guillemets «»; UNBALANCED pairs (fail-open, never crash, never drop).

**Gates:** zero crashes on any case; zero silent WORD DROPS (the Task-4 class — assert group recovery); span edges don't capture stray paired chars (characterize; fix if local to span trimming, else document-with-rationale). Same adjudication discipline: any "accepted behavior" verdict carries evidence, and anything in the drop/mangle class gets fixed, not documented.

**Sequencing:** final task — runs after Task 8, before the arc's whole-branch review, so it audits the SHIPPED configuration.

## Post-plan amendments (2026-07-23)

- Task 9 (above) was an operator addition during execution; it found and fixed a third shared-plumbing production bug class (tokenizer byte-fallback offset corruption) — see the arc PR.
- The v3.11.x model lineage was CLOSED by pre-registered stop rule (gauntlet metamorphic); the model path continues in `2026-07-23-v312-comma-robust-recipe.md`. The arc's code ships inert-until-promote by design.
- The metamorphic invariance mini-suite (unplanned addition, five-whys outcome) is now a mandatory probe-level guard.
