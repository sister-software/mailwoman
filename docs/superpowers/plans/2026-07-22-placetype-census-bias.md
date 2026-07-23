# Placetype-pair decode prior — design + plan (rev 2, post-review)

**Date:** 2026-07-22 · **Status:** reviewed design (DeepSeek Pro ×2 turns + Kimi repo-grounded review — `2026-07-22-placetype-census-bias-KIMI_FEEDBACK.md`), pre-task-expansion · **Supersedes:** rev 1 and the morning fork (A–D) from the night postmortem.

**Naming note (Kimi):** the artifact/module family is **placetype-pair** (`pair-index`, `placetype-pair-prior`) — never bare "census" in identifiers (US Census/TIGER collision). This doc's filename keeps the original slug for continuity.

## The idea in one paragraph

The decoder consults the gazetteer _as it parses_: candidate word-spans of the input are probed against a precomputed **index of (child-place, parent-place) pairs** built from authoritative registers (PPD for GB; LINZ for NZ later). A two-sided hit — child span + parent span co-occurring in the same input, pair present in the country's index — adds a calibrated log-bias δ to the corresponding tag's emissions before Viterbi. Presence boosts; absence is neutral (positive evidence only — register absence is coverage gap, not fact). This surfaces a placetype's _conditional_ prevalence ("this parent has children of this type") to a small model at decode time — the structural information giant parsers buy with parameters.

## Evidence (zero-GPU ladder on frozen checkpoints; full record `.superpowers/sdd/task-8-report.md`)

| Rung | Gate                                     | Best GB (correct/FP)                             | Verdict                                    |
| ---- | ---------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| 1    | flat δ                                   | 62% / 26%                                        | signal present, precision unusable         |
| 2    | name-in-country set (WOF)                | 49% / 20%                                        | FP 100→20; WOF coverage caps GB 52%, NZ 0% |
| 3    | **(child, parent) pair, register-built** | **100% / 0.0%** (δ=6.0; NZ 100%/0.0% on feed-2k) | GO — 0.0% FP in every cell                 |

- v385 control ≈ 0 at every rung → the resurrection-trained weights are a required ingredient; bias and weights compound.
- ⚠ **Rung-3 numbers are a leaked ceiling** (Kimi #1): boards and index share source registers → 100% coverage by construction. Production correct-rate ≈ coverage × in-index lift. The pair-holdout eval (below) re-anchors every acceptance bar.
- Index sizes: GB 19,431 pairs, NZ 3,135 pairs — few hundred KB.

## Design decisions (settled; reviewer-adopted changes marked)

1. **Sources = the registers**, WOF as contributor later; provenance-tracked snapshots.
2. **Soft additive bias, never a mask.** Composed as **the sixth emission prior** at the existing `addEmissionMatrix` pre-Viterbi slot in `classifier.ts#decode`, alongside query-shape/FST/street-morphology/span-proposer/conventions (Kimi #2) — NOT a bespoke hook. New `neural/placetype-pair-prior.ts` returns the standard `[seqLen][numLabels]` log-bias matrix; `matrixHasBias` applied-flag convention; new `TRACE_PRIOR_KINDS` entry for flip attribution; probe injected via structural typing (`PairIndexLike { probe(child, parent): boolean }`), loader never imported by `neural/` internals.
3. **Segmentation = word-span windows** over the `▁`-grouped pieces, the `fst-prior.ts` walk pattern (Kimi #4) — uniform across comma/comma-free input; the comma-segment gate is the degenerate case. Window N from the PPD CITY length distribution (measure in the builder task; expect ≤3). **Window-mode enablement gates on the venue-confound board** (DeepSeek): FP = 0 on ≥5k confounds built from FSA/CQC venue names colliding with index child names; plus a marker-suppression filter (child span followed by "House"/"Road"/"Flat"-class structural markers → no bias). If the confound board fails: comma-segments-only v1 (zero-FP by construction), window mode behind the flag.
4. **δ is flat per-country, calibrated** (p-style from held-out register rows), shipped in the artifact header. **No model-veto parameter** (DeepSeek turn 2: a veto fights exactly the deficit the bias compensates — either kills deep-buried recall or is toothless). The encoder's veto is the existing prior-composition semantics + word-consistency vote over post-prior emissions.
5. **Country scoping is hard**: index selected by locale/postcode-anchor context; **no country context → no bias** (Kimi #5, explicit test). Probe-all fallback NOT enabled (colonial-name overlap = named FP vector; would require a cross-country confusables board first).
6. **Normalization single-sourced from the FST bridge fold** (NFKC, lowercase, strip non-alnum — hyphen/space equivalence included); builder and probe share the module (Kimi #7). Diacritic policy documented there; ES equal-value guard discussion points at it.
7. **Schema is tag-typed**: (child, parent, placetype_tag, count). `count` is UNUSED v1 (presence-only) — reserved as the future confidence-scaling lever; do not "finish the job" mid-implementation.
8. **GB-only this train; NZ held** (Kimi #6): the v385 control proves index-without-resurrected-weights is inert, and the base package serves non-resurrected weights — an NZ index there is dead payload. NZ rung-3 stands as the schema-generalization proof.
9. **Artifact header**: δ_country, source snapshot md5s, build date, fold-version, schema-version; the runtime flag names its minimum understood schema version. Sealed-artifact discipline.
10. **Surface audit** (Kimi #2 note): priors ride the Viterbi path only; `parseWithLogits` exposes raw pre-prior logits by contract. Enumerate which user-facing surfaces take which path so flag-ON cannot silently no-op.

## Resolved questions (were open in rev 1)

| Question                 | Resolution                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segmenting               | word-span windows (fst-prior pattern); comma-stripped board re-run decides empirically; #727 k-best predicted unnecessary (Kimi pre-registered prediction — test, don't assume) |
| Decode-order interaction | safe by construction (heal votes over post-prior emissions); two registered TEST classes: bias-united word stays united; encoder-confident word stays vetoed                    |
| Checkpoint               | full battery decides; **feed-8k @ δ=6.0 (95.5/100, guards measured) is a peer option**, not a fallback to feed-2k (100/100, guards partial, digit trade cuts both ways)         |
| NZ packaging             | hold (see decision 8)                                                                                                                                                           |
| Multi-word names         | window-size percentile question, answered in the builder task                                                                                                                   |

## Parallel training-side experiment (DeepSeek's surviving recommendation)

**cRT probe** (config-only, ~5 min GPU): `freeze_encoder: true` + hot classifier LR + dep-loc-heavy stream, 2k→8k. Pre-registered: does classifier-only + balanced stream hold emission WITHOUT re-burial at 8k? If yes → better base weights, smaller δ, less bias dependence; composes with (never replaces) the pair prior. DeepSeek's "cRT recovers the window" is a logged hypothesis, not a gate.

## Plan (tasks; expand to TDD step level next)

1. **Pair-index builder** — `mailwoman gazetteer pair-index`: register sources → per-country sealed artifacts; PPD CITY length distribution measured here (sets window N); provenance header per decision 9.
2. **Index loader + probe** — weights-package sibling resolution (postcode-bin pattern); shared fold module with the builder; `PairIndexLike` structural type.
3. **`placetype-pair-prior.ts`** — the sixth emission prior + `TRACE_PRIOR_KINDS` entry + runtime flag (SCOPE register; default OFF until battery); marker-suppression filter; no-country → zero-bias path + test.
4. **Boards + falsifiers** — venue-confound board (FSA/CQC × index child names, ≥5k, FP=0 bar for window mode); comma-stripped variants of the four dep-loc boards; pair-holdout (10%) index rebuild + degradation curve; out-of-register coverage vs EPC; word-consistency + span-bridge interaction test classes.
5. **δ calibration + full battery + checkpoint selection** — bars re-anchored to the holdout numbers; battery incl. non-GB byte-identical presets flag-ON, 2pp error-analysis, gauntlet. cRT probe result folds in here if it landed.
6. **Packaging + ship train** — GB index into `@mailwoman/neural-weights-en-gb`; release-path wiring per the #1249 checklist; CI release; demo GB preset + redeploy.
7. **Docs + talk** — SCOPE flag register, research note, eval-ledger row incl. the census-prior flip-attribution count (the talk's number).

## Pre-registered acceptance (rev 2 — re-anchored per Kimi #1)

1. Pair-holdout sensitivity: boards re-run against the 90% index; degradation recorded; the production bar anchors to THIS number (rev-1's "rung-3 −5pp" is void — leaked ceiling).
2. Comma-stripped boards through the full pipeline: the comma-free gap measured; window mode ships only if confound board FP=0 AND comma-stripped recall ≥ comma-mode recall −5pp.
3. Word-consistency interaction tests per the two registered classes.
4. Non-GB outputs byte-identical with flag ON (structural test), no-country → zero bias (explicit test).
5. Full battery: us/fr golden ±0.7pp, bare-locality ≥0.90, digit adjudicated in the checkpoint matrix, presets, val ±1.0pp, no tag >2pp down vs v385, gauntlet PASS. Promotion = operator's act.
