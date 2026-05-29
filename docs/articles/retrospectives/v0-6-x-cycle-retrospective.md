---
sidebar_position: 3
title: v0.6.x cycle retrospective + v0.7 plan
---

# v0.6.x cycle retrospective + v0.7 plan

**Iteration window:** 2026-05-25 → 2026-05-29, ~4 days wall-clock, four
training runs (v0.6.1, v0.6.2, v0.6.2b parallel, v0.6.3). **Outcome:**
no shippable v0.6.x release. The cycle was **held** after v0.6.3
empirically confirmed a corpus-dilution failure mode. The pattern
revealed by three iterations of recipe-tuning has produced a structured
v0.7 plan that addresses the binding constraint (model calibration) and
defers system-multiplicity architecture (per-locale routing) to v0.8.

This is the technical postmortem. The forward plan in section 5 is the
synthesis of two DeepSeek consults (turns 11 and 12) plus the
[postcode-only diagnostic](../evals/2026-05-29-postcode-diagnostic.md)
run on v0.6.0.

## 1. What was attempted

The cycle started after v0.6.0 shipped and v0.6.1 was found to have
catastrophically regressed locality recall (-8.6pp) due to a
`dependent_locality` over-emission spike (+1066 hallucinations on the
golden set). The cycle's goal: restore v0.6.0's quality without losing
the v0.6.1 street-decomposition signal that motivated the synth-street
weight bump in the first place.

| Run | Recipe change | dep_loc halls | locality recall | house_number recall | Harness % | Verdict |
|-----|---------------|--------------:|----------------:|--------------------:|----------:|---------|
| v0.6.0 | (baseline) | 0 | 40.0% | 79.0% | 14.4% | shipped |
| v0.6.1 | synth-street weight 2.0 | **1066** ❌ | 31.1% | 75.9% | (similar) | regressed, held |
| v0.6.2 | + synth-no-street 1.0 | 0 ✓ | 41.0% | **74.0%** ❌ | 14.0% | 1 violation, hold |
| v0.6.2b | synth-no-street 0.5 (parallel) | 0 ✓ | 41.1% (20K) | 77.3% (20K) | 14.7% (20K) | 2 violations at 20K |
| v0.6.3 | + house-venue 1.0, no-street 0.5 | **844** ❌ | **34.7%** ❌ | 77.0% ✓ | **12.5%** ❌ | 3 violations, hold |
| v0.6.4 (not launched) | no-street 0.75 to fix dilution | TBD | TBD | TBD | TBD | held |

The pattern: every change addresses one regression at the cost of
another. v0.6.2 fixed dep_loc but cost house_number. v0.6.3 recovered
house_number but reopened dep_loc + cost locality. The synth-side
machinery is fragile in a way that recipe tuning cannot stabilize.

## 2. Infrastructure that came out of the cycle

The cycle didn't ship a model, but it did ship a substantial
infrastructure layer that v0.7 will sit on top of:

- **2D pre-publish eval gate**
  ([`scripts/eval-gate.ts`](https://github.com/sister-software/mailwoman))
  — `(recall drop > 2pp AND baseline > 10%) OR (hallucination spike >
  100 AND rate > 20%)`. Retro-validated against v0.6.0 → v0.6.1 — catches
  the regression with 3 violations including dep_loc rate at 2665%.
- **v0-vs-neural harness**
  ([`scripts/harness-v0-neural.ts`](https://github.com/sister-software/mailwoman))
  — TS AST extraction of every `assert(input, ...expected)` from
  `mailwoman/test/*.test.ts`. 376 assertions; v0 100% vs neural 14.4% at
  cycle start.
- **Per-token confidence probe** — revealed the binding constraint that
  recipe tuning was masking: 81% of wrong predictions land at ≥ 0.9
  confidence. The model is decisively wrong, not uncertain.
- **Stage 3 fold for eval** — collapses `street_prefix` + `street` +
  `street_suffix` into a single `street` span for Stage 2 golden-set
  comparison. Without this, v0.6.2's correct decomposition of "Main St"
  → street + suffix is double-penalized as a street boundary error PLUS
  a street_suffix hallucination.
- **Street morphology FST** — a deterministic two-pass bias that maps
  ~1707 libpostal street-type canonicals into a `street_affix` placetype
  and biases adjacent tokens toward `street` and away from
  `dependent_locality`. Insufficient as a decoder-only fix on v0.6.1
  (model overconfidence > -6.0 penalty); now archived as v0.7+
  shallow-fusion infrastructure.
- **Training-log charts**
  ([`scripts/parse-training-log.ts`](https://github.com/sister-software/mailwoman) +
  [`training-chart.ts`](https://github.com/sister-software/mailwoman)) —
  SVG line-chart generator, no dependencies. Made "same noise pattern
  across runs" visually rigorous instead of impressionistic.
- **Corpus linter v1**
  ([`scripts/lint-corpus-shard.ts`](https://github.com/sister-software/mailwoman))
  — distribution outliers, label-vacuum, bigram collisions, anti-pattern
  rules. Designed to prevent the "5th Avenue Theatre" class of
  poisoning, where a synthetic-shard rule emits venue templates that
  accidentally teach the model to label ordinal-prefixed street names
  as venues.
- **Postcode-only harness**
  ([`scripts/harness-postcode.ts`](https://github.com/sister-software/mailwoman))
  — per-country postcode accuracy gate. Created as the v0.7 regression
  fence for what should be a slam-dunk metric.

## 3. What v0.6.x actually revealed

### 3.1 The corpus-recipe knob is too coarse to stabilize the model

Three iterations of weight-tuning across `synth-street`,
`synth-no-street`, and `synth-house-venue` produced predictable but
oscillating trade-offs. Every weight change addressed one regression at
the cost of another. The pattern is reproducible:

- v0.6.2 dropped `synth-street` weight and added a `synth-no-street`
  counter-example shard at 1.0 weight. dep_loc returned to 0;
  house_number dropped to 74%.
- v0.6.3 added `synth-house-venue` at 1.0 while keeping `synth-no-street`
  at 0.5. The anti-decompose:companion ratio dropped from 1.0:0 (v0.6.2)
  to 0.5:1.0. dep_loc came back gradually (1 at 20K → 844 at 100K).

The recipe-knob story is wrong because it treats synthetic data as a
different MIXTURE of the same distribution. It isn't — it's a different
DISTRIBUTION. Every synthetic template imports a distributional
assumption that doesn't exist in real addresses; weight tuning addresses
the magnitude of the mismatch but not its structure.

### 3.2 Per-tag recall has been the wrong release metric

The 2D gate operates on per-tag recall. v0.6.2b passed the gate in
isolation (dep_loc 0, locality 41.1%, house_number 77.3% at 20K) but
its harness pass rate was 14.7% — a 0.3pp improvement over v0.6.0's
14.4%. Three iterations of corpus engineering produced essentially zero
address-level improvement.

Per-tag recall collapses 4,561 addresses into one number per tag. The
failure modes it masks: tree validity (a B-locality nested inside a
B-street is structurally invalid but counted as correct), swap errors
(`"Springfield, 123 Main St"` with locality and street swapped scores
67% per-tag, 0% address-level), missing components ("3 out of 4 tags
present" still produces a parse the resolver can't use).

DeepSeek turn 11 changed mind from turn 7 on this point: the v0.6.2b
ship recommendation was wrong because it was gated against per-tag
recall, not the harness.

### 3.3 The model is overconfident, not undertrained

The per-token confidence probe found 81% of WRONG predictions land at
≥ 0.9 confidence on BOTH v0.6.2 and v0.6.2b. This is calibration
crisis-level — the model is decisively wrong, not uncertain. Two
implications:

- **It explains v0.6.x fragility.** An overconfident model amplifies
  small distributional shifts (a new synth shard) into large prediction
  swings, because the model commits hard to whatever it learned most
  recently. The recipe-tuning whack-a-mole pattern is the direct
  consequence.
- **It pre-empts the CRF re-enablement.** The fp32-CRF fix is verified.
  But enabling CRF on top of an overconfident model would make
  overconfidence WORSE — the CRF tightly constrains the transition path,
  so a confident wrong emission locks the whole sequence into a wrong
  path. Calibrate first, then add CRF.

### 3.4 Postcode failures are endemic, not exotic

The
[postcode-only diagnostic](../evals/2026-05-29-postcode-diagnostic.md)
on v0.6.0 found postcode exact-match at 75.9% overall — 80.5% US, 70.1%
FR, 57% DE, 0% GB/CA/NL. The failure mechanism is visible in the data:
SentencePiece fragments multi-token alphanumeric postcodes into pieces
the model can't span, and the model labels SOME of the pieces as
postcode but not all.

This is a tokenizer concern, not a schema concern. Adding more JP / KR /
BR coverage (system-multiplicity) does not fix it. v0.7 needs to address
postcodes at the character or FST level.

### 3.5 Test-set leakage at the DECISION level

v0.1.2 has been the gate baseline for every v0.6.x decision. Three
iterations consumed the same dataset as decision data. The threshold
values in the 2D gate (2pp recall drop, 100 hallucination count) were
calibrated against the same set we've been reading. Some gate
pass/fail decisions may have been false positives.

The model has never seen v0.1.2 in training. But the recipe HAS been
tuned against it three times. That's decision-side leakage, even if it
isn't training-side.

## 4. What did NOT cause v0.6.x's pathology

For the record, so future-us doesn't relitigate these:

- **System-multiplicity (JP block addressing, KR dual systems, etc.)
  did not cause v0.6.x failures.** All measured regressions were on
  US-mostly data with US-mostly eval. JP/KR/Colombia are real
  architectural concerns for global coverage but were not the binding
  constraint here. See DeepSeek turn 12's tier list.
- **CRF disablement did not cause v0.6.x failures.** v0.6.x was
  CE-only because of the bf16 NaN issue in CRF transitions. The
  [fp32-CRF fix](../evals/2026-05-28-fp32-crf-diagnostic.md) is
  verified — but enabling CRF on top of v0.6.x's overconfident model
  would have amplified the failure, not fixed it.
- **Model capacity was not the binding constraint.** 29.3M params, 6
  layers × 384 hidden, trained from scratch. Whether this is undersized
  is genuinely unknown — but the failures we measured were calibration
  failures, not capacity ceilings.

## 5. v0.7 plan

**Synthesis of DeepSeek turns 11 + 12 + postcode diagnostic.** The
plan addresses the binding constraint (calibration) plus the
diagnostic-confirmed structural issue (postcode tokenizer), and defers
the speculative-architecture work (per-locale routing) to v0.8.

### 5.1 Binding-constraint tier list

| Constraint | Evidence | v0.7 priority |
|---|---|---|
| Overconfidence (81% wrong @ ≥ 0.9 conf) | Measured | **P0** |
| Postcode tokenizer fragmentation | Diagnostic-confirmed | **P1** |
| Data imbalance (US-dominant corpus) | Measured via harness zeros | **P1** |
| System-multiplicity / schema mismatch | Real but not cause of measured failures | **P2 (v0.8)** |
| Model capacity (29.3M params) | Untested | **P2 (v0.8)** |

### 5.2 Three parallel workstreams

**P0 — Calibration experiment** (~30 min Modal, blocks v0.7 release)

- `label_smoothing=0.1` on v0.6.0's UNCHANGED corpus.
- Single-variable change (no synth changes, no corpus changes).
- Held-out test set: split v0.1.2 randomly 90/10 dev/test.
- Early-eval gates against DEV; release-gate against TEST (touched once).
- Measure: **harness pass rate** (PRIMARY — replaces per-tag recall as
  the release metric), overconfidence %, per-tag recall on held-out test.
- Decision: ship if harness improves AND overconfidence drops; pivot if
  not.

**P1 — Postcode fix** (depends on diagnostic + calibration result)

The diagnostic confirms postcode <90% on most countries (US 80.5%, FR
70.1%, GB/CA/NL 0%). Three approaches in priority order:

1. **Character-level feature extractor** — parallel char-CNN or
   char-bigram embedding alongside subword tokens. The postcode shape
   becomes visible at character level even when fragmented at subword
   level. Architecture change (~50KB extra params), but contained.
2. **Postcode-aware tokenizer pre-pass** — regex detects and protects
   postcode-shaped substrings (`/[A-Z]\d[A-Z]?\s*\d[A-Z]\d/` etc.)
   before SentencePiece runs. Single token, single label, no
   fragmentation. Simpler to ship than (1) but requires per-country
   patterns.
3. **Per-country postcode FST** — treat postcodes like admin names; FST
   recognizes country-specific shapes and biases the model toward
   labeling the matched span as postcode. Layer 1.5 of the
   [shallow-fusion architecture](../concepts/fst-priors-as-shallow-fusion.md).

DeepSeek turn 12 favors (1) + (3). Final choice depends on calibration
result — if calibration alone moves postcode accuracy meaningfully
upward, the tokenizer fix becomes smaller-scope.

**P2 — Pre-classifier design** (gated on postcode result, may slip to v0.8)

If postcode accuracy is still < 90% after calibration + tokenizer fix,
the locale-router approach becomes the next lever. Recommended
architecture: lexical-feature classifier (regex + char n-grams → tiny
MLP), <0.1ms latency, <100KB serialized. 99% accuracy on
postcode-bearing inputs is achievable via postcode-pattern features
alone.

This is the entry point for v0.8's system-multiplicity work
(per-locale containment rules, hybrid encoder + per-system decoders).

### 5.3 Methodology fixes (carry forward from turn 11)

- **Harness pass rate is the primary release metric.** Per-tag recall
  becomes a diagnostic-only metric. The 2D gate stays as a secondary
  safety net but no longer controls the ship decision.
- **Held-out test set methodology.** v0.1.2 split 90/10 dev/test. Test
  read exactly once per release. Closes decision-side test-set leakage.
- **Synthesis-as-supplement, not synthesis-as-primary.** Small targeted
  shards, weight < 0.25, one-and-done. Real data is the primary fix for
  distributional gaps. v0.6.x's 100K+ row synthesis was the wrong
  philosophy.

### 5.4 Decision-tree on calibration results

| Calibration | Postcode | Action |
|---|---|---|
| Improved + overconfidence dropped | < 90% (current state) | v0.7 = calibration + postcode tokenizer fix |
| Improved + overconfidence dropped | ≥ 90% everywhere | v0.7 = calibration only; pre-classifier → v0.8 |
| Flat + overconfidence unchanged | < 90% | v0.7 pivots to structural; hybrid arch becomes focus |
| Flat + overconfidence unchanged | ≥ 90% everywhere | Investigate further; calibration symptom not cause |

The diagnostic settles the postcode column as `< 90%`, so the v0.7
action set is anchored on the top row unless calibration unexpectedly
fails.

## 6. Long-term: where v0.8+ goes

The system-multiplicity question is real (JP block addressing, KR
dual systems, Colombian Calle/Carrera grids, Costa Rican landmark-
relative addresses, Brasília superquadras, Irish townlands, Icelandic
farms). The current `PARENT_OF` containment table encodes a US/EU
street-based grammar that doesn't fit these systems.

The v0.8+ direction (informed by DeepSeek turn 12):

- **Hybrid model architecture.** Shared encoder (language-agnostic
  structural features) + per-system decoders (US, JP, KR specialist
  heads). Encoder ships once; new locales = new decoder heads.
- **Per-system containment rules.** `PARENT_OF` becomes per-system.
  Today's table is the US/EU default; JP table has no `street` parent
  for `building_number`.
- **Locale pre-classifier as the router.** Lexical-feature classifier
  picks one system from a probability distribution; the matching
  specialist decoder runs.
- **AddressTree versioning.** Add `system` field to parsed output. JP
  trees keep `block` → `sub_block` → `building_number`; US trees keep
  `street` → `house_number`. Consumers opt in. Avoid lossy universal
  projection.

This work is meaningful but is NOT what v0.6.x failures were pointing
at. v0.7 fixes the measured problems; v0.8 starts the structural
direction.

## 7. The meta-lesson

The v0.6.x cycle ran three full retrains chasing recipe tweaks because
the surface failure mode (dep_loc hallucinations) felt like a recipe
problem. The deeper failure mode (calibration crisis, decision-side
test-set leakage, wrong release metric) became visible only after the
recipe-tuning iterations had exhausted plausible knobs.

Recipe tuning is fast and feels productive. It produces concrete
deliverables (new training runs, new charts, new error reports). But it
masks deeper questions about whether the right thing is being optimized
at all. The DeepSeek consult model — broad architectural question at a
fixed cadence, designed to challenge framing rather than refine within
it — was the single highest-leverage intervention of the cycle.

For the next cycle: cap the recipe-tuning budget at two iterations
before forcing a methodology rethink.

## See also

- [Postcode-only diagnostic (v0.6.0)](../evals/2026-05-29-postcode-diagnostic.md)
- [v0.6.2 step 100K eval](../evals/2026-05-29-v0.6.2-100k-eval.md)
- [v0.6.3 step 100K eval](../evals/2026-05-29-v0.6.3-100k-eval.md)
- [v0.4.0 ablation campaign](./v0-4-0-ablation-campaign.md) — the
  previous retrospective; follows the same shape.
- [How the model reasons](../concepts/how-the-model-reasons.md) — the
  architecture overview the v0.7 plan operates within.
