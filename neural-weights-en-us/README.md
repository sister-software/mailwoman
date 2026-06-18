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
metrics:
  - f1
model-index:
  - name: mailwoman-neural-weights-en-us
    results:
      - task:
          type: token-classification
          name: Address parsing (assembled-coordinate)
        dataset:
          type: openaddresses
          name: OpenAddresses US (2000 real government address points)
        metrics:
          - type: accuracy
            value: 0.978
            name: locality-match (anchor-on, full pipeline, localadmin-credited)
          - type: accuracy
            value: 0.999
            name: region-match (anchor-on, full pipeline)
          - type: distance
            value: 3.3
            name: coordinate p50 km — admin-centroid tier (parser + admin gazetteer, no point data)
          - type: distance
            value: 0.0
            name: coordinate p50 km — full geocode cascade (with situs + interpolation data layer)
          - type: distance
            value: 1.0
            name: coordinate p90 km — full geocode cascade (with situs + interpolation data layer)
          - type: accuracy
            value: 0.859
            name: within 100 m — full geocode cascade (with situs + interpolation data layer)
---

# mailwoman — neural address-parser weights (en-us)

The trained-model bundle (`@mailwoman/neural-weights-en-us`) for
[Mailwoman](https://mailwoman.sister.software), a postal-address parser. This
package is **data only** — `model.onnx`, `tokenizer.model`, and metadata. It has
no JavaScript; it is loaded at inference time by `@mailwoman/neural`.

## What this is

Mailwoman is a **calibrated, retrieval-augmented sequence labeler over a
microlanguage** — coupled to a gazetteer that resolves its output to
coordinates. This bundle is the sequence-labeler half: a small transformer
encoder (≈29.6M params) doing BIO token classification over a 33-label address
schema. It is not an LLM and nothing about it is generative; for a closed label
set over short strings, boring NER is a feature.

The design splits the problem in two: **the model learns the grammar, the
gazetteer knows the atlas.** The model never memorizes place names — postcode
and gazetteer knowledge arrive at inference as *soft input features* (anchors)
retrieved from provenance-tracked databases that grow without retraining. If you
know RAG from the LLM world, this is RAG for token classification; if you know
speech recognition, it's contextual biasing with shallow fusion. Knowledge
informs; it never overrides.

- **Base model:** none. Trained **from scratch** (no pretrained checkpoint) —
  see *Training*.
- **Architecture:** 6 layers, hidden 384, 6 heads, intermediate 1536, vocab
  48000, max sequence length 128. Linear-chain CRF at inference (Viterbi), CE
  loss only at training.
- **Tokenizer:** SentencePiece unigram, `byte_fallback=true`, vocab 48000.
- **Format:** ONNX int8 dynamic (≈29.8 MB), opset 17; fp32 source ≈118.4 MB.

## Intended use

Parsing free-text postal addresses into structured components
(country, region, locality, dependent_locality, postcode, subregion, cedex,
venue, street, house_number, street_prefix, street_suffix, unit, po_box,
intersection) for **geocoding** — resolving a parsed address to coordinates via
a gazetteer/resolver. The model is the parsing front-end of that pipeline, not a
standalone geocoder.

## Ship-config requirement (read before using)

This model was **trained with the soft anchor + gazetteer channels fed**, and it
expects them at inference. Running it with those channels off is
out-of-distribution and silently collapses the admin tags
(country/region/locality/postcode). The bundled `model-card.json` declares the
required channels in its `requires` block:

```jsonc
"requires": {
  "anchor":      { "required": true },
  "gazetteer":   { "required": true },
  "conventions": { "required": true, "mode": "auto" },
  "bridge":      { "required": false },
  "suppress_gazetteer_near_postcode": true
}
```

Construct the scorer through `@mailwoman/neural`'s `createScorer` (the canonical
`ProductionScorer`): it reads `requires` and **fails closed** if a declared
channel isn't actually fed. Do not hand-wire the raw ONNX session with the anchor
input zero-filled — that is the documented "anchor-off" trap that makes the model
look far worse than it is. Every honest eval here is **anchor-on**.

## Evaluation

We grade the **assembled coordinate** (the resolved place), not raw label-F1 in
isolation — a model can win on labels while the assembled address resolves to the
wrong city. All numbers below are the production-faithful, **anchor-on**
configuration on the currently shipped model (lineage `v1.5.0-fr-order`, step
40000; `model.onnx` md5 `4674d348…`).

**Assembled coordinates — OpenAddresses US (real government address points),
anchor-on, currently shipped model:**

| metric | value |
| --- | --: |
| locality-match | 97.8% |
| region-match | 99.9% |
| coordinate p50 — admin-centroid tier | 3.3 km |
| coordinate p50 — full geocode cascade | **0.0 km** |
| coordinate p90 — full geocode cascade | **1.0 km** |
| within 100 m — full geocode cascade | **85.9%** |

**The two coordinate tiers matter.** The parser plus the admin gazetteer alone
resolve to the locality **centroid** — legitimately a few km from an edge address
(p50 3.3 km). The full geocode pipeline (`mailwoman`'s `geocode` cascade) wires a
per-state situs + interpolation data layer on top and resolves the actual point:
**79.8% of US addresses land on an exact address-point, 8.2% on a street
interpolation, and only 12% fall back to the centroid — p50 0.0 km, 85.9% within
100 m.** That data layer is the released data the geocoder consumes, not part of
this weights package; see the situs-cascade eval under
[`docs/articles/evals/`](https://mailwoman.sister.software) for the breakdown.

Two more notes on reading these:

- **The model is not the bottleneck; the resolver lands the right place.**
  locality-match credits the resolver's full locality group (locality ∪ borough ∪
  `localadmin`) — New England towns are `localadmin` in the gazetteer, which an
  earlier metric discarded, under-counting locality-match by ~14pp (the corrected
  metric is 97.8%). The small residual (~2%) is mostly civic-suffix name-mismatch
  ("Barre City" vs the gazetteer's "Barre"), not absent places — a naming-convention
  artifact more than a coverage hole.
- **Structured types are where the neural front-end clearly leads** the rules
  baseline it replaces: on templated PO boxes, units, and intersections the
  rules port emits 0% correct structure (no `po_box` tag, dropped intersection
  side, stripped unit designator) where this model emits them, because it was
  trained on that negative space.

Per-tag F1 (golden set, production-faithful anchor-on, indicative — these are
diagnostic floors on a hard set, not the headline coordinate metric): us.locality
≈ 77.9, us.region ≈ 90.5, us.street ≈ 80.2, us.house_number ≈ 98.3,
us.country ≈ 68.4. See the eval reports under
[`docs/articles/evals/`](https://mailwoman.sister.software) for the full per-tag
parity tables and the config behind each number.

## Calibration

Confidences are isotonic-calibrated (PAVA) against held-out data, so "0.6" means
right about 60% of the time. Held-out ECE: 0.067 raw → 0.0035 calibrated. The
`calibration.json` / `calibration-per-locale.json` artifacts apply **opt-in** via
`@mailwoman/core`'s `createCalibrator`; default parse output is byte-stable when
they are omitted.

## Training

From-scratch (no pretrained base), 40000 steps on an NVIDIA A100 (Modal cloud),
CE loss only (the dual CRF loss diverged and was retired; CRF is inference-only
Viterbi). Corpus v0.5.0 (char-offset span labels: from-source base plus
re-emitted parity overlays) augmented with a reversed-order (postcode-first) FR
shard so the model stops mistaking a leading FR postcode for a house number. The
gazetteer anchor channel is fed during training, which is why it is required at
inference.

## Limitations

- **Expects its channels.** See *Ship-config requirement* — anchor-off is OOD.
- **All-caps / shouting input degrades** the admin tags (mixed-case training).
  `@mailwoman/neural`'s `normalizeCase` opt title-cases detected all-caps ASCII
  input before the model and recovers it (byte-stable for mixed-case / non-ASCII
  input, which it leaves untouched).
- **Coverage, not precision, is the frontier** for the assembled coordinate:
  where local rooftop/interpolation data is absent the coordinate is the
  admin-centroid (legitimately tens of km from an edge address); the parse is not
  the bottleneck.
- **Non-Latin scripts** (CJK, Cyrillic) fall through to byte-fallback tokens;
  quality there is unmeasured.

## License & links

- **License:** [AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html).
- **Docs & concepts:** https://mailwoman.sister.software
- **Loader / scorer API:** `@mailwoman/neural` (`createScorer`).
- The functional contract for this bundle is `model-card.json` (versions,
  lineage, labels, calibration, `requires`); this `README.md` is the
  HuggingFace-facing card.
