# v3.12 — comma-resilient dep-loc recipe (pre-registered proposal, OPERATOR-CONDITIONAL)

**Date:** 2026-07-23 · **Status:** proposal (unlaunched)

**Context:** The v3.11.x lineage is closed for shipping because its stop rule was executed. No checkpoint passes the gauntlet metamorphic layer. The terminal break is that a comma-free US address loses all resolution. That break is byte-stable under damped consolidation (8k and 10k are identical), so it is a learned behavior rather than churn. The five-whys record concludes that the dep-loc extracts are about 100% comma-structured, that training promoted commas toward required boundary evidence, and that comma-free robustness degraded as a result.

## Step 0 — the why-3 verification (before any recipe is written; ~1 hour, zero GPU)

The base recipe inherits v381's punct-drop augmentation. It is unknown whether that augmentation applies to the four new locale extracts, and at what effective share. To verify, (a) read how the augmentation keys are scoped to sources in `data_loader.py` and the config, and (b) sample about 2k rows of the v0.15.0 stream as the loader draws them and count comma-free variants per source. The answer selects the fix:

- **The augmentation does not reach the new extracts:** Fix A extends it to them (config-only).
- **The augmentation reaches them, but its share is too small relative to the new data mass:** Fix B raises the share (one knob, pre-registered).
- **The augmentation reaches them adequately:** This result falsifies the why-3 hypothesis. Stop, because the comma-uniformity theory is wrong, and re-diagnose before spending GPU. The candidate alternative is that the 7850–7950 anomaly is specific to data order, so investigate the extract-pool re-index event first.

## The run (after Step 0 picks A or B)

- Clone v3.11.0-deploc-feed verbatim and add only the Step-0 fix, so the run changes one variable. Use a fresh output dir, 8k steps, and the same seed.
- **Probe-level blocking at 2k is now mandatory.** The invariance mini-suite (`mailwoman eval invariance --baseline v385`) runs at every checkpoint grade rather than at ship time. If the 2k read shows the comma-drop class regressing, stop at probe cost.
- Grade all checkpoints, including odd ones. The 7k checkpoint showed that the save_every 1000 checkpoints need grading.

## Pre-registered acceptance (full set, without reinterpretation)

1. Primary: The gauntlet metamorphic layer shows 0 violations at the selected checkpoint, and the invariance suite shows no new violation classes relative to the v385 baseline profile.
2. GB dep-loc board with prior @ δ=5.0 ≥ 69/69 emit / ≥66 tag-correct, **FP 0 on the gb-golden board's own no-dependent_locality rows**. This bar measures specificity on the golden board itself: the prior must not emit on a row that has no dependent_locality in gold. It is a different number from the venue-confound board's false-positive floor, which is documented separately. On the 6,500-row FSA venue-confound board, the accepted FP rate of the already-shipped artifact is 0.738% (48/6,500) at δ=5.0, and it does not need to be zero. See `eval.venue_confound_fp` in `neural-weights-en-gb/model-card.json`. Keep the two numbers separate. This bar checks that the recipe fix adds no new gb-golden false positives. It does not reopen the venue-confound floor.
3. All operator-ratified bars hold: digit ≥0.755, bare-locality ≥0.90, golden us/fr ±0.7pp, presets byte-identical, error-analysis ≤2pp/tag.
4. Stop rule: This proposal gets one run. If the Step-0-selected fix does not produce a gauntlet-clean checkpoint, the model side moves to a full redesign discussion. The candidates on record are a two-phase LR schedule variant, curriculum ordering, and a study of how augmentation interacts with data mass. This pre-registration allows no knob iteration.

## Cost

Step 0 takes about 1 hour locally. The run takes about 25 min on an A100 (~$1.50), plus export and quantization, plus about 40 min of local grading. The total is about half a day elapsed, mostly unattended.

## What ships when it passes

The arc code that is ready to merge (prior, index, packaging) ships with this model as base 6.7.0, after the Task-8 prep updates the cards and scorecard with the new provenance. The operator then re-ratifies, and the release follows RELEASING.md. The October talk can then cover the resurrection window, the pair prior, the regression the gauntlet caught, and the recipe that fixed it.
