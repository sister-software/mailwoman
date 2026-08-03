/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Browser-safe aggregate of this package. It is the main entry minus `./weights.ts` and
 *   `./scorer.ts` — the only two modules left that statically reach `node:fs`, and so the only two a
 *   browser graph cannot contain. Everything else here is reachable from a bundle by construction:
 *   `neural/onnx-runner` resolves to a throwing browser counterpart under the `browser` condition,
 *   and oxlint holds the rest to a no-`node:*` rule.
 *
 *   The soft-feature channels below are not optional decoration. A gazetteer-, country-, or
 *   pair-trained model REQUIRES its channel fed at inference; a zero-filled clue is a train/inference
 *   mismatch, not a neutral default (see CONTRIBUTING_MODEL_WORK.mdx, "zero-fill trap"). A browser
 *   caller fetches each lexicon alongside the model and feeds it.
 */

export * from "./anchor-inference.ts"
export * from "./classifier.ts"
export * from "./country-inference.ts"
export * from "./gazetteer-inference.ts"
export * from "./labels.ts"
// Resolution, not curation: the `browser` condition on this subpath serves a counterpart whose every
// entry point throws, so the value exports below are safe to name from a bundle.
export * from "@mailwoman/neural/onnx-runner"
export * from "./pair-index-resolver.ts"
export * from "./postcode-binary-resolver.ts"
export * from "./soft-features.ts"
export * from "./tokenizer.ts"
// `./placetype-pair-prior.ts` is reached only through the classifier's decode, so callers need the
// option shape and not the module. A `type` re-export is fully erased.
export type { PlacetypePairPriorOpts, PlacetypePairPriorResult } from "./placetype-pair-prior.ts"
