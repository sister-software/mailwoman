# @mailwoman/neural-weights-fr-fr

Stage 2 (coarse + venue/street/house_number) Mailwoman neural-classifier weights.

- locale: **fr-fr**
- corpus: **0.3.0**
- training steps: **2200**
- hardware: **AMD Radeon 780M (gfx1103) bf16 ~14.6 GiB GTT**

## Per-component F1 targets

**⚠ Below per-component F1 targets:**

- `country` F1 = **0.2112** (target ≥0.95)
- `region` F1 = **0.1883** (target ≥0.95)
- `locality` F1 = **0.2736** (target ≥0.95)
- `postcode` F1 = **0.6916** (target ≥0.95)
- `venue` F1 = **0.3886** (target ≥0.60)
- `street` F1 = **0.3016** (target ≥0.70)
- `house_number` F1 = **0.7866** (target ≥0.80)

## Eval (golden set)

- entries: **4535**
- full-parse exact match: **0.0818**
- mean token confidence: **0.8063**

## Components supported

Stage 2 ships coarse (country / region / locality / dependent_locality / postcode / subregion / cedex) plus fine-grained venue / street / house_number. Token classifier emits 21 BIO labels.

## Files

- `model.onnx` — int8-quantized ONNX model.
- `tokenizer.model` — SentencePiece unigram tokenizer (matches the corpus version).
- `model-card.json` — ModelCard with training + eval metadata.

## Loader

Loaded at runtime by `@mailwoman/neural`. This package contains no JS code.
