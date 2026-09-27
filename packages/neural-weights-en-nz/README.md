---
license: AGPL-3.0
language:
  - en
library_name: onnx
pipeline_tag: token-classification
tags:
  - token-classification
  - named-entity-recognition
  - address-parsing
  - postal-address
  - geocoding
  - onnx
  - sequence-labeling
---

# mailwoman — neural address-parser weights (en-nz)

The trained-model bundle (`@mailwoman/neural-weights-en-nz`) for
[Mailwoman](https://mailwoman.ai), a postal-address parser. This
package contains **data only**: a `model-card.json`, the NZ placetype-pair
retrieval index, and the shared gazetteer lexicons. It has no JavaScript logic
of its own, and `@mailwoman/neural` loads it at inference time.

> **The shared multi-locale model serves this locale.** The en-nz bundle
> ships no `model.onnx`/`tokenizer.model` of its own. It declares
> `@mailwoman/neural-weights-en-us` as its `mailwoman.baseWeights` and resolves
> the base package's model and tokenizer at runtime. The artifact is
> byte-identical, and one encoder serves both locales. This package ships the
> **NZ-specific soft-feed data**: the placetype-pair retrieval index
> (`pair-index-nz.bin`, built from the LINZ-derived OpenAddresses NZ countrywide
> register, described under _Evaluation_ below) and the shared gazetteer/country
> lexicons.

## What this is

This bundle is the NZ half of Mailwoman's retrieval data. It holds real
(child, parent) suburb/town pairs (for example, "Plimmerton" is a real suburb of
"Porirua"), which are fed to the decoder as a soft `dependent_locality` bias for
NZ input only. NZ's register repeats names across tiers, and 21.6% of its pairs
are identity pairs (suburb == town, for example "Mangawhai, Mangawhai").
`@mailwoman/neural` ≥7.8.0 added its identical-adjacent-segment rule for that
reason, and this bundle's index is that rule's data source.

Unlike the en-gb sibling, this bundle **ships no postcode-anchor binary**. No
WOF NZ postcode database exists yet, so the postcode-anchor channel is off for
en-nz. The loader logs a one-time warning instead of crashing. Building that
database is the tracked follow-up in `model-card.json`.

## Intended use

The bundle parses free-text NZ postal addresses into structured components
(locality, dependent_locality, street, house_number, …) for **geocoding**, which
resolves a parsed address to coordinates through a gazetteer or resolver.

## Ship-config requirement (read before using)

The Mailwoman model expects the soft anchor and gazetteer channels to be fed at
inference. Construct the scorer through `@mailwoman/neural`'s `createScorer`
(the canonical `ProductionScorer`). It reads the bundle's `requires`/channel
interface and **fails closed** if a declared channel is not fed. Do not
hand-wire the raw ONNX session with the anchor input zero-filled.

## Evaluation

**en-nz battery, 2026-07-24: all 6 pre-registered bars pass.** With the prior on
at the calibrated δ=10, on the shipped v385 base, the NZ suburb board (246 rows)
scored **246/246 emission and 246/246 tag-correct (100%)** as written, and
**244/246 (99.2%)** with commas stripped. The curated no-suburb board had
**0/54 false positives**. The venue-confound result is **interim**: 0/510 on a
synthetic board, because no real NZ venue-name source exists on disk yet (issue
#1279). Every GB number reproduces exactly through the same code path.
`model-card.json`'s `eval` and `notes` blocks hold the full breakdown, the
δ-sweep table, and the history of the repeated-name convention.

## Limitations

- **The model expects its channels.** See _Ship-config requirement_.
- **No NZ postcode anchor exists yet.** The anchor channel is off for en-nz until a
  WOF NZ postcode database is built (model-card follow-up).
- **Venue-confound specificity is interim.** It measured 0 FP on a synthetic
  board only, and real NZ venue-name data is still to be acquired (issue #1279).
- **The placetype-pair prior is restricted to NZ.** It cannot fire on non-NZ
  input.
- **All-caps input degrades** the admin tags, because training used mixed case.
  `@mailwoman/neural`'s `normalizeCase` option recovers detected all-caps ASCII.
- **Non-Latin scripts** (CJK, Cyrillic) fall through to byte-fallback tokens,
  and quality there is unmeasured.

## License & links

- **License:** [AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html).
- **Docs & concepts:** https://mailwoman.ai
- **Loader / scorer API:** `@mailwoman/neural` (`createScorer`).
- The functional interface for this bundle is `model-card.json`; this
  `README.md` is the HuggingFace-facing card.
