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

Each directory under `lib/` holds one role, and a directory's module is its sibling file.

| Directory                                                                 | Role                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **`classifier.ts`**, **`classifier/`**                                    | `NeuralAddressClassifier`, its loader and options, the scorer and the proposal adapter     |
| **`input/`**                                                              | The SentencePiece tokenizer and the character encoder                                      |
| **`channels/`**                                                           | The soft-feature channels fed beside the pieces: anchor, gazetteer, country and code units |
| **`onnx/`**                                                               | The ONNX runners and the tensor feeds they share                                           |
| **`prior/`**                                                              | Emission priors: query shape, FST and street morphology                                    |
| **`decode/`**                                                             | The Viterbi and semi-Markov decoders, the passes over their paths, and the parse trace     |
| **`repair/`**                                                             | Repairs applied to a decoded sequence                                                      |
| **`labels.ts`**, **`labels/`**                                            | The label sets, the label schema, the semantic tag registry and the address-system table   |
| **`weights.ts`**, **`weights/`**                                          | Weight loading from `@mailwoman/neural-weights-*` bundles                                  |
| **`postcode/`**, **`span/`**, **`pair/`**, **`placetype/`**, **`venue/`** | One evidence source each: its lookup, its prior and its repair                             |
| **`web/`**                                                                | The browser loader and runner                                                              |

## Key exports

```ts
// Canonical entry point — respects model-card.json "requires" interface
export { createScorer, ProductionScorer, type Scorer } from "./classifier/scorer.js"

// Tokenizer (SentencePiece unigram, byte_fallback)
export { loadTokenizer, Tokenizer, tokenizeToIDs } from "./input/tokenizer.js"

// ONNX inference
export { loadModel, createOrtSession, OnnxRunner } from "./onnx-runner.js"

// Neural classifier
export { NeuralAddressClassifier } from "./classifier.js"

// Decoder (Viterbi + BIO masks + argmax)
export { viterbi, softmax, perTokenArgmax, buildBioTransitionMask } from "./decode/viterbi.js"

// Label mapping
export { labelIndexToClassification, classificationToLabelIndices } from "./labels.js"

// Weight loading
export { loadFromWeights, type WeightsBundle } from "./weights.js"

// Anchor + gazetteer features (soft channels, never overrides)
export { AnchorInference, type AnchorResult } from "./channels/anchor-inference.js"
export { GazetteerInference } from "./channels/gazetteer-inference.js"

// Postcode lookup
export { extractPostcodeAnchors } from "./postcode-anchor.js"
export { PostcodeBinaryLookup } from "./postcode-binary-resolver.js"

// Case normalization
export { normalizeCase, type CaseNormalizeResult } from "./case-normalize.js"
```

## PFX1 — what a partial postcode asserts

`postcode-prefix-index.ts` is the reader and writer for PFX1, a sealed binary index keyed by postcode **prefix**: a GB outward code, or a US 3-digit sectional center. A node stores the admin ancestry that prefix asserts, the number of units observed under it, and — when the source can place it — a centroid.

The coordinate is optional and its absence is meaningful. A node that cannot be placed stores ancestry and no `lat`/`lon`, never `0,0`.

`radiusP95Km` is **mandatory beside a coordinate**. No other rule of the format matters as much. A GB outward district and a US sectional center are both "a prefix with a centroid", and their radii differ by more than an order of magnitude. GB outward has a 3.24 km median p95 radius, the US SCF tier 53.56 km. A consumer reading a coordinate without its radius cannot tell them apart, and one of the two is nearly worthless for the use it would be put to.

Two indexes ship today:

| scope                         |         nodes | median `radiusP95Km` | ancestry                                |
| ----------------------------- | ------------: | -------------------: | --------------------------------------- |
| `gb-esw` (OS Code-Point Open) | 2,863 outward |              3.24 km | country → constituent country           |
| `us` (WOF + point-in-polygon) |       915 SCF |             53.56 km | country → region, on **unanimity** only |

The US arm asserts a region only when every clean unit under the prefix lands in the same one. Twenty-five sectional centers span two or three states and assert only the country. GB applies the same rule GB uses for its border-straddling postcode areas.

The layout is specified normatively in [`pfx1.ksy`](https://github.com/sister-software/mailwoman/blob/main/docs/engineering/reference/pfx1.ksy), and a conformance test walks the serializer's bytes against that document rather than against itself.

## Ship-config interface

The `ProductionScorer` reads `model-card.json`'s `requires` block and
**fails closed** if a declared channel isn't fed. Do not hand-wire ONNX
sessions with zero-filled anchor inputs — anchor-off is out-of-distribution
for the shipped model.

## Related

- [`@mailwoman/neural-weights-en-us`](../neural-weights-en-us) — trained model bundle (en-US)
- [`@mailwoman/neural-weights-fr-fr`](../neural-weights-fr-fr) — trained model bundle (fr-FR)
- [`@mailwoman/core`](../core) — pipeline coordinator, types, decoder
- [Neural Classification concepts](https://mailwoman.post/articles/concepts/neural-classification/)
- [ONNX Runtime concepts](https://mailwoman.post/articles/concepts/onnx-runtime/)
- [What Mailwoman Is](https://mailwoman.post/product)

## License

[AGPL-3.0-only](https://www.gnu.org/licenses/AGPL-3.0.html)
