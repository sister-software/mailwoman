---
license: agpl-3.0
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

# mailwoman — neural address-parser weights (en-gb)

The trained-model bundle (`@mailwoman/neural-weights-en-gb`) for
[Mailwoman](https://mailwoman.sister.software), a postal-address parser. This
package is **data only** — a `model-card.json`, the GB postcode-anchor binary,
and the shared gazetteer lexicons. It has no JavaScript logic of its own; it is
loaded at inference time by `@mailwoman/neural`.

> **This locale is served by the shared multi-locale model.** The en-gb bundle
> ships no `model.onnx`/`tokenizer.model` of its own — it declares
> `@mailwoman/neural-weights-en-us` as its `mailwoman.baseWeights` and resolves
> the base package's model + tokenizer at runtime (byte-identical artifact; one
> encoder serves both locales). What this package ships is the **GB-specific
> soft-feed data**: the outward-code postcode-anchor binary (`postcode-gb.bin`)
> built from the Royal Mail PPD postcode gazetteer, plus the shared
> gazetteer/country lexicons.

## What this is

Mailwoman is a **calibrated, retrieval-augmented sequence labeler over a
microlanguage** — coupled to a gazetteer that resolves its output to
coordinates. This bundle is the GB-facing half of the retrieval side: the
en-us encoder's soft anchor + gazetteer channels, fed with UK-specific data so
the model never has to memorize GB postcodes or place names — that knowledge
arrives at inference as a retrieval, not a weight.

- **Base model:** none of its own — see `@mailwoman/neural-weights-en-us`.
- **Postcode anchor:** GB is aggregated to the **outward code** (`SW1A`, not
  the full unit `SW1A 1AA`) — 2.7M unit postcodes is both too large for the
  browser budget and finer-grained than an anchor needs. A full unit code that
  misses the exact lookup falls back to its outward code automatically (see
  `@mailwoman/neural`'s `extractPostcodeAnchors`).

## Intended use

Parsing free-text UK postal addresses into structured components (country,
region, locality, dependent_locality, postcode, street, house_number, …) for
**geocoding** — resolving a parsed address to coordinates via a
gazetteer/resolver. The model is the parsing front-end of that pipeline, not a
standalone geocoder.

## Ship-config requirement (read before using)

The Mailwoman model expects the soft anchor + gazetteer channels fed at
inference. Running it with those channels off is out-of-distribution and
silently collapses the admin tags (country/region/locality/postcode) — an
anchor-off metric on an anchor-trained model is systematically misleading.
Construct the scorer through `@mailwoman/neural`'s `createScorer` (the
canonical `ProductionScorer`), which reads the bundle's `requires`/channel
contract and **fails closed** if a declared channel isn't fed. Do not hand-wire
the raw ONNX session with the anchor input zero-filled.

## Evaluation

GB-specific per-tag evaluation numbers are not yet published for this bundle —
the en-GB training arc is in progress. Until a GB-graded checkpoint ships,
treat this package as **packaging scaffolding**: the runtime resolution path
(base-model overlay + GB postcode anchor) is exercised and tested, but the
model itself carries no GB-specific fine-tuning yet. See the en-us card for the
shared encoder's provenance and grade, and
[`docs/articles/evals/`](https://mailwoman.sister.software) for the latest
per-tag parity tables once GB numbers land.

## Calibration

Mailwoman confidences are isotonic-calibrated (PAVA) against held-out data and
applied **opt-in** via `@mailwoman/core`'s `createCalibrator`; default parse
output is byte-stable when calibration is omitted.

## Limitations

- **Expects its channels.** See _Ship-config requirement_ — anchor-off is OOD.
- **No GB-specific model fine-tuning yet** — see _Evaluation_.
- **GB postcode anchor is outward-only** — expect district-level (not
  unit-level) centroid precision from the anchor channel itself; the neural
  parser + gazetteer resolver still handle full unit-postcode text.
- **All-caps / shouting input degrades** the admin tags (mixed-case training);
  `@mailwoman/neural`'s `normalizeCase` opt recovers detected all-caps ASCII.
- **Non-Latin scripts** (CJK, Cyrillic) fall through to byte-fallback tokens;
  quality there is unmeasured.

## License & links

- **License:** [AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html).
- **Docs & concepts:** https://mailwoman.sister.software
- **Loader / scorer API:** `@mailwoman/neural` (`createScorer`).
- The functional contract for this bundle is `model-card.json` (added once a
  GB-graded checkpoint ships); this `README.md` is the HuggingFace-facing card.
