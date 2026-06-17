# Boundary-instability: the current model's gap, quantified (#375)

The failure taxonomy named boundary instability the #1 parser lever and the within-token decomposition
(#702) showed it surfacing under many names. The boundary-stress shard (#703) is the training-data fix.
This is the **"before" baseline** — how badly today's model places these boundaries, on the exact
synthetic shapes the shard teaches (`scripts/eval/boundary-stress-baseline.ts`, 300 rows/shape through
the current neural model, exact-match per tag). The shard is **base-locales-only (US/FR/DE)** — see the
base-consistency section for why.

| stress shape | stress tag | accuracy | street accuracy |
| --- | --- | --: | --: |
| street-eats-affix | street_suffix | **41.7%** | 39% |
| comma-less City ST | street | **47%** | (locality 91, region 90) |
| fr-prefix | street_prefix | **55.0%** | 39% |
| house-number-after-street | house_number | **51.3%** | 53% |

_(Measured on the base-consistent locality vocabulary — see the #511 section. Earlier drafts read
street_suffix 40.7 / fr-prefix 47.7 on a vocab that contradicted the base; the numbers above are on the
corrected vocab. house-number-after-street is now FR-only.)_

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
- **The affix-tag flags are train-time-relabel artifacts** (`Ave`/`Place`/`NW` → suffix/prefix): the lint
  compares pre-relabel parquets, and the affix-relabel lexicon (verified) maps every suffix + directional. Safe.
- **The locality/street overlap was RESOLVED by deriving the vocabulary from the base itself.** A targeted
  scan (what label does the base give each shard locality?) found the original **US** vocab was a genuine
  contradiction — `Madison` 96% street, `Portland` 95%, `Springfield IL` 84% (the "5th Avenue Theatre"
  class, well-sampled across ~23 US shards). Fixed: the US vocab is now **derived + verified
  locality-dominant** (Albuquerque 258584:8, Indianapolis 219700:29, Sacramento, Jacksonville…). The
  **FR** flag, by contrast, was a *sampling artifact* — the all-shard scan barely touched the FR ban block
  (parts 180–209) and mixed in US street-contexts; the FR-block scan shows Paris (515605:24789), Marseille,
  Lyon are 95–99% **locality** in the FR data, so familiar dept-diverse FR cities are kept. **DE** yielded
  no locality-dominant towns (German cities are street-dominated too, "Berliner Straße"), so
  house-number-after-street is FR-only (DE's native order is covered by `synth-german`). Net: every shard
  locality now agrees with the base — the contradiction is gone, not deferred.

## Reading

- The model is **38–51%** on the boundary-stress cases vs ~95%+ on clean canonical — a large, real gap.
- **The street boundary is the common casualty** (38% / 46% / 43% / 49% across all four shapes): when an
  adjacent component is ambiguous, the street span absorbs or surrenders tokens. One failure, many faces.
- **house-number-after-street 51%** is the fr.house_number plateau in miniature (the FR/DE
  number-follows-street order) — this shard's `house-number-after-street` shape targets that lever too.

## So what

The shard puts the gold boundary on diverse realizations of these shapes. The locality vocabulary is now
base-derived (the #511 contradiction is resolved, not deferred), so the shard is retrain-ready. The
retrain's success criterion (the `v1.6.0-boundary-stress` recipe gate): move these four numbers up
(street_suffix 41.7 → ≥55, comma-less street 47 → ≥65, fr-prefix 55 → ≥70, hn-after 51.3 → ≥65) without
regressing the clean canonical per-locale F1 (the US/FR/DE tripwire) and the affix floors — one variable,
gated, per `CONTRIBUTING_MODEL_WORK`.

_Source: `scripts/eval/boundary-stress-baseline.ts` over `corpus/src/synthesize-boundary-stress.ts`._
