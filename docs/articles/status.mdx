---
sidebar_position: 1
title: Status
description: What ships today, what's behind a flag, and what's still experimental.
---

# Status

This page is the single source of truth for what works in Mailwoman right now. It is updated on every release.

## Packages

| Package                           | npm version | Description                                                         |
| --------------------------------- | ----------- | ------------------------------------------------------------------- |
| `mailwoman`                       | 2.1.0       | CLI + high-level `AddressParser` entry point                        |
| `@mailwoman/core`                 | 2.1.0       | Tokenization, classification, solver, decoder, policy registry      |
| `@mailwoman/classifiers`          | 2.1.0       | Rule-based classifiers (postcode, street, venue, WOF dictionaries)  |
| `@mailwoman/neural`               | 2.1.0       | ONNX runtime + SentencePiece tokenizer + neural classifier wrapper  |
| `@mailwoman/neural-weights-en-us` | 3.0.0       | Trained model bundle (US English)                                   |
| `@mailwoman/neural-weights-fr-fr` | 3.0.0       | Trained model bundle (FR French)                                    |
| `@mailwoman/phrase-grouper`       | 2.1.0       | Rule-based span boundary proposal (Stage 2.7)                       |
| `@mailwoman/normalize`            | 2.1.0       | Unicode normalization + whitespace collapsing (Stage 1)             |
| `@mailwoman/query-shape`          | 2.1.0       | Structural input priors (script class, postcode format detection)   |
| `@mailwoman/kind-classifier`      | 2.1.0       | Query category classifier (postcode_only, structured_address, etc.) |
| `@mailwoman/resolver-wof-wasm`    | 0.1.0       | Browser-side WOF resolver (SQLite via WASM)                         |
| `@mailwoman/neural-web`           | 0.1.0       | Browser-side neural classifier (onnxruntime-web)                    |

## Model weights

| Property             | Value                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Shipped version**  | v0.4.0 (npm `@mailwoman/neural-weights-en-us@3.0.0`)                                                                  |
| **Architecture**     | 8.87M params — 6-layer transformer encoder, 256 hidden dim, 4 attention heads                                         |
| **Label vocabulary** | 21 BIO labels: country, region, locality, dependent_locality, postcode, subregion, cedex, venue, street, house_number |
| **Training corpus**  | corpus-v0.3.0 (677M aligned rows)                                                                                     |
| **Tokenizer**        | SentencePiece unigram, 16K vocab, byte_fallback=true                                                                  |
| **CRF**              | Linear-chain CRF with frozen BIO structural mask — Viterbi decode at inference                                        |
| **Size**             | ~25 MB (int8-quantized ONNX + tokenizer)                                                                              |

### Per-component F1 on golden v0.1.2 (4,535 entries)

| Component    | F1   | Notes                                                |
| ------------ | ---- | ---------------------------------------------------- |
| house_number | 0.79 | Usable                                               |
| postcode     | 0.69 | Regressed from v0.3.0's 0.76 (NAD downweight effect) |
| venue        | 0.39 | Low                                                  |
| street       | 0.30 | Low                                                  |
| locality     | 0.27 | Rule classifiers carry this in practice              |
| country      | 0.21 | Mostly adversarial transliteration eval noise        |
| region       | 0.19 | Rule classifiers carry this in practice              |

Full-parse exact match: ~0.08 (model gets every component right on 8% of addresses). In practice, the hybrid system — rule classifiers carrying coarse components, neural on house_number and street — performs better than per-tag neural numbers alone suggest.

### Known regressions

- **Postcode F1 0.69** (v0.3.0: 0.76). Caused by NAD source downweight removing "postcode-first" positional patterns from training. v0.5.0 targets recovery.
- **Coarse labels (country, region, locality) are rule-carried.** The neural model's per-tag F1 on these is low. The rule-based WOF dictionary classifiers handle them in practice.
- **Non-Latin scripts.** The v0.1.0 tokenizer falls back to raw bytes on CJK, Cyrillic, and other non-Latin scripts. The A1 tokenizer (48K vocab, trained on corpus-v0.4.0) halves byte-fallback but is not yet used in a stable classifier.

## Runtime pipeline — stage status

| Stage | Name             | Status     | Notes                                                                                                                                                                           |
| ----- | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Normalize        | ✅ default | NFC, whitespace collapse, locale-aware case folding                                                                                                                             |
| 2     | Locale gate      | 🚩 opt-in  | Workspace ships (`@mailwoman/locale-gate`); not wired as factory default. Falls back to caller-provided locale hint.                                                            |
| 2.5   | Kind classifier  | ✅ default | Rule-based. Fast-paths bare postcodes and single localities.                                                                                                                    |
| 2.7   | Phrase grouper   | ✅ default | Rule-based (`@mailwoman/phrase-grouper`). Proposes coherent spans before classification.                                                                                        |
| 3     | Token classify   | ✅ default | Neural (9M-param encoder) + rule classifiers. Hybrid via policy registry.                                                                                                       |
| 4     | Sequence correct | ✅ default | CRF with frozen BIO structural mask + Viterbi decode. Prevents orphan I-tags.                                                                                                   |
| 5     | Reconcile        | 🚩 opt-in  | Joint decoding with WOF concordance scoring. Implemented but requires `forceJointReconcile` flag and classifier with `parseWithLogits` support. Argmax fallback is the default. |
| 6     | Resolve          | 🚩 opt-in  | WOF SQLite gazetteer lookup. Returns administrative/postcode-level place candidates, not rooftop/address-point coordinates.                                                     |

## Browser demo

The live demo at [mailwoman.sister.software/demo](https://mailwoman.sister.software/demo) runs:

- Neural classifier (~25 MB ONNX) via `@mailwoman/neural-web` + `onnxruntime-web`
- WOF locality database (~35 MB SQLite) via `@mailwoman/resolver-wof-wasm` + `sqlite-wasm`
- Total cold load: ~60 MB, cached after first visit

The demo does **not** use the full runtime pipeline coordinator. It loads the neural classifier directly and calls `classifier.parse(text)` — the argmax path. Joint reconcile is not active in the demo.

## Training state (May 2026)

| Item                 | State                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| CE-only smoke        | **Passed.** `crf_loss_weight=0.0` trained past step 2000 without divergence. val_macro_f1=0.444 — best in project history. |
| CE-only full 50K run | **In progress.** If stable: first v0.5.0 weights.                                                                          |
| A1 tokenizer         | Trained (48K vocab, byte-fallback 36.7% → 18.2%). Not yet used in a stable classifier.                                     |
| corpus-v0.4.0        | Built (v0.3.0 + 4,771 kryptonite + ~73K transliteration pairs). No stable classifier trained on it yet.                    |

## What is not supported today

- Rooftop or address-point geocoding. The resolver returns place-level candidates (locality/region/postcode), not delivery-point coordinates.
- Multi-locale ensemble (en-US + fr-FR in the same runtime).
- Japanese addresses. Phase 6 validation stress test, deferred.
- PO boxes, unit/apartment numbers, attention lines. Tier 3 label expansion, deferred.
- Fine-tuning from a pretrained model. Weights train from scratch on Mailwoman's corpus.
- Server-side API. The runtime is a library, not a service.
