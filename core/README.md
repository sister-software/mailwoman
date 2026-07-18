# @mailwoman/core

**The foundation of the Mailwoman address parser** — types, tokenization,
classification primitives, solver, decoder, and the staged pipeline coordinator.
Ships ~9 MB of provenance-tracked reference dictionaries (libpostal, Who's On
First, chromium-i18n) consumed by the resolver and classifiers.

```ts
import { createRuntimePipeline, AddressParser, ComponentTag, Classification, Span } from "@mailwoman/core"

const pipeline = createRuntimePipeline({ locale: "en-US" })
const result = pipeline.parse("1600 Amphitheatre Parkway, Mountain View, CA 94043")
```

## What's inside

| Module                | Purpose                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **`types/`**          | Core type system: `ComponentTag`, `Span`, `Classification`, `ClassificationMap`, `LocaleTag`                                            |
| **`tokenization/`**   | Tokenizer primitives, whitespace/punctuation rules, token classification                                                                |
| **`classification/`** | `Classification` data structure, `ClassificationMap`, span overlap resolution                                                           |
| **`decoder/`**        | Span proposal → tree projection, BIO decoding, reconcile/merge strategies, confidence calibration                                       |
| **`pipeline/`**       | `createRuntimePipeline` — the staged pipeline coordinator that wires normalize → query-shape → locale-gate → ... → classifier → decoder |
| **`solver/`**         | Rule-based solver (the v0 rules engine), `Solution`, `Solver`                                                                           |
| **`parser/`**         | `AddressParser` — high-level parse entry point (consumed by `mailwoman` CLI)                                                            |
| **`resources/`**      | ~9 MB of shipped reference data: libpostal dictionaries, WOF place data, chromium-i18n address formats                                  |

## Key exports

```ts
// Types
export type { ComponentTag, Span, Classification, ClassificationMap, LocaleTag }

// Pipeline
export { createRuntimePipeline, type RuntimePipeline, type PipelineOpts }

// Classification
export { Classification, ClassificationMap }
export { treeToClassification, classificationToTree }

// Decoder
export { decodeBioSpans, viterbiDecode, reconcileSpans }
export { createCalibrator, type Calibrator } // isotonic confidence calibration

// Solver (v0 rules)
export { Solver, Solution }

// Tokenization
export { tokenize, Token, TokenClass }

// Resources
export { loadDictionary, getAvailableLanguages }
```

## Pipeline architecture

Mailwoman's runtime pipeline is a staged coordinator that chains pure-function
stages with typed handoffs:

```
normalize → query-shape → locale-gate → kind-classifier → phrase-grouper → classifier → decoder
```

Each stage is published as its own `@mailwoman/*` package and wired together by
the pipeline coordinator in this package. The design ensures every stage is
independently testable, benchmarkable, and replaceable.

## Reference data

This package ships immutable, provenance-tracked dictionaries consumed by the
resolver and rule-based classifiers:

- **libpostal** — multilingual street types, place names, directional/ordinal tokens
- **Who's On First** — place hierarchy and geography
- **chromium-i18n** — per-country address format templates

The dictionaries are ~9 MB total and are loaded lazily.

## Related

- [`mailwoman`](../mailwoman) — the user-facing CLI + `AddressParser`
- [`@mailwoman/normalize`](../normalize) — Stage 1 of the pipeline
- [`@mailwoman/neural`](../neural) — neural classifier (ONNX runtime)
- [What Mailwoman Is](https://mailwoman.sister.software/articles/concepts/what-mailwoman-is/)
- [Staged Pipeline Contract](https://mailwoman.sister.software/articles/plan/reference/STAGES/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
