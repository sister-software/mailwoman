/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/ancestrie` — a materialized trie over an ancestry graph. Build entries into a token
 *   trie, seal to one static binary artifact, and answer lexical continuation, rank, and containment
 *   questions from a single prefix walk. See the README for lineage and the format doc in
 *   `format.ts` for the bytes.
 */

export { autocomplete } from "./autocomplete.ts"
export { AncestrieBuilder } from "./builder.ts"
export { ANCESTRIE_FORMAT_VERSION, ANCESTRIE_MAGIC } from "./format.ts"
export { Ancestrie } from "./reader.ts"

export type {
	AncestrieBuilderOptions,
	AncestrieContinuation,
	AncestrieEntry,
	AncestrieMatch,
	AncestrieReaderLike,
	AncestrieRecord,
	AncestrieSuggestion,
	AutocompleteOptions,
	AutocompleteResult,
	JSONValue,
	SealOptions,
	TokenNormalizer,
} from "./types.ts"
