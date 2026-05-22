# @mailwoman/neural-weights-en-us

Stage 2 (coarse + venue/street/house_number) Mailwoman neural-classifier weights.

- locale: **en-us**
- corpus: **0.3.0**
- training steps: **1800**
- hardware: **AMD Radeon 780M (gfx1103) bf16 ~14.6 GiB GTT**

## Per-component F1 targets

**⚠ Below per-component F1 targets:**

- `country` F1 = **0.2796** (target ≥0.95)
- `region` F1 = **0.1759** (target ≥0.95)
- `locality` F1 = **0.2657** (target ≥0.95)
- `postcode` F1 = **0.7554** (target ≥0.95)
- `venue` F1 = **0.3941** (target ≥0.60)
- `street` F1 = **0.2660** (target ≥0.70)
- `house_number` F1 = **0.7835** (target ≥0.80)

## Eval (golden set)

- entries: **4535**
- full-parse exact match: **0.1074**
- mean token confidence: **0.8566**

## Components supported

Stage 2 ships coarse (country / region / locality / dependent_locality / postcode / subregion / cedex) plus fine-grained venue / street / house_number. Token classifier emits 21 BIO labels.

## Files

- `model.onnx` — int8-quantized ONNX model.
- `tokenizer.model` — SentencePiece unigram tokenizer (matches the corpus version).
- `model-card.json` — ModelCard with training + eval metadata.

## Loader

Loaded at runtime by `@mailwoman/neural`. This package contains no JS code.

