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
export { loadTokenizer, Tokenizer, tokenizeToIds } from "./tokenizer.js"

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

## Ship-config contract

The `ProductionScorer` reads `model-card.json`'s `requires` block and
**fails closed** if a declared channel isn't fed. Do not hand-wire ONNX
sessions with zero-filled anchor inputs — anchor-off is out-of-distribution
for the shipped model.

## Related

- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — trained model bundle (en-US)
- [`@mailwoman/neural-weights-fr-fr`](../neural-weights-fr-fr) — trained model bundle (fr-FR)
- [`@mailwoman/core`](../core) — pipeline coordinator, types, decoder
- [Neural Classification concepts](https://mailwoman.sister.software/articles/concepts/neural-classification/)
- [ONNX Runtime concepts](https://mailwoman.sister.software/articles/concepts/onnx-runtime/)
- [What Mailwoman Is](https://mailwoman.sister.software/articles/concepts/what-mailwoman-is/)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/agpl-3.0.html)
