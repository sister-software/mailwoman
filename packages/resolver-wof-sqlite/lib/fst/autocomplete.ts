/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FST-based autocomplete — mailwoman vocabulary over `@mailwoman/ancestrie`'s generic algorithm
 *   (#1728 phase 2). The #587 behavior — prefix walk + BFS expansion, partial-last-token completion,
 *   per-branch capping, dedupe — lives in ancestrie's `autocomplete`; this module contributes only
 *   the storage adapter ({@link FSTMatcher} → `AncestrieReaderLike`) and the mapping back to
 *   mailwoman's suggestion shape (name, placetype, referential/encyclopedic, WOF ids).
 *
 *   THE BYTES DO NOT MIGRATE. The shipped artifacts are `FST\0` v1–v5 (`fst-serialize.ts`), not
 *   ancestrie's `ANCT`: ancestrie entries are id-keyed with one record per id, while an FST place row
 *   is per-(surface, place) — `crossCountryBranches` is a property of the SURFACE, so the same wofID
 *   legitimately carries different values under different aliases and cannot be represented id-keyed.
 *   The matcher, both deserializers, and the serializer therefore stay here; what migrated is the
 *   ALGORITHM, which is the half that drifts (the #861 share-the-function rule).
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
	 * The REFERENTIAL likelihood the suggestion is ranked by (ROAD_TO_V9 §2). Autocomplete answers "which place does the
	 * user mean", so it ranks referentially like everything else; encyclopedic importance rides along on
	 * {@link AutocompleteSuggestion.encyclopedic} for display and never enters the order.
	 */
	referential: number
	/**
	 * Encyclopedic (Wikipedia) importance, when the FST artifact carries one for this place. `undefined` = no article, or
	 * a pre-v5 binary — never 0.
	 */
	encyclopedic?: number
	wofID: number
	parentChain: number[]
	matchDepth: number
	completionTokens: string[]
}

export interface AutocompleteOpts {
	maxSuggestions?: number
	maxExpansionDepth?: number
	/**
	 * Collapse same-name suggestions to the single highest-referential one. Off by default (the CLI surfaces distinct
	 * same-name places — New York the city vs the county); a typeahead wants it ON so the dropdown isn't four "New
	 * London"s. (#587)
	 */
	dedupeByName?: boolean
}

/**
 * Max accepting entries collected per BFS branch — keeps one dense branch from starving the search.
 */
const PER_BRANCH = 4

/**
 * The top-`k` entries by REFERENTIAL likelihood (descending). Avoids sorting/allocating when `entries` is small — and
 * that shortcut is part of the observable contract: at or under `k` the INSERTION order is served, which decides
 * suggestion order among referential ties.
 */
function topByReferential(entries: readonly PlaceEntry[], k: number): PlaceEntry[] {
	if (entries.length <= k) return [...entries]

	return [...entries].toSorted((a, b) => b.referential - a.referential).slice(0, k)
}

/**
 * {@link FSTMatcher} presented through ancestrie's storage interface. Records carry the {@link PlaceEntry} itself as the
 * payload, so the entry that WINS the algorithm's shallowest-depth rule is the entry whose fields the suggestion
 * reports — a side lookup keyed on id could pick a different surface's row (`crossCountryBranches` differs per
 * surface).
 */
class FSTReader implements AncestrieReaderLike<PlaceEntry> {
	readonly #fst: FSTMatcher

	/**
	 * Parent chains of the entries this reader has served, id-keyed. A place's chain is identical across its surfaces (it
	 * is place-row data), so last-write-wins is safe. The algorithm asks {@link FSTReader.ancestorsOf} only for ids it
	 * just received from {@link FSTReader.entriesAt}, so serving from this memo answers every real call without an
	 * artifact-wide id index.
	 */
	readonly #chains = new Map<number, number[]>()

	constructor(fst: FSTMatcher) {
		this.#fst = fst
	}

	walk(tokens: readonly string[]): AncestrieMatch | null {
		return this.#fst.walk([...tokens])
	}

	continuations(stateID: number): AncestrieContinuation[] {
		// Insertion order, verbatim — BFS visit order under the suggestion budget depends on it.
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
 * Autocomplete from the current prefix. Returns suggestions ranked referential-descending.
 */
export function autocomplete(fst: FSTMatcher, query: string, opts: AutocompleteOpts = {}): AutocompleteResult {
	const normalizedTokens = normalizeTokens(query)

	const result = ancestrieAutocomplete<PlaceEntry>(new FSTReader(fst), normalizedTokens, {
		...(opts.maxSuggestions === undefined ? {} : { maxSuggestions: opts.maxSuggestions }),
		...(opts.maxExpansionDepth === undefined ? {} : { maxExpansionDepth: opts.maxExpansionDepth }),
		perBranchLimit: PER_BRANCH,
		// The dedupe key is the DISPLAY name, not the token path: two surfaces of one name must still collapse. (#587)
		...(opts.dedupeByName ? { dedupe: (s: AncestrieSuggestion<PlaceEntry>) => s.payload!.name.toLowerCase() } : {}),
	})

	return {
		query,
		normalizedTokens,
		depth: result.depth,
		suggestions: result.suggestions.map((s) => {
			// Every record this adapter serves carries its entry; the assertion documents the invariant.
			const entry = s.payload!

			return {
				name: entry.name,
				placetype: entry.placetype,
				referential: entry.referential,
				...(entry.encyclopedic === undefined ? {} : { encyclopedic: entry.encyclopedic }),
				wofID: s.id,
				parentChain: s.parentIDs,
				matchDepth: s.matchDepth,
				completionTokens: s.completionTokens,
			}
		}),
	}
}
