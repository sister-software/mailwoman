/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export * from "#anchor-inference"
export * from "#classifier"
export * from "#gazetteer-inference"
export * from "#labels"
export * from "#onnx-runner"
export * from "#postcode-anchor"
export * from "#postcode-binary-resolver"
export * from "#proposal-classifier"
export { addEmissionMatrix, buildEmissionPriors } from "#query-shape-prior"
export { parseWordConsistencyEnv, type WordConsistencyOpts } from "#word-consistency"
export type { BuildPriorsOpts, KnownFormatHitLike, QueryShapeLike, TokenLike } from "#query-shape-prior"
export * from "#scorer"
export * from "#semi-markov-decode"
export * from "#soft-features"
export * from "#span-proposal-prior"
export * from "#span-proposer-lexicon"
export * from "#tokenizer"
export * from "#trace"

export { buildBIOEndMask, buildBIOStartMask, buildBIOTransitionMask, perTokenArgmax, softmax, viterbi } from "#viterbi"

export type { ViterbiInput, ViterbiResult } from "#viterbi"
export * from "#weights"
