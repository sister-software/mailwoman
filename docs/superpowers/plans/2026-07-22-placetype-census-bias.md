# Placetype-pair decode prior — design + plan (rev 2, post-review)

**Date:** 2026-07-22 · **Status:** reviewed design (DeepSeek Pro ×2 turns + a Kimi repo-grounded review), pre-task-expansion · **Supersedes:** rev 1 and the morning fork (A–D) from the night postmortem.

**Naming note (Kimi):** The artifact and module family is called **placetype-pair** (`pair-index`, `placetype-pair-prior`). Identifiers never use bare "census", because that word collides with US Census/TIGER. This doc's filename keeps the original slug for continuity.

## The idea in one paragraph

The decoder consults the gazetteer _as it parses_. It probes candidate word-spans of the input against a precomputed **index of (child-place, parent-place) pairs** built from authoritative registers (PPD for GB, and LINZ for NZ later). A two-sided hit occurs when a child span and a parent span appear in the same input and the pair is present in the country's index. A hit adds a calibrated log-bias δ to the corresponding tag's emissions before Viterbi. A present pair boosts the tag, and an absent pair is neutral. The prior uses positive evidence only, because a pair missing from a register reflects a coverage gap rather than a fact. The prior gives a small model a placetype's _conditional_ prevalence ("this parent has children of this type") at decode time. Large parsers store that structural information in their parameters.

## Evidence (zero-GPU ladder on frozen checkpoints; full record `.superpowers/sdd/task-8-report.md`)

| Rung | Check                                    | Best GB (correct/FP)                             | Verdict                                    |
| ---- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| 1    | flat δ                                   | 62% / 26%                                        | signal present, precision unusable         |
| 2    | name-in-country set (WOF)                | 49% / 20%                                        | FP 100→20; WOF coverage caps GB 52%, NZ 0% |
| 3    | **(child, parent) pair, register-built** | **100% / 0.0%** (δ=6.0; NZ 100%/0.0% on feed-2k) | GO — 0.0% FP in every cell                 |

- The v385 control stays near 0 at every rung, so the resurrection-trained weights are a required ingredient. The bias and the weights compound.
- ⚠ **The rung-3 numbers are a leaked ceiling** (Kimi #1). The boards and the index share source registers, so coverage is 100% by construction. The production correct rate is roughly coverage times the correct rate on pairs that are in the index. The pair-holdout eval (below) re-anchors every acceptance bar.
- Index sizes: GB has 19,431 pairs and NZ has 3,135 pairs, a few hundred KB in total.

## Design decisions (settled; reviewer-adopted changes marked)

1. **The registers are the sources.** WOF becomes a contributor later. Snapshots are provenance-tracked.
2. **The bias is soft and additive, never a mask.** It is composed as **the sixth emission prior** at the existing `addEmissionMatrix` pre-Viterbi slot in `classifier.ts#decode`, alongside the query-shape, FST, street-morphology, span-proposer, and conventions priors (Kimi #2). It does not use a bespoke hook.
   - New `neural/placetype-pair-prior.ts` returns the standard `[seqLen][numLabels]` log-bias matrix and follows the `matrixHasBias` applied-flag convention.
   - A new `TRACE_PRIOR_KINDS` entry supports flip attribution.
   - The probe is injected through structural typing (`PairIndexLike { probe(child, parent): boolean }`). Code inside `neural/` never imports the loader.
3. **Segmentation uses word-span windows** over the `▁`-grouped pieces, following the `fst-prior.ts` walk pattern (Kimi #4). Windows behave the same for comma and comma-free input, and the comma-segment check is the degenerate case. Window size N comes from the PPD CITY length distribution, which the builder task measures (expected ≤3).
   - **Window mode is enabled only if it passes the venue-confound board** (DeepSeek). The bar is FP = 0 on at least 5k confounds built from FSA/CQC venue names that collide with index child names.
   - A marker-suppression filter adds no bias when a child span is followed by a structural marker such as "House", "Road", or "Flat".
   - If the confound board fails, v1 ships comma-segments-only mode, which has zero FP by construction, and window mode stays behind the flag.
4. **δ is flat per country and calibrated** (p-style, from held-out register rows). It ships in the artifact header. **There is no model-veto parameter.** In DeepSeek's turn 2, a veto would fight the very deficit the bias compensates for, so it would either kill deeply buried recall or have no effect. The encoder's veto comes from the existing prior-composition semantics and the word-consistency vote over post-prior emissions.
5. **Country scoping is strict.** Locale or postcode-anchor context selects the index. **Without country context, the prior adds no bias** (Kimi #5, covered by an explicit test). A probe-all fallback stays disabled. Place names shared across former colonies are a known FP source, and enabling it would first require a cross-country confusables board.
6. **Normalization comes from one source, the FST bridge fold** (NFKC, lowercase, strip non-alnum, including hyphen/space equivalence). The builder and the probe share that module (Kimi #7). The module documents the diacritic policy, and the ES equal-value guard discussion refers to it.
7. **The schema is tag-typed**: (child, parent, placetype_tag, count). v1 does not use `count`, because it is presence-only. The field is reserved for future confidence scaling. Do not implement that scaling during this work.
8. **This release train ships GB only, and NZ is held** (Kimi #6). The v385 control shows that the index has no effect without resurrected weights, and the base package serves non-resurrected weights. An NZ index in that package would be unused payload. The NZ rung-3 result (100%/0.0% on feed-2k) shows that the schema generalizes to a second country.
9. **The artifact header** holds δ_country, source snapshot md5s, build date, fold version, and schema version. The runtime flag declares the minimum schema version it understands. The artifact follows sealed-artifact discipline.
10. **Surface audit** (Kimi #2 note): Priors apply on the Viterbi path only, and `parseWithLogits` exposes raw pre-prior logits by design. List which user-facing surfaces take which path, so that turning the flag on cannot silently do nothing.

## Resolved questions (were open in rev 1)

| Question                 | Resolution                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segmenting               | word-span windows (fst-prior pattern); comma-stripped board re-run decides empirically; #727 k-best predicted unnecessary (Kimi pre-registered prediction — test, don't assume)   |
| Decode-order interaction | safe by construction (heal votes over post-prior emissions); two registered TEST classes: bias-united word stays united; encoder-confident word stays vetoed                      |
| Checkpoint               | full battery decides; **feed-8k @ δ=6.0 (95.5/100, guards measured) is a peer option** rather than a fallback to feed-2k (100/100, guards partial, digit trade reduces both ways) |
| NZ packaging             | hold (see decision 8)                                                                                                                                                             |
| Multi-word names         | window-size percentile question, answered in the builder task                                                                                                                     |

## Parallel training-side experiment (DeepSeek's surviving recommendation)

**cRT probe** (config-only, ~5 min GPU): Run 2k→8k with `freeze_encoder: true`, a hot classifier LR, and a dep-loc-heavy stream. The pre-registered question is whether classifier-only training on a balanced stream keeps the dep-loc emission at 8k without burying it again. If it does, the result gives better base weights, a smaller δ, and less dependence on the bias. It would compose with the pair prior and never replace it. DeepSeek's claim that cRT recovers the window is logged as a hypothesis rather than as a check.

## Plan (tasks; expand to TDD step level next)

1. **Pair-index builder:** `mailwoman gazetteer pair-index` turns register sources into per-country sealed artifacts. This task measures the PPD CITY length distribution, which sets window N. The artifact carries the provenance header from decision 9.
2. **Index loader and probe:** The loader resolves the index as a weights-package sibling (the postcode-bin pattern). It shares the fold module with the builder and exposes the `PairIndexLike` structural type.
3. **`placetype-pair-prior.ts`:** Add the sixth emission prior, a `TRACE_PRIOR_KINDS` entry, and a runtime flag in the SCOPE register (default off until the battery passes). Add the marker-suppression filter and the zero-bias path for inputs without country context, with a test.
4. **Boards and falsifiers:**
   - A venue-confound board (FSA/CQC names crossed with index child names, ≥5k rows, FP=0 bar for window mode).
   - Comma-stripped variants of the four dep-loc boards.
   - A pair-holdout index rebuild (10% held out) and its degradation curve.
   - Out-of-register coverage measured against EPC.
   - Test classes for the word-consistency and span-bridge interactions.
5. **δ calibration, full battery, and checkpoint selection:** Re-anchor the bars to the holdout numbers. The battery includes byte-identical non-GB presets with the flag on, the 2pp error analysis, and the gauntlet. The cRT probe result feeds in here if it has landed.
6. **Packaging and release train:** Put the GB index into `@mailwoman/neural-weights-en-gb`, wire the release path per the #1249 checklist, release through CI, and add and redeploy the demo GB preset.
7. **Docs and talk:** Add the SCOPE flag register entry, a research note, and an eval-ledger row that includes the census-prior flip-attribution count, which is the number the talk uses.

## Pre-registered acceptance (rev 2 — re-anchored per Kimi #1)

1. Pair-holdout sensitivity: Re-run the boards against the 90% index and record the degradation. The production bar anchors to this number. Rev 1's "rung-3 −5pp" bar is void, because rung 3 is a leaked ceiling.
2. Comma-stripped boards through the full pipeline: Measure the comma-free gap. Window mode ships only if the confound board has FP=0 and comma-stripped recall is at least comma-mode recall −5pp.
3. Word-consistency interaction tests cover the two registered classes.
4. Non-GB outputs stay byte-identical with the flag on (structural test), and inputs without country context get zero bias (explicit test).
5. Full battery: us/fr golden ±0.7pp, bare-locality ≥0.90, digit adjudicated in the checkpoint matrix, presets, val ±1.0pp, every tag within 2pp of v385, and a gauntlet pass. Promotion is the operator's decision.
