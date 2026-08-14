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

# mailwoman — neural address-parser weights (en-nz)

The trained-model bundle (`@mailwoman/neural-weights-en-nz`) for
[Mailwoman](https://mailwoman.sister.software), a postal-address parser. This
package is **data only** — a `model-card.json`, the NZ placetype-pair
retrieval index, and the shared gazetteer lexicons. It has no JavaScript logic
of its own; it is loaded at inference time by `@mailwoman/neural`.

> **This locale is served by the shared multi-locale model.** The en-nz bundle
> ships no `model.onnx`/`tokenizer.model` of its own — it declares
> `@mailwoman/neural-weights-en-us` as its `mailwoman.baseWeights` and resolves
> the base package's model + tokenizer at runtime (byte-identical artifact; one
> encoder serves both locales). What this package ships is the **NZ-specific
> soft-feed data**: the placetype-pair retrieval index (`pair-index-nz.bin`,
> built from the LINZ-derived OpenAddresses NZ countrywide register — see
> _Evaluation_ below), plus the shared gazetteer/country lexicons.

## What this is

The NZ-facing half of Mailwoman's retrieval side: real (child, parent)
suburb/town pairs (e.g. "Plimmerton" is a real suburb of "Porirua") fed to the
decoder as a soft `dependent_locality` bias, hard-gated to NZ input only. NZ's
register genuinely repeats names across tiers — 21.6% of its pairs are
identity pairs (suburb == town, e.g. "Mangawhai, Mangawhai") — which is why
`@mailwoman/neural` ≥7.8.0's identical-adjacent-segment rule exists; this
bundle's index is that rule's data source.

Unlike the en-gb sibling, **no postcode-anchor binary ships** — no WOF NZ
postcode shard exists yet, so the postcode-anchor channel resolves OFF for
en-nz (a loud one-time warning, not a crash). Building that shard is the
tracked follow-up in `model-card.json`.

## Intended use

Parsing free-text NZ postal addresses into structured components (locality,
dependent_locality, street, house_number, …) for **geocoding** — resolving a
parsed address to coordinates via a gazetteer/resolver.

## Ship-config requirement (read before using)

The Mailwoman model expects the soft anchor + gazetteer channels fed at
inference. Construct the scorer through `@mailwoman/neural`'s `createScorer`
(the canonical `ProductionScorer`), which reads the bundle's
`requires`/channel contract and **fails closed** if a declared channel isn't
fed. Do not hand-wire the raw ONNX session with the anchor input zero-filled.

## Evaluation

**en-nz battery, 2026-07-24 — all 6 pre-registered bars PASS.** Prior ON at
the calibrated δ=10, on the shipped v385 base: NZ suburb board (246 rows)
as-written **246/246 emission, 246/246 tag-correct (100%)**; comma-stripped
**244/246 (99.2%)**; curated no-suburb board **0/54 false positives**. The
venue-confound read is **interim** — 0/510 on a synthetic board; no real NZ
venue-name source exists on disk yet (issue #1279). Every GB number reproduces
exactly through the same code path. Full breakdown, δ-sweep table, and the
repeated-name-convention story: `model-card.json`'s `eval` and `notes` blocks.

## Limitations

- **Expects its channels** — see _Ship-config requirement_.
- **No NZ postcode anchor yet** — the anchor channel is OFF for en-nz until a
  WOF NZ postcode shard is built (model-card follow-up).
- **Venue-confound specificity is interim** — measured 0 FP on a synthetic
  board only; real NZ venue-name data is an open acquisition (issue #1279).
- **Placetype-pair prior is hard-gated to NZ** — it structurally cannot fire
  on non-NZ input.
- **All-caps / shouting input degrades** the admin tags (mixed-case training);
  `@mailwoman/neural`'s `normalizeCase` opt recovers detected all-caps ASCII.
- **Non-Latin scripts** (CJK, Cyrillic) fall through to byte-fallback tokens;
  quality there is unmeasured.

## License & links

- **License:** [AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html).
- **Docs & concepts:** https://mailwoman.sister.software
- **Loader / scorer API:** `@mailwoman/neural` (`createScorer`).
- The functional contract for this bundle is `model-card.json`; this
  `README.md` is the HuggingFace-facing card.
