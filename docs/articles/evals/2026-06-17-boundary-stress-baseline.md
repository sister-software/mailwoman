# Boundary-instability: the current model's gap, quantified (#375)

The failure taxonomy named boundary instability the #1 parser lever and the within-token decomposition
(#702) showed it surfacing under many names. The boundary-stress shard (#703) is the training-data fix.
This is the **"before" baseline** — how badly today's model places these boundaries, on the exact
synthetic shapes the shard teaches (`scripts/eval/boundary-stress-baseline.ts`, 300 rows/shape through
the current neural model, exact-match per tag).

| stress shape | stress tag | stress-tag accuracy | street accuracy |
| --- | --- | --: | --: |
| street-eats-affix | street_suffix | **48.0%** | 42% |
| comma-less City STATE | region | **66.3%** | **34%** |
| fr-prefix | street_prefix | **70.3%** | 70% |
| house-number-after-street | house_number | **47.3%** | 44% |

(house_number, locality, postcode read ~100% on the delimited shapes — the failures are concentrated on
the contested boundary, exactly as designed.)

## Reading

- The model is **42–70%** on the boundary-stress cases vs ~95%+ on clean canonical addresses — the gap
  is large and real, not a measurement artifact. These are the rows the #1 lever is about.
- **Comma-less is the worst** (street **34%**, locality 59%): stripping the delimiter cue collapses the
  segmentation — the same #694 finding (concatenated input loses the boundary), now measured on the
  parser side, not just the geocoder.
- **The street boundary is the common casualty** (42% / 34% / 44% across three shapes): when an adjacent
  component is ambiguous, the street span absorbs or surrenders tokens. One failure, many faces.
- **house-number-after-street 47%** is the fr.house_number plateau in miniature (the FR/DE
  number-follows-street order) — confirming the shipped ~87% there degrades further on stress positions,
  and that this shard's `house-number-after-street` shape targets that lever too.

## So what

The shard (#703) puts the gold boundary on diverse realizations of exactly these shapes. The retrain's
success criterion is moving these four numbers up without regressing the clean canonical per-locale F1
(the US/FR/DE tripwire) — one variable, gated, per `CONTRIBUTING_MODEL_WORK`. This table is what the
retrain is measured against.

_Source: `scripts/eval/boundary-stress-baseline.ts` over `corpus/src/synthesize-boundary-stress.ts`._
