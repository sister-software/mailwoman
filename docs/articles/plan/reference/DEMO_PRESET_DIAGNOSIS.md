---
sidebar_position: 17
title: Demo preset diagnosis
---

# Demo Preset Diagnosis — v0.5.1 Locality/Region Confusion

:::info[Fixes shipped]

- **"New York, NY"**: Fixed by the region-aware locality bias guard ([#174](https://github.com/sister-software/mailwoman/pull/174)). The QueryShape prior now skips locality bias when the preceding text matches the region's full name.
- **FST importance weighting**: Washington DC locality (0.815) correctly outranks Washington state (0.764) via Wikipedia importance ([#173](https://github.com/sister-software/mailwoman/pull/173)).
- **"Washington, DC"**: Partially improved — FST biases toward locality, but the model's high B-street confidence after street phrases resists the prior. Remaining fix is in training data quality.
- **"San Francisco"**: Fixed in v0.5.2 model — correctly labeled as locality.
  :::

Documents the root-cause analysis of v0.5.1's demo preset failures and the fix plan. Derived from an 8-turn DeepSeek consultation (2026-05-25).

## The failures

Six demo presets tested against v0.5.1 (`h384`, `val_macro_f1=0.638`). Two systematic failures:

| Preset | Input                                               | Expected                       | Got                          |
| ------ | --------------------------------------------------- | ------------------------------ | ---------------------------- |
| #1     | `1600 Pennsylvania Avenue NW, Washington, DC 20500` | Washington=locality, DC=region | Washington=region, DC=region |
| #2     | `350 5th Ave, New York, NY 10118`                   | New York=locality, NY=region   | New York=region, NY=region   |

Other failures (#3 venue, #4 directional, #6 postcode) are unrelated — covered separately below.

## Root cause: WOF bare-name frequency dominance

The model receives no positional signal about where a token appears in an address structure. v0's rule-based solvers had explicit positional penalties (`HouseNumberPositionPenalty`, `PostcodePositionPenalty`) that the neural pipeline does not replicate.

The transformer backbone HAS positional encodings and CAN learn "token after street, before region abbreviation → locality." But:

- **WOF entries are bare place names** — "Washington" → `B-region` with NO surrounding context
- **OSM entries are full addresses** — "Washington" → `B-locality` between a street and a region abbreviation
- **WOF bare-name entries outnumber OSM positional-context entries** for ambiguous place names

The model learns the frequency-dominant pattern (Washington = region) because it sees that label more often in isolation. The positional signal from OSM full-address rows exists but is diluted.

## BIO boundaries are correct

The model emits `B-region` for "Washington" and a separate `B-region` for "DC" (not `I-region`). This is structurally correct — they ARE separate entities separated by comma+space (O-tokens). The CRF transition mask is working. The problem is tag assignment on the first entity, not boundary detection.

## Fix plan (priority order)

### 1. QueryShape locality soft prior (inference-time, no retraining)

Detect unambiguous 2-letter region abbreviation (e.g., `DC`, `NY`, `CA`) → bias preceding place-name tokens toward `B-locality` / `I-locality` via emission prior.

- **Where:** Between classifier forward pass and CRF Viterbi decode (existing `buildEmissionPriors` path)
- **Magnitude:** `+2.0` logit boost (same as existing format-hit priors; ~7.4× odds multiplier at softmax)
- **Safety constraint:** Only bias tokens verified against WOF locality entries at the detected locale. "Pennsylvania" preceding DC stays as street because it's NOT a WOF locality in the relevant context.
- **Effort:** ~20 lines. Zero retraining.
- **Test:** Demo presets #1 and #2. If still fails, bump to +3.0. If overcorrects on "Washington state" inputs, pull back.

### 2. Source weight rebalance (training-time)

```yaml
source_weights:
  osm: 1.0
  wof: 0.3
```

Reduces WOF bare-name frequency dominance. OSM positional signal becomes the primary teacher for ambiguous place names. One config line.

### 3. Training augmentation — directional + region-abbreviation expansion

Two independent augmentations:

- **Directional:** Train on both "350 5th Ave NW" and "350 5th Ave Northwest" with identical BIO labels
- **Region abbreviation:** Train on both "NY" → `B-region` and "New York" → `B-region` `I-region`

Both scoped to unambiguous expansions only. ~60 lines total in corpus pipeline.

**Do NOT normalize at inference time.** SentencePiece vocabulary was learned from raw corpus distribution; feeding normalized forms at inference creates a train/test distribution mismatch. Normalize at training time only.

### 4. Reconciler as default path (architecture)

- Graceful degradation: no WOF data = Viterbi-only (current behavior). Emit `{ reconciled: false, reason: "wof-missing" }` on result.
- Optional `@mailwoman/reconciler-data-en-us` package (~5 MB): locality rows `{ id, name, parent_id }` + region rows `{ id, name }`. Enables concordance scoring for npm users.
- Full WOF (~2 GB) remains the high-accuracy path for self-hosted deployments.

## Other preset failures (different root causes)

| #   | Preset       | Failure                   | Root cause                                         | Fix                                                           |
| --- | ------------ | ------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| 3   | Pier 39      | venue=0%                  | No venue annotations at corpus scale               | Future: venue corpus. Now: hybrid mode catches via rule chain |
| 4   | W Addison St | directional prefix missed | Model hasn't seen enough directional abbreviations | Directional augmentation (#3 above) + hybrid rule fallback    |
| 5   | (passes)     | —                         | —                                                  | —                                                             |
| 6   | 90210        | postcode confidence low   | Neural postcode F1 low (1.6%)                      | Rules handle (98.8% precision in hybrid mode)                 |

## Key insight: switch demo to hybrid mode

If the demo currently runs neural-only, switching to hybrid mode immediately fixes presets #3, #4, and #6 via rule fallback — zero code changes beyond the mode flag.

## Pre-tokenization normalization — decision: NO

| Normalization                 | At inference?                | At training?                      |
| ----------------------------- | ---------------------------- | --------------------------------- |
| Directionals (NW → Northwest) | No — subword mismatch        | Yes — unambiguous, high-frequency |
| St → Street/Saint             | No — requires disambiguation | No — model learns from context    |
| Punctuation                   | SentencePiece handles it     | No                                |
| Unit notation (#)             | No — too many edge cases     | No                                |

## Relationship to QueryShape

The locality soft prior extends the existing QueryShape emission-prior system. New field on the QueryShape result:

```ts
regionAbbreviations?: Array<{ start: number; span: string }>
```

Detected at Stage 2.5 alongside format-hit scorers (regex: `/,\s*[A-Z]{2}\b/` for en-us). In `buildEmissionPriors`, for each detected abbreviation, bias preceding WOF-verified locality tokens toward `B-locality` / `I-locality`.

This fits the bitter-lesson framing test: the regex is locale-bounded (one pattern per locale's abbreviation convention), not a gazetteer lookup. The WOF verification is a safety rail, not the primary signal.

## See also

- [`QUERY_SHAPE.md`](./QUERY_SHAPE.md) — the sub-system this extends
- [`TRAINING_RECIPE_LEVERS.md`](./TRAINING_RECIPE_LEVERS.md) — training knobs including source_weights
- [`../../concepts/dual-loss-curvature-conflict.md`](../../concepts/dual-loss-curvature-conflict.md) — why CE-only training
