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

export * from "./classifier.js"
export * from "./labels.js"
export * from "./tokenizer.js"
// Browser-safe anchor channel (#239/#240): the pure-JS feature builder + the postcode binary resolver
// (zero-dep) the demo wires together to feed the anchor at inference.
export * from "./anchor-inference.js"
export * from "./postcode-binary-resolver.js"
// Browser-safe gazetteer-anchor channel (#464): the lexicon parser + feature builder + the postcode
// choreography suppressor. Pure JS over a JSON lexicon — the demo fetches the lexicon alongside the
// model and feeds the clue at inference (gazetteer-trained models REQUIRE it; zero-filled clues are
// the measured train/inference mismatch — see CONTRIBUTING_MODEL_WORK.mdx "zero-fill trap").
export * from "./gazetteer-inference.js"
// Type-only re-export so callers can still type `InferResult` from the browser entry without
// the implementation module being pulled into the bundle.
export type { InferResult } from "./onnx-runner.js"
