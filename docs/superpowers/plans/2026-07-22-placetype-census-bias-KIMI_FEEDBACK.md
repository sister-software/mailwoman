# Kimi feedback — placetype-census decode bias plan

**Date:** 2026-07-22 · **Reviewer:** Kimi · **Scope:** review of `2026-07-22-placetype-census-bias.md`, grounded against repo state @ d27efbf4 (plan, `.superpowers/sdd/task-8-report.md` rungs 1–3, `neural/classifier.ts`, `neural/{fst,query-shape,span-proposal}-prior.ts`, `neural/trace.ts`, the en-gb postmortem).

## Verdict

**The design is sound. Proceed, with seven required changes before task expansion.** Rung 3 supports the core claim that a two-sided register-pair check is precise enough to make a soft decode bias viable. The v385 control is the right experiment to show that the check does not manufacture signal. The gaps below concern _where the evidence is circular_, _how the feature plugs into the existing prior stack_, and _three decisions the plan treats as open that the codebase already answers_.

## What the plan gets right

- **The bias is positive-only and never a mask.** That matches house doctrine and every active prior in `neural/`: query-shape, FST, span-proposal, and street-morphology all compose additively and let the encoder veto.
- **The (child, parent) match is directional.** The two-sided requirement produces the 0.0% FP column, and it handles the class of names that are a child of A but a parent of B. Keep it exactly as specified.
- **δ is calibrated per country and shipped in the artifact header.** That matches the precedent of frozen measured scales in `SpanProposerConfig`.
- **The v385 control** shows that the feature's value depends on the resurrection weights, which _answers one of the open questions_ (see NZ below).
- **The census builder follows sealed-artifact and provenance-header discipline.**

## Required changes

### 1. The rung-3 evidence is circular — pre-register a pair-holdout eval

The four dep-loc boards were built to validate the synth-gb/synth-nz extracts, and those extracts came from the same PPD/LINZ registers as the census. The report says so ("every gold pair is by construction a real entry in the register it was drawn from"), and the plan's acceptance bar ("≥ rung-3 −5pp") is anchored to that leaked ceiling. Because absent pairs are neutral, a coverage miss falls back to the _unbiased_ baseline, which is about 0% correct on dep-loc. The production correct rate is therefore roughly coverage times the correct rate on pairs that are in the census, and production coverage is currently **unmeasured**.

Required before task 4 (calibration + battery):

- Rebuild the GB census with a random k% (suggest 10%) of pairs **held out**, re-run the rung-3 check, and record the degradation curve. This converts "the ceiling is lower in production" from a caveat into a number.
- Add one out-of-register coverage measurement: the wave-2 EPC×UPRN acquisition (99.99% join, per the postmortem) or OA rows excluded from the census build give real GB addresses whose dep-loc/post-town pairs can be checked against census membership without touching the boards.
- Re-anchor the acceptance bar to the holdout number rather than the 100%-coverage number.

### 2. Integration shape: this is a sixth emission prior rather than a "decode bias hook"

The classifier already has the composition point this design needs. `classifier.ts` `#decode` adds the query-shape, FST, street-morphology, and span-proposer priors to the emissions via `addEmissionMatrix` before Viterbi (lines ~573–598). Specify the plan's "decode bias hook" as follows:

- A new `neural/placetype-census-prior.ts` returns the standard `[seqLen][numLabels]` log-bias matrix and is composed in the same block. It keeps the same semantics, where the encoder stays the authority, and the same `matrixHasBias` applied-flag convention.
- A new entry goes in `TRACE_PRIOR_KINDS` (`trace.ts:28`, currently `["queryShape", "fst", "streetMorphology", "spanProposer", "conventionsMask"]`). This entry is also the eval-attribution path. Traces and grouper-audit-style reports can then attribute flips to the census prior, which the plan's eval-ledger row will need.
- The probe is injected through **structural typing**, exactly like `FSTMatcherLike` and `QueryShapeLike`. `neural/` consumes a `CensusMatcherLike { probe(child, parent): boolean }` shape and never imports the loader. That keeps unit tests free of a resolver and matches the zero-dependency comment convention in the existing prior modules.
- A note for the plan's byte-identical-presets acceptance: Priors participate only in the Viterbi path. `parseWithLogits` deliberately exposes raw pre-prior logits ("the model's emissions rather than the decode's opinions"). State which user-facing surfaces take the Viterbi path, so that turning the bias on cannot silently do nothing where an argmax consumer is served.

### 3. Decode-order open question is already answered in code — downgrade it to a test class

The plan asks whether "a biased B- token + unbiased I- continuation mis-heals." `enforceWordConsistency` votes **over post-prior emissions** (`classifier.ts:674–688`: "every `▁`-delimited word's pieces are forced to one tag by a confidence-weighted vote over the post-prior emissions", visible as the `wordConsistency` repair). The census bias therefore lands _before_ the vote. A biased B- and a weakly scored I- on the same word are reconciled at the word level, so the heal cannot split a word that the bias united. The remaining risks run the other way. The vote could flip a whole biased word _off_ dep-loc, which is acceptable because it is the encoder's veto working. The span-bridge's crossing constraint could also interact with a span boundary that the bias introduced. Both are test classes rather than design changes. The plan's task list should say "register the test class" rather than "maybe a design tweak."

### 4. Segmentation: comma-only blocking will under-serve the demo; specify word-span windows now

Rung 3's check required each candidate to be a full comma-delimited segment that matches a census entry after the fold. Comma-free GB queries ("fishburn stockton on tees") are the common case in real geocode traffic. The plan lists this as an open question, but a stronger default is already proven in the same codebase. `fst-prior.ts` walks **whitespace-delimited word spans**: it groups SentencePiece pieces by the `▁` sentinel, normalizes them, and walks them as contiguous subpaths. Specify the census probe the same way. Use contiguous word windows of 1–N words, with N taken from the PPD CITY length distribution (N ≤3 should cover nearly all of it). Keep the same two-sided pair requirement and the same fold. Windows behave the same on comma and comma-free input and reuse a reviewed normalization bridge. The comma-delimited check becomes the special case where a window coincides with a segment.

A cheap pre-measurement needs no GPU. Strip commas from the four dep-loc boards and re-run the rung-3 script with window probing. That number, rather than intuition, should decide whether #727 k-best spans are ever needed. My prediction is that they are not. The two-sided requirement keeps precision at any window size, and census coverage bounds recall more than segmentation does.

### 5. Unknown-country behavior needs an explicit default — and the fallback has a named FP vector

Country-scoped blocking is right, but the plan does not say what happens when _no_ country context exists (a bare query without a postcode anchor or locale hint). Such queries are a large share of real traffic. Both options below are defensible, and the design should pick one:

- **Without country context, apply no bias** (recommended default). This option is safe and matches the rule that absence is neutral.
- **Probe all censuses, and require the pair to co-occur within one country's set.** This option improves recall but has a known FP source. NZ suburb names heavily reuse GB place names, so a GB pair can fire on an NZ query. That is exactly the cross-country confusion that the per-country check exists to prevent. If this fallback is ever enabled, it first needs a cross-country-confusables FP board.

### 6. NZ packaging: the v385 control already answers this — hold NZ

The open question asks whether the NZ census ships in the base package or waits for an en-nz overlay. The v385 control measured a census check on weights that were never resurrection-trained: **0.0% NZ / 4.3% GB correct at the identical δ=6.0**. A census without resurrection-trained weights has no effect. The base package serves non-resurrected weights, so an NZ census in the base package would ship bytes that do nothing. I recommend shipping GB only in this release train, since the talk needs only GB. Hold the NZ census until NZ resurrection lands, and do not claim NZ in the release notes. A census that has no effect adds payload without adding a feature. The NZ rung-3 result still shows, in a second country, that the _schema_ generalizes, which is its purpose in this arc.

### 7. Normalization: don't invent a fold — reuse the FST bridge's

The plan specifies "lowercase + trim" with a diacritic policy still to be decided. `fst-prior.ts` already defines the repo's gazetteer-facing token normalization: NFKC, lowercase, and strip non-alnum. The census fold should be _that function, from a single source_, with the builder and probe sharing one module as the plan already requires. Census probing and FST probing then cannot disagree about whether "Álava" == "Alava" or "stockton-on-tees" == "stockton on tees". Hyphen/space equivalence matters here in practice. PPD is uppercase ASCII and queries are not, and "Stockton-on-Tees" written without hyphens must still fold to the census key. Document the diacritic policy once, in that module, and point the ES equal-value guard discussion at it.

## Smaller notes

- **Naming:** "census" collides with US Census/TIGER vocabulary, such as the `tiger/` workspace and the census-tract terms used throughout the geo pipeline. Name the artifact and module `placetype-pair`, `pair-index`, or similar, and never use the bare word "census" in identifiers.
- **`count` in the schema is currently unused**, because the boost is presence-only. That is fine, but say so. Mark it as reserved for future confidence scaling so that nobody implements the scaling mid-implementation (cf. the raw-SQL addendum in AGENTS.md).
- **Artifact header:** Add fold-version and schema-version alongside δ, source md5, and build date. The runtime flag should declare the minimum schema version it understands. This forward compatibility is cheap and consistent with sealed-artifact discipline.
- **Checkpoint choice:** The rung-3 table shows feed-8k at δ=6.0 scoring 95.5% NZ / 100% GB. That is within the −5pp tolerance of feed-2k's 100/100, and feed-8k's guards are already measured. The plan frames the trade between the digit failure and the guards as feed-2k's risk, but the same trade applies to feed-8k. Letting the battery decide is correct, but the decision matrix should include "feed-8k at δ=6 with a slightly lower NZ ceiling" as a first-class option rather than a fallback.
- **Perf:** Segmentation and hash probes cost almost nothing next to ONNX inference. State the budget anyway (sub-millisecond per parse, census resident in memory) so that it holds up in review.
- **Multi-word and nested names:** With window probing (change 4), names like "Little Whinging cum Hardwick" become a window-size question that the PPD CITY length distribution can answer. Check it during the builder task and record the percentile that N covers.
- **Eval attribution:** With the new `TracePriorKind` (change 2), add a ledger or eval row dimension that reports how many board flips had the census prior `applied: true`. The talk's "decoder reaches into the gazetteer" section will need that number.

## Suggested additions to pre-registered acceptance

1. Pair-holdout sensitivity: Rebuild the census without 10% of its pairs and re-run the boards. Record the degradation from the full-census number, and require it to stay within a pre-registered floor (the −5pp tolerance, re-anchored here per change 1).
2. Run comma-stripped variants of the four dep-loc boards through the full pipeline, which makes the comma-free gap measurable.
3. Word-consistency interaction test: A biased word whose pieces the vote would split without the bias stays united. A word that the encoder confidently disagrees with stays vetoed.
4. Non-GB/NZ presets stay byte-identical with the flag on. The plan already includes this, so keep it. The property is structural, but the test keeps it true.
5. Add a cross-country confusables FP board **if and only if** the probe-all fallback in change 5 is enabled. Otherwise, add an explicit test that inputs without country context get zero bias.

## Answers to the plan's open questions (summary)

| Question                 | Answer                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segmenting               | Word-span windows over the `▁`-grouped pieces (fst-prior pattern) rather than comma segments; measure with comma-stripped boards before reaching for #727 |
| Decode-order interaction | Already safe by construction (vote is over post-prior emissions); register the two test classes without expecting a design change                         |
| Checkpoint               | Battery decides, but feed-8k@δ=6.0 (95.5/100) belongs in the decision matrix as a peer rather than a fallback                                             |
| NZ packaging             | Hold NZ — v385 control proves census-without-resurrection is inert                                                                                        |
| Multi-word/nested        | Window-size question; N from PPD CITY length percentiles, fold = the FST bridge normalization                                                             |
