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

export { autocomplete } from "#autocomplete"
export { AncestrieBuilder } from "#builder"
export { ANCESTRIE_FORMAT_VERSION, ANCESTRIE_MAGIC } from "#format"
export { Ancestrie } from "#reader"

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
} from "#types"
