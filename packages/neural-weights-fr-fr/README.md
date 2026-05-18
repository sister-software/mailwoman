# @mailwoman/neural-weights-fr-fr

Phase 2 / Stage 1 (coarse) Mailwoman neural-classifier weights.

- locale: **fr-fr**
- corpus: **0.1.1**
- training steps: **6000**
- hardware: **AMD Radeon 780M (gfx1103) bf16 14.6 GiB VRAM**

## Phase 2 §6 status

**⚠ Below Phase 2 §6 targets (≥95% F1):**

- `country` F1 = **0.0000** (target ≥0.95)
- `region` F1 = **0.1045** (target ≥0.95)
- `locality` F1 = **0.0420** (target ≥0.95)
- `postcode` F1 = **0.0000** (target ≥0.95)

## Eval (golden set)

- entries: **74**
- full-parse exact match: **0.0000**
- mean token confidence: **0.8653**

## Components supported

Stage 1 ships coarse-only: country / region / locality / dependent_locality / postcode / subregion / cedex. Street- and venue-level components are explicit future phases.

## Files

- `model.onnx` — int8-quantized ONNX model.
- `tokenizer.model` — SentencePiece unigram tokenizer (matches the corpus version).
- `model-card.json` — ModelCard with training + eval metadata.

## Loader

Loaded at runtime by `@mailwoman/neural`. This package contains no JS code.
