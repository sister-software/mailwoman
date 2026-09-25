# Placetype-pair prior — implementation plan

> **For agentic workers:** The required sub-skill is superpowers:subagent-driven-development. The design authority is `2026-07-22-placetype-census-bias.md` (rev 2) plus the Kimi feedback. Every interface below was checked against HEAD in the `.superpowers/sdd/` recon report, so the line references are verified rather than Kimi's estimates.

**Goal:** Ship the placetype-pair emission prior end to end, in this order: the PIX1 pair-index artifact (GB), the sixth emission prior in `classifier.ts#decode`, the falsifier boards, a calibrated δ with the full battery, and the `@mailwoman/neural-weights-en-gb` release train.

**Tech:** TS only (no Python), the Pastel CLI for the builder, vitest, and the existing prior-stack interfaces.

## Global Constraints

- Branch: `feat/placetype-pair-prior` from origin/main. The plan branch merges first or is rebased in.
- Identifier family: `placetype-pair`, `pairIndex`, and `PIX1`. Never use bare "census".
- All house rules apply: naming and casing, `.ts` imports, erasableSyntaxOnly, oxlint/oxfmt, the compiled CLI, zero raw env/argv reads, and `dataRootPath()`.
- **Verified interfaces (do not re-derive):**
  - The prior block is `classifier.ts:573–655`, and `matrixHasBias` is at 554. Every prior receives `(source, pieces, this.labels, opts)` and is folded in with `addEmissionMatrix` (exported from `query-shape-prior.ts:205`).
  - `TRACE_PRIOR_KINDS` is at `trace.ts:28`. It is ordered, and its empty-input mirror is at `classifier.ts:438`.
  - `parseWithLogits` returns raw pre-prior logits by design (`classifier.ts:397–398`). All public parse entries share the Viterbi path in `#decode`.
  - Word grouping uses `groupPiecesIntoWords` (`fst-prior.ts:193`, exported), which returns `WordGroup {fstToken, pieceIndices}`.
  - Sibling resolution should mirror `resolveAnchorLookupSibling` (`weights.ts:283–297`), which takes the country subtag from `locale.split("-")[1]`.
  - The binary-format precedent is PCB1 (`postcode-binary-resolver.ts`), with the writer and reader in one file.
  - Pastel auto-discovers `commands/gazetteer/*.tsx` files that export a zod `options` schema and use `useCommandTask`.
- Flag policy: A new flag is a `ParseOpts` field with the heavy JSDoc convention, plus a row in `docs/articles/plan/reference/runtime-flags.mdx` in the same PR (SCOPE invariant 5). No `registerFlag()` API exists.
- Frozen-scale headers: Measured values carry the eval date and delta inline, in the `span-proposal-prior.ts:33–54` style.
- Data inputs (frozen snapshots): `$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/gb-tuples.csv` (CITY is the dep-loc and DISTRICT is the post town), FSA/CQC in the acquisition dirs, and EPC for out-of-register coverage.

---

### Task 1: Export the normalization fold (single-source prerequisite)

**Files:** Modify `neural/fst-prior.ts`. Add `export` to `normalizeFSTToken` at line 234, and fix the stale JSDoc at 189–191 that already claims it is exported. Extend `neural/fst-prior.test.ts` (or create it) with fold cases: NFKC, lowercase, and the `\p{P}\p{S}` strip. Include "Stockton-on-Tees" → "stocktonontees" and "Álava" vs "Alava". For the diacritic case, document the observed behavior in the JSDoc: NFKC does not strip diacritics, and the result stays consistent because both sides of the index use the same fold.
Steps: Write the failing test, add the export and the doc fix, get the test passing, run `yarn vitest run neural/`, and commit `fix(neural): export normalizeFSTToken — the shared gazetteer fold (stale JSDoc already claimed it)`.

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

Layout (PCB1 pattern, magic `PIX1`):

- A header block, JSON-encoded and prefixed with a u32 length. Pairs are variable-length strings, and a fixed-width key table would add no value at 20k entries. Document this departure from PCB1's fixed keys.
- A u32 pairCount.
- Per pair: `u16 childLen, child utf8, u16 parentLen, parent utf8, u8 tagIdx`, sorted by (child,parent) bytes.

`probe` uses binary search or a Map. A Map is fine at 20k entries, built once in the constructor. The tag table is the `COMPONENT_TAGS` index from core types.
TDD: a round-trip test (serialize, construct, probe hits and misses), a throw on bad magic, a throw on an unknown schema, and header fidelity. Commit `feat(neural): PIX1 pair-index format — writer + reader (PCB1 single-file pattern)`.

### Task 3: Builder command + the GB artifact

**Files:** Create `mailwoman/commands/gazetteer/pair-index.tsx`, using `postcode-binary.tsx` as the template: a zod `options` export, `useCommandTask`, `dataRootPath`, and a value import of `serializePairIndex` from the resolver subpath. Options:

- `--out` (default `docs/static/mailwoman`)
- `--country` (default gb)
- `--source` (default the PPD tuples path)
- `--delta` (required, without a default). The calibration task supplies it, and the command must refuse to fall back to a silent default.

Behavior:

1. Stream the tuples CSV with the CSVSpliterator idiom from `extract-recipes/locale.ts`.
2. Fold child=CITY and parent=DISTRICT with `normalizeFSTToken`. Skip rows with an empty CITY, dedupe the pairs, and count them.
3. Print the **CITY word-length distribution percentiles**. They set window N for Task 4, so record p99 in the output and in the report.
4. Write `pair-index-gb.bin` with the provenance header, computing the source md5 with the existing hash utils.

Run the builder on the real data. It should produce about 19,431 pairs, which cross-checks against the rung-3 number. If the count differs, stop. Tests: a builder unit test on a fixture CSV covering dedupe, fold, and the empty-CITY skip. Include the real-run stats line in the commit.

### Task 4: The prior module (sixth emission prior)

**Files:** Create `neural/placetype-pair-prior.ts` and its test.

- Modify `neural/trace.ts` to append `"placetypePair"` to `TRACE_PRIOR_KINDS`. The composition order in `#decode` sets the order. Add the kind after `spanProposer` and before `conventionsMask`, in both the constant and the push site, so that the mask still applies last.
- Modify `neural/classifier.ts`:
  - Add the `ParseOpts` field `placetypePair?: { index: PairIndexLike; biasScale?: number }`. Its heavy JSDoc covers the default behavior, the evidence line, and the behavior without country context.
  - Compose the prior after spanProposer with `buildPlacetypePairPriors(opts.placetypePair, pieces, this.labels, ...)` and the `matrixHasBias` push.
  - Keep deriving the empty-input mirror from `TRACE_PRIOR_KINDS`. `test/trace-parse.test.ts` should fail after the constant change and pass once the push site lands. That failure is intended, so use it as the TDD red step.

**Prior semantics (the rung-3 behavior checked in tests, generalized to windows):**

- Build word groups with `groupPiecesIntoWords(pieces)`. Candidate windows are runs of 1..N contiguous non-empty groups, where N comes from Task 3's p99 (expected ≤3). Fold a window by joining its group tokens.
- Two-sided rule: Window X gets the bias if and only if some disjoint window Y anywhere in the input satisfies `probe(x, y) = tag`. The rule ignores order, which matches the rung-3 evidence. Note order and distance as possible future tunables, in the frozen-scale header style.
- **Marker suppression:** If X is immediately followed by a word in the structural-marker set (house, road, street, flat, court, and so on), X gets no bias. This is the DeepSeek venue-confound filter. Keep the marker table in the module with its rationale.
- Bias write: Add `+delta` (from `PairIndexLike.delta ?? biasScale`) to `B-<tag>` on the first piece and `I-<tag>` on the rest, following the `applyBias` pattern in `fst-prior.ts`. The matrix is per piece, `[pieces.length][labels.length]`.
- Without an index or country context, the prior returns a zero matrix, which composes harmlessly. Cover this with an explicit test.

Tests:

- Exact matrix cells, in the `query-shape-prior.test.ts` style with the street-morphology mock idiom.
- The two registered decode-order classes: a word the bias united survives the vote, and a word the encoder is confident about vetoes the bias. Exercise `#decode` end to end with a stub runner if the harness supports it. Otherwise test at the documented unit boundary and add a note.
- Marker suppression.
- Comma-free input. For "fishburn stockton on tees", the multi-word parent "stockton on tees" must match through a 3-word window.

Commit each piece separately. The trace constant, module, and wiring can go in one reviewed commit if the failing-test sequence requires it.

### Task 5: Weights sibling + country blocking

**Files:**

- Modify `neural/weights.ts`. Add `resolvePairIndexSibling`, mirroring `resolveAnchorLookupSibling:283–297`, and add `ResolvedWeights.pairIndexPath?: string`. Spread it in both the package-dir and overlay paths. The en-gb overlay resolves it locally, like postcode-gb.bin.
- Modify the load path in `neural/classifier.ts` (the `classifier.ts:296–304` region). Construct `PairIndexResolver` when `pairIndexPath` is present and the resolved locale's country matches the country in the index header. This is the strict country check. On a mismatch, skip the index and warn once.
- Extend the en-gb case in `neural/test/weights.test.ts`. `pairIndexPath` should resolve, and a parse smoke test with a GB dep-loc address should emit the tag. This test is the arc's end-to-end proof.

Note: The runtime country context is the locale the weights resolved for (en-gb → gb). The design's no-country case is covered structurally, because the base en-us package ships no pair index. Also test that en-us weights with GB-looking input leave the prior inactive.

### Task 6: Falsifier boards + holdout evals (data + scripts, minimal commits)

1. **Venue-confound board** (≥5k rows): Intersect FSA (600k GB venues) with the index child names, keeping rows whose parent appears in the string. Run them through the full pipeline with the prior on. The bar for window mode is FP = 0. Commit a board sample (~200 rows) and the full-run report. Keep the generator script in the scratchpad and the numbers in the SDD report.
2. **Comma-stripped variants** of gb-golden and nz-suburb-golden: Re-run them in window mode. Recall must stay within 5pp of comma-mode recall.
3. **Pair-holdout:** Rebuild the index without a random 10% of pairs, using builder dev flags `--holdout-seed/--holdout-fraction` or a scratch build. Re-run the boards and record the degradation curve. **The acceptance bars re-anchor to these numbers.**
4. **Out-of-register coverage:** For EPC-derived GB addresses (from the 2026-07-22 acquisition), report the percentage whose (dep-loc, town) pair is in the index. This is a measurement only.

### Task 7: δ calibration + full battery + checkpoint matrix

- Calibrate δ_gb on held-out register rows, sweeping around the calibrated candidate. The rung-3 δ=6.0 is only the prior expectation, and calibration sets the final value. Write the frozen-scale header with the date and numbers, and re-run the builder with the final δ.
- Checkpoint matrix: Run feed-2k and feed-8k as peer options, each with the prior on and the full battery: golden us/fr ±0.7pp, bare-locality ≥0.90, digit adjudication, the 4 dep-loc boards (full pipeline), byte-identical non-GB presets, val ±1.0pp, the 2pp error analysis, and the gauntlet. **The cRT probe (v3.12.0, running) feeds in here.** If it held the emission at 8k, it joins the matrix as a third checkpoint candidate.
- Add the `runtime-flags.mdx` row and the surface-audit paragraph, which says which public surfaces use Viterbi and that `parseWithLogits` exposes raw logits.

### Task 8: Packaging + ship + docs

- Add `pair-index-gb.bin` to `neural-weights-en-gb`: the files array, link-dev-weights, copy-weights, publish.yml, and HF staging. Re-walk the 13-item #1249 audit, and update the README.
- Run the release train per the mailwoman-release skill, with the operator promoting. The demo GB preset lands here.
- Write a research note and an eval-ledger row that includes the census-prior flip-attribution count for the talk. Update memory and SCOPE.

## Pre-registered acceptance

The bars from the rev-2 design §acceptance apply, re-anchored to Task 6.3's holdout numbers. In addition, Task 5's en-gb parse smoke test passes, the trace snapshot test passes with the new kind, and a test (rather than an assertion in prose) shows non-GB byte-identity.

### Task 9: Paired-punctuation audit — quotes, brackets, braces, parens (final task)

**Scope:** Characterize and harden the decode path's handling of paired punctuation at every stage:

1. Tokenizer pieces.
2. `groupPiecesIntoWords`: how its pending-start state machine treats quote and bracket pieces, including word starts with a leading quote and a trailing quote plus comma.
3. The `normalizeFSTToken` fold: quotes are stripped via `\p{P}`. Verify that probeable windows survive quoting.
4. Priors: a quoted venue or place name must still probe.
5. Decoder spans: check whether stray quote or bracket chars leak into component values at span edges through the raw-offset substring extraction in `build-tree`.
6. The formatter round-trip.

**Explicit cases** (table-driven, with a fixture tier and a skipIf-production tier per the Task 4 pattern):

- `"The Grange", Fishburn, Stockton-on-Tees` (quoted venue)
- `12 High St (rear entrance), Leeds` (parenthetical aside)
- `Unit 4 [Block B]` (bracketed designator)
- braces
- curly vs straight quotes (check what NFKC maps them to)
- guillemets «»
- unbalanced pairs, which must fail open without crashing or dropping words

**Checks:** No case crashes. No word is silently dropped (the Task 4 class, so assert that groups are recovered). Span edges do not capture stray paired chars. Characterize any such capture, and fix it if the fix is local to span trimming. Otherwise document it with a rationale. The usual adjudication discipline applies: any "accepted behavior" verdict carries evidence, and anything that drops or mangles input gets fixed rather than documented.

**Sequencing:** This is the final task. It runs after Task 8 and before the arc's whole-branch review, so it audits the shipped configuration.

## Post-plan amendments (2026-07-23)

- The operator added Task 9 (above) during execution. It found and fixed a third production bug class in shared plumbing (tokenizer byte-fallback offset corruption). See the arc PR.
- The pre-registered stop rule (gauntlet metamorphic layer) closed the v3.11.x model lineage. The model path continues in `2026-07-23-v312-comma-robust-recipe.md`. By design, the arc's code ships inactive until a model is promoted.
- The metamorphic invariance mini-suite, an unplanned addition from the five-whys, is now a mandatory probe-level guard.
