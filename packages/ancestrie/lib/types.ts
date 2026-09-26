/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public types for the ancestrie, a materialized trie over an ancestry graph, whose interface is domain-agnostic: placetypes, gazetteers, and geocoding live in the consumer's payload and tokenizer.
 */

/**
 * A JSON-serializable payload value, defined locally to keep the package zero-dependency.
 */
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

/**
 * A caller-supplied per-token normalizer that must be the same function on the build
 * and query sides, or queries silently miss.
 */
export type TokenNormalizer = (token: string) => string

/**
 * One build-side entry, whose `id` may be added under several token sequences
 * (aliases) that must carry identical id-carried fields.
 */
export interface AncestrieEntry {
	/**
	 * The lexical surface as a token sequence, already tokenized: at least one token,
	 * each non-empty after normalization.
	 */
	tokens: readonly string[]

	/**
	 * The entry's identity, an integer in [0, 2^32) unique per entity and shared across aliases.
	 */
	id: number

	/**
	 * Direct parents as entry ids, empty for a root, with the first the primary parent
	 * that interval containment answers over while the full list is preserved.
	 */
	parentIDs: readonly number[]

	/**
	 * Ranking score, higher surfaced first, stored as an ieee-754 float32.
	 */
	rank: number

	/**
	 * Optional per-entry cargo: `Uint8Array` is returned verbatim and any other
	 * value is JSON-serialized at build time.
	 */
	payload?: Uint8Array | JSONValue
}

/**
 * A decoded entry as a reader returns it, with `TPayload` the consumer's cargo
 * type that the algorithm passes through verbatim.
 */
export interface AncestrieRecord<TPayload = Uint8Array | JSONValue> {
	id: number
	rank: number

	/**
	 * The full declared parent list, primary first.
	 */
	parentIDs: number[]
	payload?: TPayload
}

/**
 * The result of walking a token sequence, whose `depth` is the number of tokens consumed.
 */
export interface AncestrieMatch {
	stateID: number
	accepted: boolean
	depth: number
}

/**
 * One outgoing edge from a state.
 */
export interface AncestrieContinuation {
	token: string
	targetState: number
	entryCount: number
}

/**
 * One autocomplete suggestion, carrying its containment lineage.
 */
export interface AncestrieSuggestion<TPayload = Uint8Array | JSONValue> {
	id: number
	rank: number

	tokens: string[]

	/**
	 * The tokens beyond what was typed: empty for an exact match, and the completed
	 * token first for a partial last token.
	 */
	completionTokens: string[]

	/**
	 * Token depth at which the match anchored, the shallowest winning
	 * when an id is reachable at several depths.
	 */
	matchDepth: number

	/**
	 * The primary-parent lineage as entry ids, nearest first, where the last may be
	 * a declared-but-absent parent that stops the chain.
	 */
	chain: number[]

	parentIDs: number[]
	payload?: TPayload
}

/**
 * Options for {@link autocomplete}.
 */
export interface AutocompleteOptions<TPayload = Uint8Array | JSONValue> {
	maxSuggestions?: number
	maxExpansionDepth?: number

	/**
	 * Max entries collected per BFS branch, so one dense branch cannot starve the search.
	 */
	perBranchLimit?: number

	/**
	 * Collapse suggestions sharing a key to the single highest-ranked one, keying by full
	 * token path when `true` or by a supplied function, off by default.
	 */
	dedupe?: boolean | ((suggestion: AncestrieSuggestion<TPayload>) => string)

	/**
	 * Applied to each query token before walking, and must be the same function the builder was given.
	 */
	normalizeToken?: TokenNormalizer
}

/**
 * The result of one autocomplete call.
 */
export interface AutocompleteResult<TPayload = Uint8Array | JSONValue> {
	/**
	 * The query tokens after normalization.
	 */
	tokens: string[]
	depth: number
	suggestions: AncestrieSuggestion<TPayload>[]
}

/**
 * The storage interface the algorithm half of this package ({@link autocomplete}) requires of a reader.
 *
 * `entriesAt(stateID)` answers every accepting entry in the reader's stored order,
 * `entriesAt(stateID, limit)` answers the top `limit` by rank descending — where a sealed artifact
 * serves a prefix of its rank-sorted storage, an adapter over unsorted storage must select by
 * rank itself, and ties are the reader's own — and `ancestorsOf` decorates suggestions' `chain`.
 */
export interface AncestrieReaderLike<TPayload = Uint8Array | JSONValue> {
	walk(tokens: readonly string[]): AncestrieMatch | null
	continuations(stateID: number): AncestrieContinuation[]
	entriesAt(stateID: number, limit?: number): AncestrieRecord<TPayload>[]
	ancestorsOf(id: number): number[]
}

/**
 * Options for {@link AncestrieBuilder}.
 */
export interface AncestrieBuilderOptions {
	/**
	 * Applied to every token on `add`, and must agree with the query side's function.
	 */
	normalizeToken?: TokenNormalizer
}

/**
 * Options for {@link AncestrieBuilder.seal}.
 */
export interface SealOptions {
	/**
	 * Arbitrary JSON stored in the artifact's metadata trailer, readable via `Ancestrie#metadata`.
	 */
	metadata?: JSONValue
}
