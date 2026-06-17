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
| au-uk-slash-unit (`4/2A`) | house_number | **38.7%** | — |

(On the delimited shapes the uncontested tags read ~100% — the failures concentrate on the contested
boundary, exactly as designed.)

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
- **au-uk-slash-unit is the worst at 38.7%** — the AU/NZ/UK `4/2A` unit/street-number convention, the
  one genuinely-new case from the #702 decomposition. The aligner's tokenizer splits on `/`, so this
  labels cleanly (unit then house_number) and is includable in the shard; it does not collide with the
  US `123 1/2` fraction (locale-disambiguated). This is the clearest single addressable win in the set.

## So what

The shard (#703) puts the gold boundary on diverse realizations of exactly these shapes. The retrain's
success criterion is moving these four numbers up without regressing the clean canonical per-locale F1
(the US/FR/DE tripwire) — one variable, gated, per `CONTRIBUTING_MODEL_WORK`. This table is what the
retrain is measured against.

_Source: `scripts/eval/boundary-stress-baseline.ts` over `corpus/src/synthesize-boundary-stress.ts`._
