---
sidebar_position: 21
title: FST gazetteer prior
tags:
  - concepts
  - neural
  - fst
  - architecture
---

# FST gazetteer prior

The FST (finite-state transducer) gazetteer prior is a pre-computed lookup structure that tells the neural classifier which token sequences are known place names. Where the [QueryShape soft prior](./neural-classification.md) says "this 5-digit token is probably a postcode" (structural pattern), the FST prior says "this token sequence matches 'New York' which is either locality WOF:85977539 or region WOF:85688543" (factual knowledge from the gazetteer).

Both are additive emission biases in the Viterbi CRF decoder. Neither overrides the neural model — they nudge uncertain predictions toward the structurally or factually implied label.

## How it works

At build time, the FST builder reads every admin place from a WOF SQLite database and inserts its normalized name tokens into a trie. Accepting states carry all valid interpretations for that token sequence — placetype, WOF ID, parent chain, and a Wikipedia-derived importance score.

At inference time, the FST prior:

1. Groups SentencePiece subword tokens into whitespace words
2. Walks all contiguous subpaths through the FST
3. For each matching path, adds an importance-weighted logit bias to the corresponding BIO labels (B-locality, I-locality, B-region, etc.)
4. Suppresses non-place labels (B-street, B-house_number) by -1.5 logits when a place match is found

## Wikipedia importance

Raw population is a poor proxy for place importance — Washington state (7.6M) outranks Washington DC (678K) despite DC being the overwhelmingly more common referent. The FST uses Wikipedia importance scores from [Nominatim's methodology](https://nominatim.org/release-docs/latest/customize/Importance/): `log(total_links) / log(max_links)`, normalized to \[0, 1\].

| Place                    | Population | Wikipedia importance |
| ------------------------ | ---------- | -------------------- |
| Washington DC (locality) | 678K       | 0.815                |
| Washington (state)       | 7.6M       | 0.764                |
| New York City (locality) | 8.8M       | 0.950                |

The bias formula is linear: `importance × biasScale × maxBias`, capped at 3.0 logits. This nudges the Viterbi decoder without overriding confident model predictions.

## Composition with QueryShape

The FST prior composes additively with the existing QueryShape soft prior:

```
finalEmissions[t][label] = rawLogits[t][label]
                         + queryShapeBias[t][label]
                         + fstBias[t][label]
```

For "Washington, DC": the QueryShape prior detects "DC" as a region abbreviation and adds +2.0 to B-locality on preceding tokens. The FST prior adds +2.45 to B-locality (DC importance 0.815 × 3.0). Together: +4.45 logit advantage for the correct interpretation.

The QueryShape prior includes a region-aware guard: it skips the locality bias when the preceding text matches the region's full name (e.g., "Washington" before "WA" gets no locality bias, because Washington IS the state).

## See also

- [FST Gazetteer LM (reference)](../plan/reference/FST_GAZETTEER_LM.md) — full design document with metrics and implementation phases
- [Neural classification](./neural-classification.md) — the transformer + CRF Viterbi decoder
- [WOF data pipeline](./wof-data-pipeline.md) — how the unified SQLite is built from GeoJSON repos
