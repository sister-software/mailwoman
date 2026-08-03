/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Re-export shim over `@mailwoman/neural`, which is where the browser runtime — `WebONNXRunner`
 *   and the URL loader — now lives; a caller reaches it by export condition rather than by picking a
 *   package. This module exists so the specifier published consumers already import keeps resolving
 *   to the same values.
 *
 *   Each name is re-exported at its original identity, so `instanceof` and type identity hold across
 *   the two specifiers.
 */

export {
	defaultGazetteerLexiconURL,
	detectPairIndexCountry,
	loadNeuralClassifierFromURLs,
	resolvePairGateCountry,
	resolvePairIndexForText,
	type LoadedPairIndex,
	type LoadFromURLsOptions,
	type LoadResult,
} from "@mailwoman/neural/web-loader"

export { DEFAULT_FIXED_SEQ_LEN, WebONNXRunner, type WebONNXRunnerOpts } from "@mailwoman/neural/web-onnx-runner"

// Re-export the public neural surface so callers don't need both packages on the typed path.
// Pull from the browser-safe entry — the default entry would drag onnxruntime-node + node:fs
// into the bundle graph via weights.ts and scorer.ts.
export {
	MailwomanTokenizer,
	NeuralAddressClassifier,
	PairIndexResolver,
	peekPairIndexHeader,
	type NeuralAddressClassifierConfig,
	type NeuralRunner,
	type PairIndexHeader,
	type PlacetypePairPriorOpts,
} from "@mailwoman/neural/browser"

export type { InferResult } from "@mailwoman/neural/browser"
