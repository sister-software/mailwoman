/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/ancestrie` is a materialized trie over an ancestry graph. Build entries into a token
 *   trie and seal them into one static binary artifact. A single prefix walk answers lexical
 *   continuation, rank and containment queries. The readme describes lineage. `format.ts` describes
 *   the binary layout.
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
