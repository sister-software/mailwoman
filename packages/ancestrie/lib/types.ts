/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Public types for the ancestrie — a materialized trie over an ancestry graph. Domain-agnostic on
 *   purpose: entries are token sequences carrying a numeric id, a rank, parent edges, and an opaque
 *   payload. Nothing in this contract knows about placetypes, gazetteers, or geocoding — those live
 *   in the consumer's payload and tokenizer.
 */

/**
 * A JSON-serializable payload value. Defined locally so the package stays zero-dependency.
 */
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

/**
 * A caller-supplied per-token normalizer (case folding, diacritic stripping, script folding — the consumer's domain).
 * This is the tokenizer-normalization boundary: the SAME function must be applied on the build side ({@link
 * AncestrieBuilderOptions.normalizeToken}) and the query side ({@link AutocompleteOptions.normalizeToken}), or queries
 * will silently miss — the package never normalizes on its own.
 */
export type TokenNormalizer = (token: string) => string

/**
 * One build-side entry: a token sequence (the lexical surface), the entry's id, its parent edges, its rank, and an
 * optional payload. The same `id` may be added under several token sequences (aliases); its id-carried fields must be
 * identical on every add.
 */
export interface AncestrieEntry {
	/**
	 * The lexical surface as a token sequence, already tokenized by the caller. At least one token; tokens must be
	 * non-empty after normalization.
	 */
	tokens: readonly string[]

	/**
	 * The entry's identity — an integer in [0, 2^32). Unique per entity, shared across aliases.
	 */
	id: number

	/**
	 * Direct parents in the ancestry graph, as entry ids. Empty for a root. The FIRST element is the PRIMARY parent:
	 * interval containment (`contains`, `descendantsOf`) answers over the primary-parent forest only; the full list is
	 * preserved and surfaced verbatim.
	 */
	parentIDs: readonly number[]

	/**
	 * Ranking score, higher = surfaced first. Stored as an IEEE-754 float32, so values round-trip at f32 precision.
	 */
	rank: number

	/**
	 * Optional per-entry cargo: raw bytes are returned verbatim; any other value is serialized as JSON at build time and
	 * parsed back on read.
	 */
	payload?: Uint8Array | JSONValue
}

/**
 * A decoded entry as a reader returns it.
 *
 * `TPayload` is the consumer's cargo type. A sealed artifact answers with what the format can carry (`Uint8Array |
 * JSONValue`, the default); an {@link AncestrieReaderLike} adapter over the consumer's own storage may answer with any
 * in-memory value — the algorithm half of this package passes payloads through verbatim and never inspects them.
 */
export interface AncestrieRecord<TPayload = Uint8Array | JSONValue> {
	id: number
	rank: number

	/**
	 * The full declared parent list, primary first — exactly as given at build time.
	 */
	parentIDs: number[]
	payload?: TPayload
}

/**
 * The result of walking a token sequence: the state it lands on, whether entries accept there, and how many tokens were
 * consumed.
 */
export interface AncestrieMatch {
	stateID: number
	accepted: boolean
	depth: number
}

/**
 * One outgoing edge from a state: the token that continues the prefix, the state it leads to, and how many entries
 * accept at that state.
 */
export interface AncestrieContinuation {
	token: string
	targetState: number
	entryCount: number
}

/**
 * One autocomplete suggestion. Every suggestion carries its containment lineage — the point of the structure: one
 * prefix walk yields lexical continuations, ranks, and ancestry together.
 */
export interface AncestrieSuggestion<TPayload = Uint8Array | JSONValue> {
	id: number
	rank: number

	/**
	 * The suggestion's full token path from the trie root — the typed prefix plus
	 * {@link AncestrieSuggestion.completionTokens}.
	 */
	tokens: string[]

	/**
	 * The tokens beyond what was typed. Empty for an exact match; for a partial last token the first element is the
	 * completed token ("yor" → "york").
	 */
	completionTokens: string[]

	/**
	 * Token depth at which the match anchored. When the same id is reachable at several depths, the shallowest wins.
	 */
	matchDepth: number

	/**
	 * The primary-parent lineage as entry ids, nearest parent first. Ids resolve within the artifact except possibly the
	 * last, which may be a declared-but-absent parent (the chain stops there).
	 */
	chain: number[]

	/**
	 * The full declared parent list, primary first.
	 */
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
	 * Max entries collected per BFS branch — keeps one dense branch from starving the search.
	 */
	perBranchLimit?: number

	/**
	 * Collapse suggestions sharing a key to the single highest-ranked one. `true` keys by the full token path (the
	 * generalization of same-NAME dedupe: distinct entries at the same surface — New York the city vs the county —
	 * collapse to one); a function supplies the key itself. Off by default, so a caller surfacing distinct same-surface
	 * entries sees them all.
	 */
	dedupe?: boolean | ((suggestion: AncestrieSuggestion<TPayload>) => string)

	/**
	 * Applied to each query token before walking. Must be the same function the builder was given — see
	 * {@link TokenNormalizer}.
	 */
	normalizeToken?: TokenNormalizer
}

/**
 * The result of one autocomplete call.
 */
export interface AutocompleteResult<TPayload = Uint8Array | JSONValue> {
	/**
	 * The query tokens after normalization — what was actually walked.
	 */
	tokens: string[]
	depth: number
	suggestions: AncestrieSuggestion<TPayload>[]
}

/**
 * The storage interface: what the algorithm half of this package ({@link autocomplete}) requires of a reader. The
 * sealed {@link Ancestrie} class is the canonical implementation; a consumer whose entries live in its own structure —
 * an in-memory trie, a different binary format — supplies an adapter instead of re-implementing the algorithm
 * (`@mailwoman/resolver-wof-sqlite`'s FST gazetteer is the worked example: its `FST\0` artifacts predate this package
 * and stay in their own format, so its `fst-autocomplete` wraps the matcher in this contract).
 *
 * Order contracts the algorithm observes:
 *
 * - `entriesAt(stateID)` with no limit answers EVERY accepting entry, in the reader's stored order.
 * - `entriesAt(stateID, limit)` answers the top-`limit` entries by rank, descending. A sealed artifact serves a prefix of
 *   its rank-sorted storage; an adapter over unsorted storage must select by rank itself. Order among rank TIES is the
 *   reader's own, and is observable in suggestion order — two readers over the same entries may legitimately differ
 *   there.
 * - `ancestorsOf` decorates suggestions' `chain`. A reader that materializes lineage per entry may serve it from its
 *   records rather than walking a graph.
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
	 * Applied to every token on `add`. See {@link TokenNormalizer} for the must-agree contract with the query side.
	 */
	normalizeToken?: TokenNormalizer
}

/**
 * Options for {@link AncestrieBuilder.seal}.
 */
export interface SealOptions {
	/**
	 * Arbitrary JSON stored in the artifact's metadata trailer — provenance, build stamps, whatever the consumer needs to
	 * trust the file later. Readable via `Ancestrie#metadata`.
	 */
	metadata?: JSONValue
}
