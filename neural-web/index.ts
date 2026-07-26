// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export {
	defaultGazetteerLexiconURL,
	detectPairIndexCountry,
	loadNeuralClassifierFromURLs,
	resolvePairGateCountry,
	resolvePairIndexForText,
	type LoadedPairIndex,
	type LoadFromURLsOptions,
	type LoadResult,
} from "./loader.ts"
export { DEFAULT_FIXED_SEQ_LEN, WebONNXRunner, type WebONNXRunnerOpts } from "./web-onnx-runner.ts"

// Re-export the public neural surface so callers don't need both packages on the typed path.
// Pull from the browser-safe entry — the default entry would drag onnxruntime-node + node:fs
// into the bundle graph via classifier.ts's transitive imports.
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
