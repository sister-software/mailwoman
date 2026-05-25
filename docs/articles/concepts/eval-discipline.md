---
sidebar_position: 15
title: Eval discipline — reading the numbers honestly
tags:
  - concepts
  - eval
  - training
---

# Eval discipline — reading the numbers honestly

Mailwoman's eval methodology learned its most important lessons the hard way — from shipping two model versions that regressed on headline F1 but told a different story when the failures were examined properly. This article documents the discipline: what to measure, what not to trust, and how to read a model release report.

## Why aggregate F1 is misleading

Per-component F1 scores are the standard metric for sequence-labelling models. A table like this looks authoritative:

| Component    | v0.4.0 | v0.3.0 | Δ         |
| ------------ | ------ | ------ | --------- |
| country      | 0.21   | 0.28   | **−0.07** |
| region       | 0.19   | 0.18   | +0.01     |
| locality     | 0.27   | 0.27   | flat      |
| postcode     | 0.69   | 0.76   | **−0.07** |
| street       | 0.30   | 0.27   | +0.03     |
| house_number | 0.79   | 0.78   | +0.01     |

The easy reading: v0.4.0 regressed on country and postcode. Ship the previous version.

The honest reading, after bucketing the 1,217 postcode false-negatives and 194 country false-negatives into failure categories, reveals that the headline regressions are mostly **eval artifacts**, not real model degradation.

## The false-negative bucketing methodology

For every component where F1 moves more than a few points between releases, manually inspect a sample of the disagreements between the model's prediction and the golden-set label. Categorize each failure into buckets. The buckets will typically fall into a few patterns:

### Pattern 1: Adversarial eval entries

The golden set contains entries chosen specifically to break the parser — multi-script addresses, ambiguous locality names, prefix-honorific homographs. If the model has a known limitation (e.g., the v0.1.0 tokenizer's byte-fallback on non-Latin scripts) and the golden set includes entries that exercise that limitation, then F1 deltas on those entries are measuring **whether the limitation got fixed**, not whether the new weights are better or worse.

In v0.4.0's case, 92% of the country false-negatives were adversarial transliteration entries:

```
بار نون وایومینگ, Wyoming, United States of America   →  pred: "yoming, United Sta"
サーモポリス, WY, United States of America              →  pred: ", WY, United State"
```

The model was never trained to handle these cases. The v0.4.0 weights didn't change the behaviour on this slice — the regression was the golden set holding v0.4.0 accountable for v0.3.0's known failure modes. After excluding adversarial inputs, country false-negatives dropped from 194 to roughly 16.

**The discipline:** report F1 both with and without known-adversarial slices. The "with" number is the honest ceiling; the "without" number is the signal for whether the recipe changed anything real.

### Pattern 2: Empty predictions

When the model emits nothing for a component that the golden set expects, the failure is usually a training-distribution effect — the model learned a positional prior that doesn't apply to the eval set.

In v0.4.0, 65% of postcode false-negatives were empty predictions on mid-position postcodes like `Paris 75008`. The NAD downweight (the most aggressive change in the source rebalance) removed "postcode-first" positional patterns from the training mix. The model learned to tag mid-position numeric tokens as `house_number` instead of `postcode`.

This is a real regression — the recipe change had an unintended side effect — but it's a training-data distribution problem, not a model architecture problem. It suggests a targeted fix (bump NAD weight back up, synthesize component-order permutations) rather than a rollback.

### Pattern 3: Label confusion

The model picks the wrong label for a span. In v0.4.0, 11% of postcode false-negatives were house-number confusion: `47110 Sainte-Livrade-sur-Lot, 22 Rue Jasmin` → the model predicted `22` as postcode instead of the leading `47110`.

These are genuine model errors. They suggest the label vocabulary is ambiguous for numeric tokens in certain positions.

### Pattern 4: Span boundary slip

The model gets the label right but the span wrong. In v0.4.0, 6% of postcode false-negatives were boundary-slip cases: `LE TRÉPORT, 76470` → model predicted `", 7647"` for postcode. The tag was correct (`postcode`) but the span included the preceding comma and space, and sometimes truncated the final digit.

This is a decoder problem, not a model problem — no retraining required. The fix (trimming spans past leading/trailing non-word characters) landed in the decoder without touching the model weights.

**The discipline:** always ask whether the failure is a model problem or a decoder problem. Decoder fixes are cheap and don't require a retrain. Many "model regressions" turn out to be decoder bugs on closer inspection.

## Golden-set hygiene

The golden eval set (`v0.1.2`, 4,535 entries) is the single most important artifact in the eval pipeline. A few rules:

- **Adversarial entries belong in their own slice.** Report F1 with and without them. The adversarial slice is a stress test, not a release gate.
- **Golden-set versions are pinned.** Every eval report references a specific golden-set version. If the golden set is expanded, the old reports are not retroactively recomputed — that would falsify the historical record.
- **Annotation noise is real.** At typical 1% annotator error rates in human-labeled NER data, a 0.5–1.5pt macro_F1 shift can be noise. When a regression lands in this band, manually inspect the disagreement entries before deciding.
- **Small eval sets amplify noise.** 4,535 entries means a 1pt macro_F1 regression is ~45 flipped entries. At 1% annotator error, the false-positive rate on "regression detected" is ~10%.

## Verdict smokes and eval infrastructure

A separate but related discipline surrounds training experiments. See [`VERDICT_SMOKES.md`](../plan/reference/VERDICT_SMOKES.md) for the full framework. The eval-relevant lessons:

- **Constant-LR smokes, not cosine.** Cosine decay hides divergence under a near-zero learning rate. A verdict smoke that uses cosine decay will report "stable" even when the recipe would diverge under sustained peak LR. v0.4.0's cosine-LR meta-bug cost five training runs before it was diagnosed.
- **Full-run batch geometry.** A smoke that runs at a different effective batch size than the full run is testing a different gradient-noise regime. The smoke's "pass" verdict is not transferable.
- **Run smokes before expensive retrains.** The smoke framework exists to catch divergence, NaN, and sampler starvation before they cost a full GPU run. It's the cheapest experiment in the training loop.

## The discipline checklist

Before shipping a model release:

1. **Report per-component F1 with and without adversarial eval slices.** The adversarial number is the honest ceiling; the non-adversarial number is the recipe-change signal.
2. **Bucket false negatives into categories.** Empty predictions, label confusion, span boundary slip, adversarial artifacts — each has a different fix and a different urgency.
3. **Distinguish model problems from decoder problems.** Span boundary slip is a decoder fix; label confusion is a model fix. Don't retrain for a decoder bug.
4. **Inspect borderline regressions manually.** A 0.5–1.5pt macro_F1 shift could be annotator noise. Look at the actual disagreements before deciding.
5. **Run verdict smokes at full-run geometry with constant LR.** Cosine decay and mismatched batch sizes produce false confidence.
6. **Build diagnostic tooling before you need it.** `corpus-audit` and `diagnose_regression.py` were built during the v0.4.0 campaign — they would have saved most of v0.3.0's investigation time if they'd existed earlier.

## See also

- [v0.4.0 ablation campaign retrospective](/blog/v0-4-0-ablation-campaign) — the original false-negative bucketing analysis
- [VERDICT_SMOKES.md](../plan/reference/VERDICT_SMOKES.md) — smoke-test discipline for training experiments
- [Dual-loss curvature conflict](./dual-loss-curvature-conflict.md) — the training divergence this methodology helped diagnose
- [Training pipeline](./training-pipeline.md) — how corpus composition affects eval-set coverage
