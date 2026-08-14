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

import type { FSTMatcher } from "./fst-matcher.ts"
import { normalizeTokens } from "./fst-matcher.ts"
import type { PlaceEntry } from "./fst-types.ts"

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

interface BfsItem {
	stateID: number
	depth: number
	tokens: string[]
	/**
	 * Absolute token depth of the state this item's expansion STARTED from. The two seeding interpretations start one
	 * token apart (the complete-token walk sits at N, the partial-token prefix at N−1), so a shared outer base would
	 * mislabel one branch's depths.
	 */
	base: number
}

/**
 * Max accepting entries collected per BFS branch — keeps one dense branch from starving the search.
 */
const PER_BRANCH = 4

/**
 * The top-`k` entries by REFERENTIAL likelihood (descending). Avoids sorting/allocating when `entries` is small.
 */
function topByReferential(entries: readonly PlaceEntry[], k: number): PlaceEntry[] {
	if (entries.length <= k) return [...entries]

	return [...entries].toSorted((a, b) => b.referential - a.referential).slice(0, k)
}

/**
 * Autocomplete from the current prefix. Returns suggestions ranked referential-descending.
 */
export function autocomplete(fst: FSTMatcher, query: string, opts: AutocompleteOpts = {}): AutocompleteResult {
	const maxSuggestions = opts.maxSuggestions ?? 10
	const maxExpansionDepth = opts.maxExpansionDepth ?? 2
	const normalizedTokens = normalizeTokens(query)

	if (!normalizedTokens.length) {
		return { query, normalizedTokens: [], depth: 0, suggestions: [] }
	}

	const seen = new Map<number, AutocompleteSuggestion>()
	const queue: BfsItem[] = []

	const match = fst.walk(normalizedTokens)
	// Both interpretations of the last token run, ALWAYS: it can be a complete edge AND a partial of
	// longer edges at once — the live en-us artifact holds a place literally named "Chic", and
	// letting its successful walk short-circuit silently dropped "Chicago" and every other longer
	// completion from the typeahead.
	const complete = normalizedTokens.slice(0, -1)
	const partial = normalizedTokens.at(-1)!
	const prefixState = !complete.length ? 0 : (fst.walk(complete)?.stateID ?? undefined)

	if (!match && prefixState === undefined) {
		return { query, normalizedTokens, depth: 0, suggestions: [] }
	}

	const depth = match?.depth ?? complete.length

	if (match) {
		// COMPLETE-token interpretation: the typed tokens land on a state. Seed its accepting entries
		// and its continuations.
		for (const entry of fst.accepting(match.stateID)) {
			addSuggestion(seen, entry, match.depth, [])
		}

		for (const cont of fst.continuations(match.stateID)) {
			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: match.depth })
		}
	}

	if (prefixState !== undefined) {
		// PARTIAL-token interpretation: complete the last token by prefix-filtering the continuation
		// edges. The exact edge is skipped — when it exists, the complete-token seeding above already
		// covered that state.
		for (const cont of fst.continuations(prefixState)) {
			if (cont.token === partial || !cont.token.startsWith(partial)) continue

			// This edge completes the typed partial token — its target is a real match at depth+1.
			for (const entry of topByReferential(fst.accepting(cont.targetState), PER_BRANCH)) {
				addSuggestion(seen, entry, complete.length + 1, [cont.token])
			}

			// BFS a little past it too (multi-token completions: "new yor" → "New York Mills").
			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: complete.length })
		}
	}

	// BFS expansion (shared by both paths) — find nearby completions up to maxExpansionDepth. Each
	// branch contributes only its top PER_BRANCH places: a state like "new london" has dozens of
	// accepting entries and would otherwise blow the budget before the BFS ever reaches "new york"
	// (the "new" state has 311 continuations). Per-branch capping keeps the search broad. (#587)
	while (queue.length && seen.size < maxSuggestions * 4) {
		const item = queue.shift()!

		if (item.depth > maxExpansionDepth) continue

		for (const entry of topByReferential(fst.accepting(item.stateID), PER_BRANCH)) {
			addSuggestion(seen, entry, item.base + item.depth, item.tokens)
		}

		if (item.depth < maxExpansionDepth) {
			for (const cont of fst.continuations(item.stateID)) {
				queue.push({
					stateID: cont.targetState,
					depth: item.depth + 1,
					tokens: [...item.tokens, cont.token],
					base: item.base,
				})
			}
		}
	}

	let suggestions = [...seen.values()].toSorted((a, b) => b.referential - a.referential)

	if (opts.dedupeByName) {
		suggestions = dedupeByName(suggestions)
	}

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
		referential: entry.referential,
		...(entry.encyclopedic === undefined ? {} : { encyclopedic: entry.encyclopedic }),
		wofID: entry.wofID,
		parentChain: entry.parentChain,
		matchDepth,
		completionTokens: [...completionTokens],
	})
}

/**
 * Keep one suggestion per name — the highest-referential. Input is already referential-sorted, so the first occurrence
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
