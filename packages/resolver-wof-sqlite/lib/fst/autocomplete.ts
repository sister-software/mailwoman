/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FST-based autocomplete, mailwoman vocabulary over `@mailwoman/ancestrie`'s generic algorithm.
 *   The prefix walk, BFS expansion, partial-last-token completion, per-branch capping and dedupe
 *   live in ancestrie's `autocomplete`. This module contributes only the storage adapter
 *   ({@link FSTMatcher} → `AncestrieReaderLike`) and the mapping back to mailwoman's suggestion
 *   shape (name, placetype, referential and encyclopedic scores, WOF ids).
 *
 *   The bytes do not migrate. The shipped artifacts are `FST\0` v1 to v5 (`fst-serialize.ts`), and
 *   ancestrie's entries are id-keyed with one record per id. An FST place row is per-(surface,
 *   place), because `crossCountryBranches` is a property of the surface, so the same wofID
 *   legitimately has different values under different aliases, so it cannot use IDs as keys.
 *   The matcher, both deserializers and serializer stay here. The algorithm is the
 *   half that migrated.
 */

import type {
	AncestrieContinuation,
	AncestrieMatch,
	AncestrieReaderLike,
	AncestrieRecord,
	AncestrieSuggestion,
} from "@mailwoman/ancestrie"
import { autocomplete as ancestrieAutocomplete } from "@mailwoman/ancestrie"

import type { FSTMatcher } from "#fst/matcher"
import { normalizeTokens } from "#fst/matcher"
import type { PlaceEntry } from "#fst/types"

export interface AutocompleteResult {
	query: string
	normalizedTokens: string[]
	depth: number
	suggestions: AutocompleteSuggestion[]
}

export interface AutocompleteSuggestion {
	name: string
	placetype: string
	/**
	 * The referential likelihood the suggestion is ranked by (ROAD_TO_V9 §2).
	 *
	 * Autocomplete answers "which place does the user mean", so it ranks referentially like everything else.
	 * Encyclopedic importance appears in {@link AutocompleteSuggestion.encyclopedic}
	 * for display and never enters the order.
	 */
	referential: number
	/**
	 * Encyclopedic (Wikipedia) importance, when the FST artifact stores one for this place.
	 *
	 * `undefined` means no article, or a pre-v5 binary.
	 * It is never 0.
	 */
	encyclopedic: number | null
	wofID: number
	parentChain: number[]
	matchDepth: number
	completionTokens: string[]
}

export interface AutocompleteOpts {
	maxSuggestions?: number
	maxExpansionDepth?: number
	/**
	 * Collapse same-name suggestions to the single highest-referential one.
	 *
	 * Off by default, because the CLI surfaces distinct same-name places such as
	 * New York the city and New York the county.
	 * A typeahead wants it on so the dropdown does not show four "New London"s.
	 */
	dedupeByName?: boolean
}

/**
 * Max accepting entries collected per BFS branch, keeping one dense branch from starving the search.
 */
const PER_BRANCH = 4

/**
 * The top-`k` entries by referential likelihood (descending).
 *
 * Avoids sorting or allocating when `entries` is small.
 * That shortcut is part of the observable interface.
 *
 * At or under `k`, suggestions retain insertion order.
 * That order decides suggestions among referential ties.
 */
function topByReferential(entries: readonly PlaceEntry[], k: number): PlaceEntry[] {
	if (entries.length <= k) return [...entries]

	return [...entries].toSorted((a, b) => b.referential - a.referential).slice(0, k)
}

/**
 * {@link FSTMatcher} presented through ancestrie's storage interface.
 *
 * Records store the {@link PlaceEntry} itself as the payload, so the entry that wins the
 * algorithm's shallowest-depth rule is the entry whose fields the suggestion reports.
 * A side lookup keyed on id could pick a different surface's row
 * (`crossCountryBranches` differs per surface).
 */
class FSTReader implements AncestrieReaderLike<PlaceEntry> {
	readonly #fst: FSTMatcher

	/**
	 * Parent chains of the entries this reader has served, id-keyed.
	 *
	 * A place's chain is identical across its surfaces (it is place-row data), so last-write-wins is safe.
	 * The algorithm asks {@link FSTReader.ancestorsOf} only for ids it just received
	 * from {@link FSTReader.entriesAt}, so serving from this memo answers every
	 * real call without an artifact-wide id index.
	 */
	readonly #chains = new Map<number, number[]>()

	constructor(fst: FSTMatcher) {
		this.#fst = fst
	}

	walk(tokens: readonly string[]): AncestrieMatch | null {
		return this.#fst.walk([...tokens])
	}

	continuations(stateID: number): AncestrieContinuation[] {
		// Insertion order, verbatim.
		// BFS visit order under the suggestion budget depends on it.
		return this.#fst.continuations(stateID).map((c) => ({
			token: c.token,
			targetState: c.targetState,
			entryCount: c.acceptingCount,
		}))
	}

	entriesAt(stateID: number, limit?: number): AncestrieRecord<PlaceEntry>[] {
		const places = this.#fst.accepting(stateID)
		const selected = limit === undefined ? places : topByReferential(places, limit)

		return selected.map((entry) => {
			this.#chains.set(entry.wofID, entry.parentChain)

			return {
				id: entry.wofID,
				rank: entry.referential,
				parentIDs: entry.parentChain,
				payload: entry,
			}
		})
	}

	ancestorsOf(id: number): number[] {
		return this.#chains.get(id) ?? []
	}
}

/**
 * Autocomplete from the current prefix.
 *
 * @returns Suggestions ranked referential-descending.
 */
export function autocomplete(fst: FSTMatcher, query: string, opts: AutocompleteOpts = {}): AutocompleteResult {
	const normalizedTokens = normalizeTokens(query)

	const result = ancestrieAutocomplete<PlaceEntry>(new FSTReader(fst), normalizedTokens, {
		...(opts.maxSuggestions === undefined ? {} : { maxSuggestions: opts.maxSuggestions }),
		...(opts.maxExpansionDepth === undefined ? {} : { maxExpansionDepth: opts.maxExpansionDepth }),
		perBranchLimit: PER_BRANCH,
		// The dedupe key is the display name, so two surfaces of one name still collapse.
		...(opts.dedupeByName ? { dedupe: (s: AncestrieSuggestion<PlaceEntry>) => s.payload!.name.toLowerCase() } : {}),
	})

	return {
		query,
		normalizedTokens,
		depth: result.depth,
		suggestions: result.suggestions.map((s) => {
			// Every record this adapter serves includes its entry, so the non-null assertion holds.
			const entry = s.payload!

			return {
				name: entry.name,
				placetype: entry.placetype,
				referential: entry.referential,
				encyclopedic: entry.encyclopedic,
				wofID: s.id,
				parentChain: s.parentIDs,
				matchDepth: s.matchDepth,
				completionTokens: s.completionTokens,
			}
		}),
	}
}
