# Boundary-instability: the current model's gap, quantified (#375)

The failure taxonomy named boundary instability the #1 parser lever and the within-token decomposition
(#702) showed it surfacing under many names. The boundary-stress shard (#703) is the training-data fix.
This is the **"before" baseline** — how badly today's model places these boundaries, on the exact
synthetic shapes the shard teaches (`scripts/eval/boundary-stress-baseline.ts`, 300 rows/shape through
the current neural model, exact-match per tag). The shard is **base-locales-only (US/FR/DE)** — see the
base-consistency section for why.

| stress shape | stress tag | accuracy | street accuracy |
| --- | --- | --: | --: |
| street-eats-affix | street_suffix | **40.7%** | 38% |
| comma-less City ST | street | **46%** | (locality 91, region 100) |
| fr-prefix | street_prefix | **47.7%** | 43% |
| house-number-after-street | house_number | **50.7%** | 49% |

(On the delimited shapes the uncontested tags read ~100% — the failures concentrate on the contested
boundary, exactly as designed. US comma-less locality/region are easy at 91/100%; the *street* span is
the casualty there too.)

**Diversity correction (the runbook's point, measured):** an initial thin-pool shard (~16 streets, ~7
tuples) gave an *inflated* baseline — street_suffix read 48%, fr-prefix 70% — because the few lexemes
were memorizable. Expanding the pools ~3× (≈100 distinct streets, 28 US / 12 FR / 10 DE tuples, ~100%
unique rows) drops those to **40.7% / 47.7%** — the true gap on the real distribution. Exactly why
CONTRIBUTING_MODEL_WORK gates on diversity: a thin shard teaches lexemes and a thin baseline hides the gap.

## Base-consistency (#511 lint) — the gate caught a real contradiction

Running the #511 base-consistency lint (`lint-corpus-shard.ts` against sampled `v0.5.0` base-stats)
caught two things, only one of them a true problem:

- **AU content was a real contradiction → FIXED.** An earlier draft used AU/NZ/UK tuples (for an
  `au-uk-slash-unit` shape + AU comma-less). AU isn't a base locale (the base is US/FR/DE), and **AU
  4-digit postcodes collide with US house numbers** (`3000` is a common US street number). The lint
  flagged it; the shard is now **base-locales-only**, and the AU/UK slash convention (the worst
  within-token class, #702) is deferred to a separately-scoped AU/NZ/UK shard that also adds AU **base
  coverage** — it cannot ride a US/FR/DE shard without contradicting the base.
- **Residual distribution-outlier flags are likely sampling artifacts.** The lint also flags US/FR
  localities (`Paris`, `Springfield`, `Toulouse`) as B-locality where the *sampled* base majority is
  I-street — but the sample (a by-index spread of 20/685 shards) is source-clustered and TIGER-street-
  heavy, undersampling the WOF/admin shards that carry localities. And the street_suffix/street_prefix
  flags are train-time-relabel artifacts (the lint compares pre-relabel parquets; the affix-relabel
  lexicon — verified — maps every one of the shard's suffixes/directionals). **The proper gate is the
  full-corpus lint on the operator's machine** (the 680M-row base-stats); it will resolve whether the
  locality/street overlap is real, and if so the shard's locality vocabulary should be tuned to tokens
  the base labels as localities. The shard must not ship to a retrain until that lint is clean.

## Reading

- The model is **38–51%** on the boundary-stress cases vs ~95%+ on clean canonical — a large, real gap.
- **The street boundary is the common casualty** (38% / 46% / 43% / 49% across all four shapes): when an
  adjacent component is ambiguous, the street span absorbs or surrenders tokens. One failure, many faces.
- **house-number-after-street 51%** is the fr.house_number plateau in miniature (the FR/DE
  number-follows-street order) — this shard's `house-number-after-street` shape targets that lever too.

## So what

The shard puts the gold boundary on diverse realizations of these shapes. The retrain's success
criterion (the `v1.6.0-boundary-stress` recipe gate): move these four numbers up without regressing the
clean canonical per-locale F1 (the US/FR/DE tripwire) and the affix floors — one variable, gated, per
`CONTRIBUTING_MODEL_WORK`, **after the full-corpus #511 lint is clean**.

_Source: `scripts/eval/boundary-stress-baseline.ts` over `corpus/src/synthesize-boundary-stress.ts`._
