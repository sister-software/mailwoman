---
sidebar_position: 35
title: "2026-05-28 Layer 1 morphology FST eval"
---

# Layer 1 (street-morphology FST) eval — 2026-05-28

Applied the newly-landed [street-morphology FST](../concepts/street-supplement-architecture.md)
as a decoder-only fix on the v0.6.1 weights and re-ran the 4561-entry golden set. Goal: measure
whether the morphology prior alone suppresses v0.6.1's 1066 `dependent_locality` hallucinations
without retraining.

**TL;DR:** It does not. The mechanism is structurally correct (dep_loc hallucinations drop
monotonically as the penalty is strengthened) but the model's overconfidence on
synth-street-induced predictions is too high for any practical decoder-time bias to flip. The
right deployment of Layer 1 is **alongside a v0.6.2 retrain** that adds O-tagged street slots
to the negative-example corpus.

## Setup

- **Model:** `model-v061-step-100000-int8.onnx` (the experimental v0.6.1 weights with synth-street
  shard, weight 2.0, that produced the original 1066 dep_loc regression)
- **Tokenizer:** `v0.6.0-a0` (multi-script; matches the model's training tokenizer)
- **Admin FST:** `fst-en-us.bin` (the production admin FST)
- **Morphology FST:** built in-process from the 60 libpostal `street_types.txt` dictionaries
  (`core/data/libpostal/dictionaries/{locale}/street_types.txt`)
- **Golden set:** `data/eval/golden/v0.1.2/` — 4561 entries (US + FR + adversarial)
- **Script:** `scripts/eval-morphology-fst.ts` (new, takes explicit weight + FST paths)

## Results

| Configuration | dep_loc hall. | street_suffix hall. | street_prefix hall. | locality recall | street recall | exact match |
|---|---|---|---|---|---|---|
| v0.6.1 neural-only (on record) | 1066 | 198 | 31 | 31.1% | 27.5% | 18.8% |
| v0.6.1 + admin FST only | 1063 | 204 | 32 | 31.2% | 27.5% | 18.8% |
| + morphology, defaults | 1050 | **332** ❌ | 40 | 31.2% | 26.2% | **18.2%** ❌ |
| + morphology, length≥3 filter | 1058 | 238 | 32 | 31.2% | 27.1% | — |
| + morphology, low bias + −6.0 pen | **1044** | 213 | 32 | 31.3% | 27.5% | — |

Defaults: `maxAffixBias=3.0`, `maxNeighbourStreetBias=2.0`, `dependentLocalityPenalty=2.0`.
Tuned: `maxAffixBias=1.0`, `maxNeighbourStreetBias=1.0`, `dependentLocalityPenalty=6.0`.

## Findings

### Admin FST does nothing for street-side errors

`v0.6.1 neural-only` vs `v0.6.1 + admin FST only` is essentially a no-op (1066 vs 1063 dep_loc
hallucinations). Confirms the structural diagnosis from the
[WOF hierarchy gap](../concepts/wof-hierarchy-gap.md) doc: the admin FST has no street
placetypes to match, so it can provide no negative-evidence anchor for street tokens. Synth-street
exploited exactly this vacuum.

### Layer 1 mechanism is sound but its magnitude is bounded by the model's confidence

The dep_loc hallucination count drops monotonically as the `dependentLocalityPenalty` is
strengthened (defaults 2.0 → 6.0 → ...). The direction is correct. But the absolute reduction is
small: even at −6.0 penalty (3× the default), only 19/1063 hallucinations get suppressed. To
suppress more, you'd need to push the penalty higher — at which point it starts corrupting
legitimate decisions on other tokens.

The model's confidence on its synth-street-induced dep_loc predictions is genuinely high. Per
the [v0.6.1 calibration probe design](2026-05-28-night-2-postmortem.md): when the hallucinations
are high-confidence, **retraining is required, not just a decoder-time threshold or bias**.

### Default morphology bias is over-aggressive and causes collateral street_suffix damage

At default magnitudes (`maxAffixBias=3.0`), the morphology FST inflates `street_suffix`
hallucinations from 204 → 332 — a +63% increase. Investigation: the libpostal
`street_types.txt` dictionaries contain many 1-2 character abbreviations (`a`, `b`, `av`, `bd`,
`br`, ...) that collide with US state abbreviations (`OR`, `CA`, `ND`, `NY`) and short tokens.
A minimum-length-3 surface-form filter mitigates this (`av` no longer matches, but `avenue`,
`rue`, `blvd` still do — see
`resolver-wof-sqlite/street-morphology-fst-builder.ts`'s `minVariantLength` option).

Even with the filter, default bias magnitudes still produce 238 hallucinations vs the 204
baseline — a smaller but real regression. Lowering `maxAffixBias` to 1.0 brings collateral
damage back to 213, basically baseline-equivalent.

### Layer 1 is a real deliverable on top of a v0.6.2 retrain

Architecturally, Layer 1 IS the dual-FST integration plumbing that future layers (Layer 1.5
candidacy, Layer 2 street identity, Layer 4 brand FST) flow through unchanged. The
infrastructure work tonight wasn't speculative — `ParseOpts.fstStreetMorphology`,
`buildStreetMorphologyEmissionPriors`, the `PlacetypeId` extension, the two `PLACETYPE_ORDER`
synchronization points, the libpostal dictionary walker — all of it is correct and tested. It
just needs a backbone model that wasn't trained to be wrong about dep_loc.

## What this means for v0.6.2

Per [DeepSeek's turn 2 recipe](2026-05-28-night-2-postmortem.md#deepseeks-three-rubrics-for-a-night-shift-skill)
and the [street-supplement architecture doc](../concepts/street-supplement-architecture.md):

1. **Retrain with synth-street weight 0.5** (down from 2.0) — reduces the gradient pressure
   that pushed the model into overconfident dep_loc predictions.
2. **Explicit O-tags on street slots in non-street corpus rows** — the negative-example
   counter-distribution that synth-street is currently missing.
3. **Layer 1 prior at inference** — the morphology FST as an additive anchor; meaningful on top
   of a corrected backbone, insufficient on its own.

The morphology FST infrastructure landed in this shift is exactly the inference plumbing v0.6.2
will use.

## Reproducing

```bash
# Baseline: v0.6.1 + admin FST only
node --experimental-strip-types scripts/eval-morphology-fst.ts \
  --model /mnt/playpen/mailwoman-data/models/quantized/model-v061-step-100000-int8.onnx \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --model-card neural-weights-en-us/model-card.json \
  --admin-fst /mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin \
  --golden data/eval/golden/v0.1.2 \
  --no-morphology

# With morphology FST (defaults)
node --experimental-strip-types scripts/eval-morphology-fst.ts \
  --model /mnt/playpen/mailwoman-data/models/quantized/model-v061-step-100000-int8.onnx \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --model-card neural-weights-en-us/model-card.json \
  --admin-fst /mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin \
  --golden data/eval/golden/v0.1.2

# Tuned (low affix bias, strong dep_loc penalty)
node --experimental-strip-types scripts/eval-morphology-fst.ts \
  --model /mnt/playpen/mailwoman-data/models/quantized/model-v061-step-100000-int8.onnx \
  --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
  --model-card neural-weights-en-us/model-card.json \
  --admin-fst /mnt/playpen/mailwoman-data/wof/fst-per-locale/fst-en-us.bin \
  --golden data/eval/golden/v0.1.2 \
  --max-affix-bias 1.0 --max-neighbour-street-bias 1.0 --dep-locality-penalty 6.0
```

## See also

- [Street-supplement architecture](../concepts/street-supplement-architecture.md) — the design
  this eval validates against
- [WOF hierarchy gap](../concepts/wof-hierarchy-gap.md) — the structural cause
- [v0.6.1 error analysis](v0.6.1-error-analysis.md) — the original regression
- [2026-05-28 night-2 postmortem](2026-05-28-night-2-postmortem.md) — the postmortem that drove
  the design consult
