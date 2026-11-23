// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export * from "#channels/anchor-inference"
export { LOCALE_COUNTRIES as LOCALE_ORDER } from "#labels"
export * from "#classifier"
export * from "#channels/gazetteer-inference"
export * from "#labels"
export * from "#onnx-runner"
export * from "#labels/postcode/anchor"
export * from "#classifier/proposal"
export { addEmissionMatrix, buildEmissionPriors } from "#prior/query-shape"
export { parseWordConsistencyEnv } from "#decode/word-consistency"
export type { BuildPriorsOpts, QueryShapeLike, TokenLike } from "#prior/query-shape"
export * from "#classifier/scorer"
export * from "#decode/semi-markov"
export * from "#channels/soft-features"
export * from "#span/proposal-prior"
export * from "#span/proposer-lexicon"
export * from "#input/tokenizer"
export * from "#decode/trace"

export {
	buildBIOEndMask,
	buildBIOStartMask,
	buildBIOTransitionMask,
	perTokenArgmax,
	softmax,
	viterbi,
} from "#decode/viterbi"

export type { ViterbiInput, ViterbiResult } from "#decode/viterbi"
export * from "#weights"
