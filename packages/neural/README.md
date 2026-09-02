# @mailwoman/neural

**Neural address classifier** — SentencePiece tokenizer, ONNX runtime inference,
and decoder wiring for the Mailwoman address parser.

This is the engine that runs the trained transformer model (shipped separately
as `@mailwoman/neural-weights-en-us` and `@mailwoman/neural-weights-fr-fr`).
It handles tokenization, ONNX session management, soft-feature injection (anchor,
gazetteer), Viterbi decoding, and the `ProposalClassifier` / `ProductionScorer`
high-level APIs.

```ts
import { createScorer, loadTokenizer, loadModel } from "@mailwoman/neural"

// Load a weights bundle (model.onnx + tokenizer.model + model-card.json)
const scorer = await createScorer({
	weightsPath: "path/to/neural-weights-en-us",
})
const result = scorer.score(tokens)

// Or at a lower level
const tokenizer = await loadTokenizer("path/to/tokenizer.model")
const session = await loadModel("path/to/model.onnx")
```

## What's inside

| Module                            | Purpose                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **`tokenizer.ts`**                | SentencePiece unigram tokenizer (loads `.model` file)                                                                     |
| **`onnx-runner.ts`**              | ONNX Runtime Web inference session (WebGPU / WASM backends)                                                               |
| **`classifier.ts`**               | `NeuralAddressClassifier` — tokenize → run → decode                                                                       |
| **`scorer.ts`**                   | `createScorer` / `ProductionScorer` — canonical entry point that reads `requires` from `model-card.json` and fails closed |
| **`anchor-inference.ts`**         | Postcode anchor feature injection (soft channel, not override)                                                            |
| **`gazetteer-inference.ts`**      | Gazetteer lexicon soft-feature injection                                                                                  |
| **`viterbi.ts`**                  | Viterbi decoder (linear-chain CRF) with BIO transition masks                                                              |
| **`labels.ts`**                   | Label index ↔ `ComponentTag` mapping                                                                                      |
| **`weights.ts`**                  | Weight loading from `@mailwoman/neural-weights-*` bundles                                                                 |
| **`soft-features.ts`**            | Soft-feature vector construction (anchor + gazetteer channels)                                                            |
| **`postcode-anchor.ts`**          | Postcode extraction and anchor coordinate resolution                                                                      |
| **`postcode-binary-resolver.ts`** | Sorted-binary postcode lookup (browser)                                                                                   |
| **`query-shape-prior.ts`**        | Query-shape-based emission priors                                                                                         |
| **`span-proposal-prior.ts`**      | Phrase-grouper-based span proposal priors                                                                                 |
| **`span-proposer-lexicon.ts`**    | Lexicon-based span proposals                                                                                              |
| **`proposal-classifier.ts`**      | Proposal-level classification wrapper                                                                                     |
| **`case-normalize.ts`**           | All-caps case normalization before the model                                                                              |

## Key exports

```ts
// Canonical entry point — respects model-card.json "requires" contract
export { createScorer, ProductionScorer, type Scorer } from "./scorer.js"

// Tokenizer (SentencePiece unigram, byte_fallback)
export { loadTokenizer, Tokenizer, tokenizeToIDs } from "./tokenizer.js"

// ONNX inference
export { loadModel, createOrtSession, OnnxRunner } from "./onnx-runner.js"

// Neural classifier
export { NeuralAddressClassifier } from "./classifier.js"

// Decoder (Viterbi + BIO masks + argmax)
export { viterbi, softmax, perTokenArgmax, buildBioTransitionMask } from "./viterbi.js"

// Label mapping
export { labelIndexToClassification, classificationToLabelIndices } from "./labels.js"

// Weight loading
export { loadFromWeights, type WeightsBundle } from "./weights.js"

// Anchor + gazetteer features (soft channels, never overrides)
export { AnchorInference, type AnchorResult } from "./anchor-inference.js"
export { GazetteerInference } from "./gazetteer-inference.js"

// Postcode lookup
export { extractPostcodeAnchors } from "./postcode-anchor.js"
export { PostcodeBinaryResolver } from "./postcode-binary-resolver.js"

// Case normalization
export { normalizeCase, type CaseNormalizeResult } from "./case-normalize.js"
```

## PFX1 — what a partial postcode asserts

`postcode-prefix-index.ts` is the reader and writer for PFX1, a sealed binary index keyed by postcode **prefix**: a GB outward code, or a US 3-digit sectional center. A node carries the admin ancestry that prefix asserts, the number of units observed under it, and — when the source can place it — a centroid.

The coordinate is optional and its absence is meaningful. A node that cannot be placed carries ancestry and no `lat`/`lon`, never `0,0`.

`radiusP95Km` is **mandatory beside a coordinate**, and that is the format's most required rule. A GB outward district and a US sectional center are both "a prefix with a centroid" and they differ by more than an order of magnitude — GB outward has a 3.24 km median p95 radius, the US SCF tier 53.56 km. A consumer reading a coordinate without its radius cannot tell them apart, and one of the two is nearly worthless for the use it would be put to.

Two indexes ship today:

| scope                         |         nodes | median `radiusP95Km` | ancestry                                |
| ----------------------------- | ------------: | -------------------: | --------------------------------------- |
| `gb-esw` (OS Code-Point Open) | 2,863 outward |              3.24 km | country → constituent country           |
| `us` (WOF + point-in-polygon) |       915 SCF |             53.56 km | country → region, on **unanimity** only |

The US arm asserts a region only when every clean unit under the prefix lands in the same one. Twenty-five sectional centers span two or three states and assert the country alone — the same rule GB uses for its border-straddling postcode areas.

The layout is specified normatively in [`pfx1.ksy`](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/pfx1.ksy), and a conformance test walks the serializer's bytes against that document rather than against itself.

## Ship-config contract

The `ProductionScorer` reads `model-card.json`'s `requires` block and
**fails closed** if a declared channel isn't fed. Do not hand-wire ONNX
sessions with zero-filled anchor inputs — anchor-off is out-of-distribution
for the shipped model.

## Related

- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — trained model bundle (en-US)
- [`@mailwoman/neural-weights-fr-fr`](../neural-weights-fr-fr) — trained model bundle (fr-FR)
- [`@mailwoman/core`](../core) — pipeline coordinator, types, decoder
- [Neural Classification concepts](https://mailwoman.ai/articles/concepts/neural-classification/)
- [ONNX Runtime concepts](https://mailwoman.ai/articles/concepts/onnx-runtime/)
- [What Mailwoman Is](https://mailwoman.ai/docs/developers/get-started/what-mailwoman-is)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
