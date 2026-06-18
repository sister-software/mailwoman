---
license: agpl-3.0
language:
  - fr
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
  - name: mailwoman-neural-weights-fr-fr
    results:
      - task:
          type: token-classification
          name: Address parsing (per-component F1)
        dataset:
          type: openaddresses
          name: Mailwoman FR golden set
        metrics:
          - type: f1
            value: 0.99
            name: postcode F1 (anchor-on)
          - type: f1
            value: 0.946
            name: house_number F1 (anchor-on, canonical order)
---

# mailwoman — neural address-parser weights (fr-fr)

The trained-model bundle (`@mailwoman/neural-weights-fr-fr`) for
[Mailwoman](https://mailwoman.sister.software), a postal-address parser. This
package is **data only** — `model.onnx`, `tokenizer.model`, and metadata. It has
no JavaScript; it is loaded at inference time by `@mailwoman/neural`.

> **This locale is served by the shared multi-locale model.** The fr-fr bundle
> ships the same encoder as the en-us release at an earlier checkpoint
> (multi-locale, step 20000) — one model serves both locales. For the latest
> training provenance and recipe see the en-us card.

## What this is

Mailwoman is a **calibrated, retrieval-augmented sequence labeler over a
microlanguage** — coupled to a gazetteer that resolves its output to
coordinates. This bundle is the sequence-labeler half: a small transformer
encoder doing BIO token classification over the address schema. It is not an LLM
and nothing about it is generative; for a closed label set over short strings,
boring NER is a feature.

The design splits the problem in two: **the model learns the grammar, the
gazetteer knows the atlas.** The model never memorizes place names — postcode
and gazetteer knowledge arrive at inference as *soft input features* (anchors)
retrieved from provenance-tracked databases that grow without retraining.
Knowledge informs; it never overrides.

- **Base model:** none. Trained **from scratch** (no pretrained checkpoint).
- **Tokenizer:** SentencePiece unigram, `byte_fallback=true`.
- **Format:** ONNX int8 dynamic, opset 17, max sequence length 128.

## Intended use

Parsing free-text French postal addresses into structured components
(country, region, locality, dependent_locality, postcode, subregion, cedex,
venue, street, house_number) for **geocoding** — resolving a parsed address to
coordinates via a gazetteer/resolver. The model is the parsing front-end of that
pipeline, not a standalone geocoder.

## Ship-config requirement (read before using)

The Mailwoman model expects the soft anchor + gazetteer channels fed at
inference. Running it with those channels off is out-of-distribution and silently
collapses the admin tags (country/region/locality/postcode) — an anchor-off
metric on an anchor-trained model is systematically misleading. Construct the
scorer through `@mailwoman/neural`'s `createScorer` (the canonical
`ProductionScorer`), which reads the bundle's `requires`/channel contract and
**fails closed** if a declared channel isn't fed. Do not hand-wire the raw ONNX
session with the anchor input zero-filled. Every honest eval here is
**anchor-on**.

## Evaluation

We grade the **assembled coordinate** (the resolved place), not raw label-F1 in
isolation. For FR, the model resolves addresses well when given the correct
default country (the gazetteer holds ~114k FR places); on a real FR sample the
neural front-end out-parses the rules baseline it replaces on locality-match.

The two `model-index` entries above (postcode ≈ 0.99 F1, house_number ≈ 0.946 F1)
are the multi-locale model's strong FR tags, **anchor-on, canonical order**. Two
honest caveats on the FR numbers:

- **FR `region` is a known open gap** — F1 is low and tracked as an outstanding
  issue; do not expect region-level accuracy on FR comparable to en-us.
- **Reversed-order (postcode-first) FR house numbers are harder.** On a
  diversified golden that mixes both orders, house_number drops well below the
  canonical-order figure — the published frontier for reordered house numbers is
  ~90–91% (neural parsers collapse much further on reorder). The en-us release's
  later checkpoint adds a reversed-order shard that recovers this; this fr-fr
  bundle predates that lever.

Because the older anchor-off / pre-diversified-golden figures in this bundle's
`model-card.json` `eval` block were measured before the anchor-on grading
discipline, treat them as historical; the per-tag parity tables under
[`docs/articles/evals/`](https://mailwoman.sister.software) carry the
config-stated numbers.

## Calibration

Mailwoman confidences are isotonic-calibrated (PAVA) against held-out data and
applied **opt-in** via `@mailwoman/core`'s `createCalibrator`; default parse
output is byte-stable when calibration is omitted.

## Training

From-scratch (no pretrained base) on an NVIDIA A100 (Modal cloud), CE loss only
(the dual CRF loss diverged and was retired; CRF is inference-only Viterbi). The
gazetteer anchor channel is fed during training, which is why it is required at
inference. This bundle is the shared multi-locale model (step 20000); the en-us
card carries the full corpus + recipe provenance.

## Limitations

- **Expects its channels.** See *Ship-config requirement* — anchor-off is OOD.
- **FR `region` is an open gap** (low F1, tracked).
- **Reversed-order FR house numbers** are harder than canonical order (see
  *Evaluation*).
- **All-caps / shouting input degrades** the admin tags (mixed-case training);
  `@mailwoman/neural`'s `normalizeCase` opt recovers detected all-caps ASCII.
- **Non-Latin scripts** (CJK, Cyrillic) fall through to byte-fallback tokens;
  quality there is unmeasured.

## License & links

- **License:** [AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html).
- **Docs & concepts:** https://mailwoman.sister.software
- **Loader / scorer API:** `@mailwoman/neural` (`createScorer`).
- The functional contract for this bundle is `model-card.json`; this `README.md`
  is the HuggingFace-facing card.
