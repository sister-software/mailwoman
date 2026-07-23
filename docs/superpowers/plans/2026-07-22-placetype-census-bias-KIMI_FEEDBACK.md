# Kimi feedback — placetype-census decode bias plan

**Date:** 2026-07-22 · **Reviewer:** Kimi · **Scope:** review of `2026-07-22-placetype-census-bias.md`, grounded against repo state @ d27efbf4 (plan, `.superpowers/sdd/task-8-report.md` rungs 1–3, `neural/classifier.ts`, `neural/{fst,query-shape,span-proposal}-prior.ts`, `neural/trace.ts`, the en-gb postmortem).

## Verdict

**Sound design — GO, with seven required changes before task expansion.** The core claim (a two-sided register-pair gate is precise enough to make a soft decode bias viable) is well-supported by rung 3, and the v385 control is exactly the right experiment to prove the gate doesn't manufacture signal. The gaps below are about _where the evidence is circular_, _how the feature plugs into the existing prior stack_, and _three decisions the plan treats as open that the codebase already answers_.

## What the plan gets right

- **Positive-only bias, never a mask** — consistent with house doctrine and with every living prior in `neural/` (query-shape, FST, span-proposal, street-morphology all compose additively and let the encoder veto).
- **Directional (child, parent) match** — the two-sided requirement is doing the real work in the 0.0% FP column, and it structurally handles the "name is a child of A but a parent of B" class. Keep it exactly as specified.
- **δ calibrated per-country, shipped in the artifact header** — matches the frozen-measured-scales precedent (`SpanProposerConfig`, "frozen measured scales").
- **v385 control** — proves the feature's value is coupled to the resurrection weights, which turns out to _answer one of the open questions_ (see NZ below).
- **Sealed-artifact + provenance-header discipline** on the census builder.

## Required changes

### 1. The rung-3 evidence is circular — pre-register a pair-holdout eval

The four dep-loc boards were built to validate the synth-gb/synth-nz shards, which were built from the same PPD/LINZ registers the census is built from. The report says this plainly ("every gold pair is by construction a real entry in the register it was drawn from"), and the plan's acceptance bar — "≥ rung-3 −5pp" — is anchored to that leaked ceiling. Because absence-is-neutral means coverage misses degrade toward the _unbiased_ baseline (which is ~0% correct on dep-loc), production correct-rate ≈ coverage × in-census lift, and production coverage is currently **unmeasured**.

Required before task 4 (calibration + battery):

- Rebuild the GB census with a random k% (suggest 10%) of pairs **held out**, re-run the rung-3 gate, and record the degradation curve. This converts "the ceiling is lower in production" from a caveat into a number.
- Add one out-of-register coverage measurement: the wave-2 EPC×UPRN acquisition (99.99% join, per the postmortem) or OA rows excluded from the census build give real GB addresses whose dep-loc/post-town pairs can be checked against census membership without touching the boards.
- Re-anchor the acceptance bar to the holdout number, not the 100%-coverage number.

### 2. Integration shape: this is a sixth emission prior, not a "decode bias hook"

The classifier already has the exact composition point this design needs — `classifier.ts` `#decode` composes query-shape, FST, street-morphology, and span-proposer priors onto emissions via `addEmissionMatrix` before Viterbi (lines ~573–598). The plan's "decode bias hook" should be specified as:

- A new `neural/placetype-census-prior.ts` returning the standard `[seqLen][numLabels]` log-bias matrix, composed in the same block. Same "encoder stays the authority" semantics, same `matrixHasBias` applied-flag convention.
- A new entry in `TRACE_PRIOR_KINDS` (`trace.ts:28` — currently `["queryShape", "fst", "streetMorphology", "spanProposer", "conventionsMask"]`). This is also the eval-attribution path: flips become attributable to the census prior in traces and the grouper-audit-style reports, which the plan's eval-ledger row will want.
- The probe injected via **structural typing**, exactly like `FSTMatcherLike` / `QueryShapeLike` — `neural/` consumes a `CensusMatcherLike { probe(child, parent): boolean }` shape and never imports the loader. This keeps resolver-free unit tests trivial and matches the zero-dependency comment convention in the existing prior modules.
- Note for the plan's byte-identical-presets acceptance: priors only participate in the Viterbi path; `parseWithLogits` deliberately exposes RAW pre-prior logits ("the model's emissions, not the decode's opinions"). State explicitly which user-facing surfaces take the Viterbi path so "bias ON" doesn't silently no-op somewhere an argmax consumer is served.

### 3. Decode-order open question is already answered in code — downgrade it to a test class

The plan asks whether "a biased B- token + unbiased I- continuation mis-heals." The mechanism: `enforceWordConsistency` votes **over post-prior emissions** (`classifier.ts:674–688` — "every `▁`-delimited word's pieces are forced to ONE tag by a confidence-weighted vote over the post-prior emissions"; visible as the `wordConsistency` repair). So the census bias lands _before_ the vote, and a biased B- plus weakly-scored I- on the same word reconciles at the word level — the heal cannot split a word the bias united. The residual risk class is the inverse: the vote flipping a whole biased word _off_ dep-loc (fine — that's the encoder's veto working) or the span-bridge's crossing constraint interacting with a bias-induced span boundary. Both are test classes, not design tweaks. The plan's task list should say "register the test class" rather than "maybe a design tweak."

### 4. Segmentation: comma-only gating will under-serve the demo; specify word-span windows now

Rung 3's gate required each candidate to be a full comma-delimited segment matching a census entry after fold. Comma-free GB queries ("fishburn stockton on tees") are the common case in real geocode traffic, and the plan lists this as an open question — but there's a stronger default already proven in the same file: `fst-prior.ts` walks **whitespace-delimited word spans** (SentencePiece pieces grouped by the `▁` sentinel, normalized, walked as contiguous subpaths). Specify the census probe the same way: contiguous word-windows (1–N words, N from the PPD CITY length distribution — expect ≤3 to cover ~all of it), same two-sided pair requirement, same fold. This is uniform across comma/comma-free input, reuses a reviewed normalization bridge, and the comma-delimited gate falls out as the special case where a window coincides with a segment.

Cheap pre-measurement, zero GPU: strip commas from the four dep-loc boards, re-run the rung-3 script with window probing. That number, not intuition, should decide whether #727 k-best spans are ever needed. (Prediction: they aren't — the two-sided requirement keeps precision at any window size, and recall is bounded by census coverage, not segmentation.)

### 5. Unknown-country behavior needs an explicit default — and the fallback has a named FP vector

Country-scoped gating is right, but the plan doesn't say what happens when _no_ country context exists (bare query, no postcode anchor, no locale hint) — which is a large share of real traffic. Two options, both defensible, but pick one in the design:

- **No country → no bias** (recommended default). Safe, matches "absence is neutral."
- **Probe all censuses, pair must co-occur within one country's set.** Recall win, but a named FP vector: NZ suburb names reuse GB place names heavily (the colonial-name overlap), so a GB pair can fire on an NZ query — precisely the cross-country confusion the per-country gate exists to prevent. If this fallback is ever enabled, it needs a cross-country-confusables FP board first.

### 6. NZ packaging: the v385 control already answers this — hold NZ

The open question asks whether the NZ census rides the base package or waits for an en-nz overlay. The v385 control measured a census gate on never-resurrected weights: **0.0% NZ / 4.3% GB correct at the identical δ=6.0**. A census without resurrection-trained weights is inert. The base package serves non-resurrected weights, so an NZ census in the base package ships bytes that do nothing. Recommendation: ship GB-only in this train (talk needs GB only), hold the NZ census until NZ resurrection lands, and don't claim NZ in the ship notes — "inert but harmless" is not a feature, it's payload. The NZ rung-3 result still stands as the second-country proof that the _schema_ generalizes, which is its actual job in this arc.

### 7. Normalization: don't invent a fold — reuse the FST bridge's

The plan specifies "lowercase + trim" with a diacritic policy TBD. `fst-prior.ts` already defines the repo's gazetteer-facing token normalization: NFKC, lowercase, strip non-alnum. The census fold should be _that function, single-sourced_ (builder and probe sharing one module, as the plan already requires), so census probing and FST probing can never disagree about whether "Álava" == "Alava" or "stockton-on-tees" == "stockton on tees". Hyphen/space equivalence matters concretely here: PPD is uppercase ASCII, queries are not, and "Stockton-on-Tees" written without hyphens must still fold to the census key. Document the diacritic policy once, in that module, and point the ES equal-value guard discussion at it.

## Smaller notes

- **Naming:** "census" collides with US Census/TIGER vocabulary (`tiger/` workspace, census-tract language throughout the geo pipeline). Name the artifact and module `placetype-pair` / `pair-index` / similar; never the bare word "census" in identifiers.
- **`count` in the schema is currently unused** (presence-only boost). Fine — but say so, and mark it as the future confidence-scaling lever so nobody "finishes the job" mid-implementation (cf. the raw-SQL addendum in AGENTS.md).
- **Artifact header:** add fold-version and schema-version alongside δ, source md5, and build date; the runtime flag should name the minimum schema version it understands. Cheap forward-compat, consistent with sealed-artifact discipline.
- **Checkpoint choice:** the rung-3 table shows feed-8k at δ=6.0 is 95.5% NZ / 100% GB — within the −5pp tolerance of feed-2k's 100/100, with its guards already measured. The digit-FAIL-vs-guards trade the plan frames as feed-2k's risk cuts both ways; the battery deciding is correct, but the decision matrix should include "feed-8k at δ=6 with a slightly lower NZ ceiling" as a first-class option, not a fallback.
- **Perf:** segmentation + hash probes are negligible next to ONNX inference, but state the budget (sub-millisecond per parse, census resident in memory) so it survives review.
- **Multi-word/nested names:** with window probing (change 4), the "Little Whinging cum Hardwick" class becomes a window-size question, answerable from the PPD CITY length distribution — check it during the builder task and record the percentile that N covers.
- **Eval attribution:** with the new `TracePriorKind` (change 2), add a ledger/eval row dimension that reports how many board flips had the census prior `applied: true` — the talk's "decoder reaches into the gazetteer" section will want that number.

## Suggested additions to pre-registered acceptance

1. Pair-holdout sensitivity: census rebuilt minus 10% of pairs; boards re-run; degradation from the full-census number recorded and within a pre-registered floor (the −5pp tolerance re-anchored here, per change 1).
2. Comma-stripped variants of the four dep-loc boards through the full pipeline (the comma-free gap made measurable).
3. Word-consistency interaction test: a biased word whose pieces the vote would split absent the bias stays united; a word the encoder confidently disagrees with stays vetoed.
4. Non-GB/NZ byte-identical presets with flag ON (already in the plan — keep; it's structural but the test is what makes it stay true).
5. Cross-country confusables FP board **iff** the probe-all fallback in change 5 is enabled; otherwise an explicit test that no country context → zero bias applied.

## Answers to the plan's open questions (summary)

| Question                 | Answer                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segmenting               | Word-span windows over the `▁`-grouped pieces (fst-prior pattern), not comma segments; measure with comma-stripped boards before reaching for #727 |
| Decode-order interaction | Already safe by construction (vote is over post-prior emissions); register the two test classes, no design tweak expected                          |
| Checkpoint               | Battery decides, but feed-8k@δ=6.0 (95.5/100) belongs in the decision matrix as a peer, not a fallback                                             |
| NZ packaging             | Hold NZ — v385 control proves census-without-resurrection is inert                                                                                 |
| Multi-word/nested        | Window-size question; N from PPD CITY length percentiles, fold = the FST bridge normalization                                                      |
