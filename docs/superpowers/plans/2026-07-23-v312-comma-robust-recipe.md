# v3.12 — comma-robust dep-loc recipe (pre-registered proposal, OPERATOR-GATED)

**Date:** 2026-07-23 · **Status:** proposal, NOT launched · **Context:** the v3.11.x lineage is closed for shipping (stop rule executed): no checkpoint passes the gauntlet metamorphic layer; the terminal break — comma-free US address → total resolution loss — is byte-stable under damped consolidation (8k ≡ 10k), i.e. a learned behavior, not churn. Five-whys record: the dep-loc shards are ~100% comma-structured; commas were promoted toward load-bearing boundary evidence; comma-free robustness paid the bill.

## Step 0 — the why-3 verification (BEFORE any recipe is written; ~1 hour, zero GPU)

The base recipe inherits v381's punct-drop augmentation. Unknown: does it apply to the four NEW locale shards, and at what effective share? Verify by (a) reading the augmentation keys' source-scoping in `data_loader.py`/config, (b) sampling ~2k rows of the v0.15.0 stream as the loader draws them and counting comma-free variants per source. The answer picks the fix:

- **Aug doesn't reach the new shards** → Fix A: extend it to them (config-only).
- **Aug reaches them but share too small vs the new mass** → Fix B: raise the share (one knob, pre-registered).
- **Aug reaches them adequately** (falsifies the why-3 hypothesis) → STOP; the comma-uniformity theory is wrong; re-diagnose before spending GPU (candidate alternate: the 7850–7950 anomaly is data-order-specific — investigate the shard-pool re-index event first).

## The run (after Step 0 picks A or B)

- Clone v3.11.0-deploc-feed verbatim + ONLY the Step-0 fix (one variable). Fresh output dir. 8k, same seed.
- **Probe-level gating at 2k** (the process fix, now mandatory): the invariance mini-suite (`mailwoman eval invariance --baseline v385`) runs at EVERY checkpoint grade, not at ship time. A 2k read showing the comma-drop class regressing = stop at probe cost.
- Grade ALL checkpoints incl. odd ones (the 7k lesson: save_every 1000 exists to be used).

## Pre-registered acceptance (full set, no reinterpretation)

1. PRIMARY: gauntlet metamorphic layer = 0 violations at the selected checkpoint; invariance suite shows NO new violation classes vs the v385 baseline profile.
2. GB dep-loc board with prior @ δ=5.0 ≥ 69/69 emit / ≥66 tag-correct, FP 0 (the prior carries this — the bar guards against recipe collateral).
3. All operator-ratified bars: digit ≥0.755, bare-locality ≥0.90, golden us/fr ±0.7pp, presets byte-identical, error-analysis ≤2pp/tag.
4. STOP RULE: one run. If the Step-0-selected fix doesn't produce a gauntlet-clean checkpoint, the model side goes to a full redesign discussion (candidates on record: two-phase LR schedule variant; curriculum ordering; the augmentation-vs-mass interaction study) — no knob iteration inside this pre-registration.

## Cost

Step 0 ≈ 1 hour local. The run ≈ 25 min A100 (~$1.50) + export/quantize + ~40 min local grading. Total ≈ half a day elapsed, mostly unattended.

## What ships when it passes

The already-merged-ready arc code (prior, index, packaging) + this model as base 6.7.0 (Task-8 prep cards/scorecard update with the new provenance) → operator re-ratification → release train per RELEASING.md. The October talk then has the full story: resurrection window, the pair prior, the gauntlet catch, and the recipe that closed it.
