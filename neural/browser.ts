/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-safe re-export surface. Excludes `./onnx-runner.js` + `./weights.js` (Node-only — they
 *   statically reference `onnxruntime-node` + `node:fs`), the dynamic `loadFromWeights` /
 *   `loadFromFile` paths from those modules guard the corresponding imports with `webpackIgnore` so
 *   Node callers still get them via the main `@mailwoman/neural` entry without bundling them into a
 *   browser graph.
 */

export * from "./classifier.ts"
export * from "./labels.ts"
export * from "./tokenizer.ts"
// Browser-safe anchor channel (#239/#240): the pure-JS feature builder + the postcode binary resolver
// (zero-dep) the demo wires together to feed the anchor at inference.
export * from "./anchor-inference.ts"
export * from "./postcode-binary-resolver.ts"
// Browser-safe gazetteer-anchor channel (#464): the lexicon parser + feature builder + the postcode
// choreography suppressor. Pure JS over a JSON lexicon — the demo fetches the lexicon alongside the
// model and feeds the clue at inference (gazetteer-trained models REQUIRE it; zero-filled clues are
// the measured train/inference mismatch — see CONTRIBUTING_MODEL_WORK.mdx "zero-fill trap").
export * from "./gazetteer-inference.ts"
// Browser-safe country-lexicon channel (#1104): the dedicated country soft-feed parser + feature
// builder (`[country_surface, country_ambiguous]`). Pure JS over a JSON lexicon — the demo fetches
// country-surface-lexicon-v1.json alongside the model and feeds it (country-channel models, v6.2.0+,
// REQUIRE it: the ONNX declares `country_features` and zero-filled clues are the train/inference mismatch).
export * from "./country-inference.ts"
// Browser-safe placetype-pair index reader (placetype-pair-prior arc): the PIX1 resolver + header peek
// the neural-web loader wires into the classifier's `placetypePair` config, mirroring the node-side
// `loadFromWeights` country gate. Pure JS over a fetched flat binary — DataView/TextDecoder only, zero
// Node imports in the module (the serializer half runs in Node tooling but touches no Node APIs either).
export * from "./pair-index-resolver.ts"
// Browser-safe soft-feature choreography (#718): the pure `buildSoftFeatures` that composes the
// anchor + gazetteer channels (+ near-postcode suppression). No `fs`. The Node-only `./scorer` (which
// constructs the ONNXRunner + reads the card/lookup/lexicon from disk) is deliberately NOT re-exported
// here.
export * from "./soft-features.ts"
// Type-only re-export so callers can still type `InferResult` from the browser entry without
// the implementation module being pulled into the bundle.
export type { InferResult } from "./onnx-runner.ts"
