/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FST-based autocomplete. Prefix walk + BFS expansion to collect ranked place suggestions.
 *   O(depth × branching) — the FST IS the autocomplete index.
 */

import { FstMatcher, normalizeTokens } from "./fst-matcher.js"
import type { PlaceEntry } from "./fst-types.js"

export interface AutocompleteResult {
	query: string
	normalizedTokens: string[]
	depth: number
	suggestions: AutocompleteSuggestion[]
}

export interface AutocompleteSuggestion {
	name: string
	placetype: string
	population: number
	wofId: number
	parentChain: number[]
	matchDepth: number
	completionTokens: string[]
}

export interface AutocompleteOpts {
	maxSuggestions?: number
	maxExpansionDepth?: number
}

/**
 * Autocomplete from the current prefix. Returns ranked suggestions (population-descending).
 *
 * Algorithm:
 * 1. Walk the FST with the normalized prefix tokens
 * 2. Collect all accepting entries at the current state (exact matches)
 * 3. BFS-expand continuations up to `maxExpansionDepth` to find nearby completions
 * 4. Deduplicate by wofId, rank by population
 */
export function autocomplete(
	fst: FstMatcher,
	query: string,
	opts: AutocompleteOpts = {}
): AutocompleteResult {
	const maxSuggestions = opts.maxSuggestions ?? 10
	const maxExpansionDepth = opts.maxExpansionDepth ?? 2
	const normalizedTokens = normalizeTokens(query)

	if (normalizedTokens.length === 0) {
		return { query, normalizedTokens: [], depth: 0, suggestions: [] }
	}

	const match = fst.walk(normalizedTokens)
	if (!match) {
		const partial = fst.query(query)
		return {
			query,
			normalizedTokens,
			depth: partial.path.length,
			suggestions: partial.accepting.map((e) => ({
				name: e.name,
				placetype: e.placetype,
				population: e.population,
				wofId: e.wofId,
				parentChain: e.parentChain,
				matchDepth: partial.path.length,
				completionTokens: [],
			})),
		}
	}

	const seen = new Map<number, AutocompleteSuggestion>()

	for (const entry of fst.accepting(match.stateId)) {
		addSuggestion(seen, entry, match.depth, [])
	}

	interface BfsItem {
		stateId: number
		depth: number
		tokens: string[]
	}

	const queue: BfsItem[] = []
	for (const cont of fst.continuations(match.stateId)) {
		queue.push({ stateId: cont.targetState, depth: 1, tokens: [cont.token] })
	}

	while (queue.length > 0 && seen.size < maxSuggestions * 3) {
		const item = queue.shift()!
		if (item.depth > maxExpansionDepth) continue

		for (const entry of fst.accepting(item.stateId)) {
			addSuggestion(seen, entry, match.depth + item.depth, item.tokens)
		}

		if (item.depth < maxExpansionDepth) {
			for (const cont of fst.continuations(item.stateId)) {
				queue.push({
					stateId: cont.targetState,
					depth: item.depth + 1,
					tokens: [...item.tokens, cont.token],
				})
			}
		}
	}

	const suggestions = [...seen.values()]
		.sort((a, b) => b.population - a.population)
		.slice(0, maxSuggestions)

	return { query, normalizedTokens, depth: match.depth, suggestions }
}

function addSuggestion(
	seen: Map<number, AutocompleteSuggestion>,
	entry: PlaceEntry,
	matchDepth: number,
	completionTokens: string[]
): void {
	const existing = seen.get(entry.wofId)
	if (existing && existing.matchDepth <= matchDepth) return
	seen.set(entry.wofId, {
		name: entry.name,
		placetype: entry.placetype,
		population: entry.population,
		wofId: entry.wofId,
		parentChain: entry.parentChain,
		matchDepth,
		completionTokens: [...completionTokens],
	})
}
