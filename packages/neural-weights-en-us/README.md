# @mailwoman/neural-weights-en-us

> **⚠ SMOKE BUILD — NOT PRODUCTION WEIGHTS.** This package was assembled from a Phase 2 smoke training run to validate the pipeline end-to-end. The model is undertrained and does not meet the §6 success criteria. Replace with weights from a full GPU-host training run before publishing.

Phase 2 / Stage 1 (coarse) Mailwoman neural-classifier weights.

- locale: **en-us**
- corpus: **corpus-v0.1.1**
- training steps: **200**
- hardware: **cuda (smoke)**

## Eval (golden set)

- entries: **74**
- full-parse exact match: **0.0000**
- mean token confidence: **0.1628**

## Components supported

Stage 1 ships coarse-only: country / region / locality / dependent_locality / postcode / subregion / cedex. Street- and venue-level components are explicit future phases.

## Files

- `model.onnx` — int8-quantized ONNX model.
- `tokenizer.model` — SentencePiece unigram tokenizer (matches the corpus version).
- `model-card.json` — ModelCard with training + eval metadata.

## Loader

Loaded at runtime by `@mailwoman/neural`. This package contains no JS code.
