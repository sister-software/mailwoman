# #625 gold set — the dedup "over-merge" is almost entirely a yardstick artifact

_Gold-set P3. The dual-level benchmark and the ceiling both suggested the dedup over-merge might be
NPI **over-segmentation** (one org / many NPIs) rather than model error. This adjudicates the hard
slice and settles it._

## Method

`scripts/record-matcher/gold-set-sample.ts` over the full TX registry (geocode-free): find the
genuinely-hard pairs — co-located (same `addressFrequencyKey`), name-similar (token Jaccard ≥ 0.7),
**distinct NPIs**, and **NOT** NPPES-flagged subparts of the same parent (so the programmatic entity
truth can't already collapse them). **11,843** such pairs exist in TX; a stride-spread **120** were
adjudicated "same real-world entity? yes/no" (LLM-as-judge — flagged as such; the frozen set is
`2026-06-16-dedup-gold-set-tx120.jsonl` for spot-checking).

## Result

| | count |
|---|---:|
| **Same real-world entity** (correct to merge) | **120 / 120 (100%)** |
| **Genuinely distinct** (a TRUE over-merge) | **0** |
| Programmatic "distinct" verdicts that are actually the SAME org | 44 (37%) |

Every hard pair is **one organization under multiple NPIs** — unflagged subparts, legal-form variants
(`WAL-MART STORES TEXAS LLC` vs `… LP`), state/site qualifiers (`… EL PASO`), abbreviations, or
typos. Representative clusters: **Baylor College of Medicine** (×4 at 1504 Taub Loop), **TCH Pediatric
Associates** (×3), county hospital districts and MHMR centers (×2 each), **UT Southwestern**, the
**Concentra** brand-family at its Addison HQ, **University of Texas Medical Branch**. Not a single pair
is two unrelated companies wrongly fused.

And the programmatic entity-truth (subpart-flag + authorized-official) is itself **too conservative**:
**44 of 120 (37%)** are the same org with a *different* authorized official, which the heuristic reads
as "distinct." A real entity-truth must collapse by **org-name + address**, not just the flag.

## What this means for #625

1. **The over-merge "problem" is a measurement artifact.** The matcher's co-located merges are correct
   org-resolution; NPI-truth (and even subpart-truth) scores them as errors. This is why the **A/B
   showed the corroboration features didn't move precision** — there is essentially no genuine
   over-merge to cut. Optimizing the model for precision here optimizes a phantom; cost-sensitive
   training would only *hurt* (un-merge correct same-org pairs).

2. **The real dedup lever is the YARDSTICK, not the model.** A better entity-truth that collapses
   same-org-same-address NPIs by org-name lifts the *measured* F1 toward the real ceiling (the ceiling
   doc's ~1.6% irreducible) — because it stops charging correct merges as errors. The next build is an
   org-name-aware entity truth + re-scoring at that grain, not more scorer features.

3. **The model is already good at this.** Site-grain recall is ~96% and the over-merges are correct.
   The dedup objective is closer to solved than NPI-truth's ~54% F1 suggests; that number is mostly
   the yardstick.

## Caveats

- LLM-adjudicated (one judge), TX, 120 pairs — a first frozen gold set, not a multi-rater gold
  standard. The frozen JSONL is committed for the operator (or a second rater) to spot-check.
- The ~6 Concentra-HQ pairs are same-**parent**, different operating brand at a shared corporate
  address — judged same-entity at the org level; a stricter site/brand grain could split them. They do
  not change the headline (zero unrelated-org fusions).
