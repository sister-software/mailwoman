/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   FST-based autocomplete. Prefix walk + BFS expansion to collect ranked place suggestions. O(depth
 *   × branching) — the FST IS the autocomplete index.
 *
 *   Two query shapes are handled (the FST is a trie over normalized WORD tokens):
 *
 *   - COMPLETE tokens ("new york") — `walk` lands on a state; collect its accepting entries + BFS a
 *       couple tokens past it for nearby completions. This is the CLI's "complete a place word"
 *       path.
 *   - A PARTIAL last token ("new yor", "chic") — `walk` fails (there is no "yor" edge, only "york"). So
 *       walk the complete prefix, then complete the partial token by prefix-filtering the
 *       continuation edges (`token.startsWith(partial)`). This is what a char-level typeahead
 *       needs; without it "new yor" returns nothing useful. (#587)
 */

import { FSTMatcher, normalizeTokens } from "./fst-matcher.js"
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
	importance: number
	wofID: number
	parentChain: number[]
	matchDepth: number
	completionTokens: string[]
}

export interface AutocompleteOpts {
	maxSuggestions?: number
	maxExpansionDepth?: number
	/**
	 * Collapse same-name suggestions to the single highest-importance one. Off by default (the CLI surfaces distinct
	 * same-name places — New York the city vs the county); a typeahead wants it ON so the dropdown isn't four "New
	 * London"s. (#587)
	 */
	dedupeByName?: boolean
}

interface BfsItem {
	stateId: number
	depth: number
	tokens: string[]
}

/** Max accepting entries collected per BFS branch — keeps one dense branch from starving the search. */
const PER_BRANCH = 4

/**
 * The top-`k` entries by importance (descending). Avoids sorting/allocating when `entries` is small.
 */
function topByImportance(entries: readonly PlaceEntry[], k: number): PlaceEntry[] {
	if (entries.length <= k) return [...entries]

	return [...entries].sort((a, b) => b.importance - a.importance).slice(0, k)
}

/**
 * Autocomplete from the current prefix. Returns suggestions ranked importance-descending.
 */
export function autocomplete(fst: FSTMatcher, query: string, opts: AutocompleteOpts = {}): AutocompleteResult {
	const maxSuggestions = opts.maxSuggestions ?? 10
	const maxExpansionDepth = opts.maxExpansionDepth ?? 2
	const normalizedTokens = normalizeTokens(query)

	if (normalizedTokens.length === 0) {
		return { query, normalizedTokens: [], depth: 0, suggestions: [] }
	}

	const seen = new Map<number, AutocompleteSuggestion>()
	const queue: BfsItem[] = []
	let depth = 0

	const match = fst.walk(normalizedTokens)

	if (match) {
		// COMPLETE-token prefix landed on a state. Seed at the match state (accepting + continuations).
		depth = match.depth

		for (const entry of fst.accepting(match.stateId)) addSuggestion(seen, entry, match.depth, [])

		for (const cont of fst.continuations(match.stateId)) {
			queue.push({ stateId: cont.targetState, depth: 1, tokens: [cont.token] })
		}
	} else {
		// PARTIAL last token — walk the complete prefix, complete the partial by prefix-filtering edges.
		const complete = normalizedTokens.slice(0, -1)
		const partial = normalizedTokens[normalizedTokens.length - 1]!
		const prefixState = complete.length === 0 ? 0 : (fst.walk(complete)?.stateId ?? undefined)

		if (prefixState === undefined) {
			return { query, normalizedTokens, depth: 0, suggestions: [] }
		}
		depth = complete.length

		for (const cont of fst.continuations(prefixState)) {
			if (!cont.token.startsWith(partial)) continue

			// This edge completes the typed partial token — its target is a real match at depth+1.
			for (const entry of topByImportance(fst.accepting(cont.targetState), PER_BRANCH))
				addSuggestion(seen, entry, complete.length + 1, [cont.token])
			// BFS a little past it too (multi-token completions: "new yor" → "New York Mills").
			queue.push({ stateId: cont.targetState, depth: 1, tokens: [cont.token] })
		}
	}

	// BFS expansion (shared by both paths) — find nearby completions up to maxExpansionDepth. Each
	// branch contributes only its top PER_BRANCH places: a state like "new london" has dozens of
	// accepting entries and would otherwise blow the budget before the BFS ever reaches "new york"
	// (the "new" state has 311 continuations). Per-branch capping keeps the search broad. (#587)
	while (queue.length > 0 && seen.size < maxSuggestions * 4) {
		const item = queue.shift()!

		if (item.depth > maxExpansionDepth) continue

		for (const entry of topByImportance(fst.accepting(item.stateId), PER_BRANCH))
			addSuggestion(seen, entry, depth + item.depth, item.tokens)

		if (item.depth < maxExpansionDepth) {
			for (const cont of fst.continuations(item.stateId)) {
				queue.push({ stateId: cont.targetState, depth: item.depth + 1, tokens: [...item.tokens, cont.token] })
			}
		}
	}

	let suggestions = [...seen.values()].sort((a, b) => b.importance - a.importance)

	if (opts.dedupeByName) suggestions = dedupeByName(suggestions)

	return { query, normalizedTokens, depth, suggestions: suggestions.slice(0, maxSuggestions) }
}

function addSuggestion(
	seen: Map<number, AutocompleteSuggestion>,
	entry: PlaceEntry,
	matchDepth: number,
	completionTokens: string[]
): void {
	const existing = seen.get(entry.wofID)

	if (existing && existing.matchDepth <= matchDepth) return
	seen.set(entry.wofID, {
		name: entry.name,
		placetype: entry.placetype,
		importance: entry.importance,
		wofID: entry.wofID,
		parentChain: entry.parentChain,
		matchDepth,
		completionTokens: [...completionTokens],
	})
}

/**
 * Keep one suggestion per name — the highest-importance. Input is already importance-sorted, so the first occurrence
 * per name wins; order is preserved.
 */
function dedupeByName(suggestions: AutocompleteSuggestion[]): AutocompleteSuggestion[] {
	const seenNames = new Set<string>()
	const out: AutocompleteSuggestion[] = []

	for (const s of suggestions) {
		const key = s.name.toLowerCase()

		if (seenNames.has(key)) continue
		seenNames.add(key)
		out.push(s)
	}

	return out
}
