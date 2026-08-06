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
package is **data only** — a `model-card.json`, the placetype-pair retrieval
index, and the shared gazetteer lexicons. It has no JavaScript logic of its
own; it is loaded at inference time by `@mailwoman/neural`.

> **This locale is served by the shared multi-locale model.** The en-gb bundle
> ships no `model.onnx`/`tokenizer.model` of its own — it declares
> `@mailwoman/neural-weights-en-us` as its `mailwoman.baseWeights` and resolves
> the base package's model + tokenizer at runtime (byte-identical artifact; one
> encoder serves both locales). What this package ships is the **GB-specific
> soft-feed data**: the placetype-pair retrieval index (`pair-index-gb.bin`,
> built from the HM Land Registry PPD tuples — see _Evaluation_ below), plus
> the shared gazetteer/country lexicons.

> **The postcode-anchor channel runs OFF for en-gb** (2026-08-05). This bundle
> used to ship an outward-code `postcode-gb.bin`; it no longer does. The shared
> encoder's anchor input reserves one slot per country, and the GB slot was
> never trained — every training recipe fed the same US/DE/FR-only lookup — so
> supplying GB anchors pushed every GB parse along an input direction the model
> has no learned response to. Measured on the `gb-golden` board across three
> registers, exact postcode goes **294/318 → 318/318** with the anchor inert,
> and `dependent_locality` is unchanged at 207/207. `@mailwoman/neural-weights-en-nz`
> has the same posture. The placetype-pair prior is untouched.

## What this is

Mailwoman is a **calibrated, retrieval-augmented sequence labeler over a
microlanguage** — coupled to a gazetteer that resolves its output to
coordinates. This bundle is the GB-facing half of the retrieval side: the
en-us encoder's soft gazetteer + placetype-pair channels, fed with UK-specific
data so the model never has to memorize GB place names — that knowledge
arrives at inference as a retrieval, not a weight.

- **Base model:** none of its own — see `@mailwoman/neural-weights-en-us`.
- **Postcode anchor:** not shipped, deliberately — see the note above and
  `model-card.json`'s `gb_artifacts.no_postcode_bin`. The neural parser and
  the gazetteer resolver still handle full unit-postcode text; what is absent
  is the soft anchor feature, not postcode support.
- **Placetype-pair index:** a retrieval-augmented `dependent_locality` prior
  built from real (child, parent) place-name pairs (e.g. "Fishburn" is a real
  child of "Stockton-on-Tees") — a soft decode-time bias, hard-gated to GB
  input only, that never fires for any other locale. See _Evaluation_.

## Intended use

Parsing free-text UK postal addresses into structured components (country,
region, locality, dependent_locality, postcode, street, house_number, …) for
**geocoding** — resolving a parsed address to coordinates via a
gazetteer/resolver. The model is the parsing front-end of that pipeline, not a
standalone geocoder.

## Ship-config requirement (read before using)

The Mailwoman model expects its soft channels fed at inference. Running them
off is out-of-distribution and silently collapses the admin tags
(country/region/locality/postcode). Construct the scorer through
`@mailwoman/neural`'s `createScorer` (the canonical `ProductionScorer`), which
reads the bundle's `requires`/channel contract and **fails closed** if a
declared channel isn't fed. Do not hand-wire the raw ONNX session with an
input zero-filled.

The postcode anchor is the one channel where GB deviates, and it is worth
being precise about why the general rule doesn't apply. That rule holds when
the channel was trained: zeroing a trained input is out-of-distribution. The
GB anchor slot was never trained, so there is no distribution to leave —
zeroing it is what the encoder saw for every GB example it has ever been shown,
and supplying a value is the out-of-distribution case. That is why the numbers
run the other way here, and why the fix is a retrain rather than more data.

## Evaluation

**First graded GB story, 2026-07-23.** Previously this package was packaging
scaffolding only — the runtime resolution path was exercised and tested, but
no GB-specific numbers existed. That has changed: the base encoder was
fine-tuned on a `dependent_locality`-feed corpus that includes a real GB
shard, and this package's own `pair-index-gb.bin` supplies a calibrated
retrieval prior on top. Full-pipeline `dependent_locality` recall, GB golden
board (69 rows carrying the tag), prior ON at the calibrated δ=5.0: **69/69
emission, 67/69 tag-correct (97.1%)**. The two misses are pre-existing,
independently characterized parser-level cases, not prior artifacts. A
three-way ablation shows this recall is carried almost entirely by the
**prior**, not the fine-tuned checkpoint's own classifier row — see
`model-card.json`'s `notes` and `eval` blocks for the full breakdown,
including the δ-calibration sweep, the venue-confound false-positive rate
(0.738% at δ=5.0), and the comma-stripped-input trade (fully inert by design
in the current probe mode).

**The base encoder itself is a STAGED candidate, not yet promoted** — see
`@mailwoman/neural-weights-en-us`'s `model-card.json` `phase` field for the
open ship blocker (a Gauntlet metamorphic-layer regression, unrelated to GB).
Until that resolves, treat the numbers above as graded-but-unshipped: real
measurements against the actual candidate artifact, not yet the production
default. [`docs/articles/evals/`](https://mailwoman.sister.software) carries
the full scorecard once promoted.

## Calibration

Mailwoman confidences are isotonic-calibrated (PAVA) against held-out data and
applied **opt-in** via `@mailwoman/core`'s `createCalibrator`; default parse
output is byte-stable when calibration is omitted.

## Limitations

- **Expects its channels.** See _Ship-config requirement_. The one deliberate
  exception is the postcode anchor: it runs off for en-gb because the GB slot
  was never trained, and the loader says so once per load.
- **Base encoder not yet promoted** — see _Evaluation_; the numbers here are
  real but not yet the production default.
- **Placetype-pair prior is comma-segment-scoped** — it matches whole
  comma-delimited input segments only (the "segment" probe mode, default
  since d2a1242f), so comma-stripped GB input gets no boost from this channel
  (fully inert, not degraded — a documented v1 trade, not a bug). It is also
  hard-gated to GB: it structurally cannot fire on non-GB input.
- **All-caps / shouting input degrades** the admin tags (mixed-case training);
  `@mailwoman/neural`'s `normalizeCase` opt recovers detected all-caps ASCII.
- **Non-Latin scripts** (CJK, Cyrillic) fall through to byte-fallback tokens;
  quality there is unmeasured.

## License & links

- **License:** [AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html).
- **Docs & concepts:** https://mailwoman.sister.software
- **Loader / scorer API:** `@mailwoman/neural` (`createScorer`).
- The functional contract for this bundle is `model-card.json` (added
  2026-07-23, now that a GB-graded checkpoint exists); this `README.md` is the
  HuggingFace-facing card.
