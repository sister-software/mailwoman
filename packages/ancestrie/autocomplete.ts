/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Autocomplete over a sealed ancestrie: prefix walk + BFS expansion collecting ranked suggestions,
 *   each carrying its containment lineage. O(depth × branching) — the trie IS the autocomplete
 *   index. Ported and generalized from mailwoman's `fst-autocomplete.ts` (#587 behaviors preserved).
 *
 *   Two query shapes are handled (the trie is over WORD tokens):
 *
 *   - COMPLETE tokens — `walk` lands on a state; collect its accepting entries + BFS a couple tokens
 *       past it for nearby completions.
 *   - A PARTIAL last token ("new yor") — `walk` fails (there is no "yor" edge, only "york"). So walk
 *       the complete prefix, then complete the partial token by prefix-filtering the continuation
 *       edges (`token.startsWith(partial)`). This is what a char-level typeahead needs; without it
 *       "new yor" returns nothing useful. (#587)
 *
 *   Both interpretations of the last token run, ALWAYS: it can be a complete edge AND a partial of
 *   longer edges at once (an entry literally surfaced as "chic" must not shadow "chicago"), and
 *   letting a successful walk short-circuit silently drops every longer completion.
 */

import type {
	AncestrieReaderLike,
	AncestrieRecord,
	AncestrieSuggestion,
	AutocompleteOptions,
	AutocompleteResult,
	JSONValue,
} from "./types.ts"

/**
 * Default cap on returned suggestions.
 */
const DEFAULT_MAX_SUGGESTIONS = 10

/**
 * Default BFS depth past the matched state — how many tokens beyond the prefix are explored.
 */
const DEFAULT_MAX_EXPANSION_DEPTH = 2

/**
 * Default max entries collected per BFS branch — keeps one dense branch (a state with dozens of accepting entries) from
 * starving the search before a higher-ranked sibling branch is visited.
 */
const DEFAULT_PER_BRANCH_LIMIT = 4

/**
 * The BFS stops once `maxSuggestions ×` this many candidates are collected — enough surplus that the final
 * rank-descending sort and dedupe still have real choices, without exhausting a wide trie.
 */
const SUGGESTION_BUDGET_FACTOR = 4

interface BFSItem {
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
 * Autocomplete from the current token prefix. Returns suggestions ranked rank-descending, each with its full token path
 * and its ancestor chain. Takes any {@link AncestrieReaderLike} — a sealed {@link import("./reader.ts").Ancestrie} or a
 * consumer's adapter over its own storage; the order contracts the algorithm relies on are documented on the
 * interface.
 */
export function autocomplete<TPayload = Uint8Array | JSONValue>(
	trie: AncestrieReaderLike<TPayload>,
	tokens: readonly string[],
	options: AutocompleteOptions<TPayload> = {}
): AutocompleteResult<TPayload> {
	const maxSuggestions = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS
	const maxExpansionDepth = options.maxExpansionDepth ?? DEFAULT_MAX_EXPANSION_DEPTH
	const perBranchLimit = options.perBranchLimit ?? DEFAULT_PER_BRANCH_LIMIT
	const normalize = options.normalizeToken

	// Tokens that normalize to nothing are dropped, mirroring a whitespace-splitting tokenizer's output.
	const normalized = (normalize ? tokens.map(normalize) : [...tokens]).filter((t) => t.length)

	if (!normalized.length) {
		return { tokens: [], depth: 0, suggestions: [] }
	}

	const seen = new Map<number, AncestrieSuggestion<TPayload>>()
	const queue: BFSItem[] = []

	const match = trie.walk(normalized)
	const complete = normalized.slice(0, -1)
	const partial = normalized.at(-1)!
	const prefixState = !complete.length ? 0 : (trie.walk(complete)?.stateID ?? undefined)

	if (!match && prefixState === undefined) {
		return { tokens: normalized, depth: 0, suggestions: [] }
	}

	const depth = match?.depth ?? complete.length

	if (match) {
		// COMPLETE-token interpretation: the typed tokens land on a state. Seed its accepting entries
		// and its continuations.
		for (const record of trie.entriesAt(match.stateID)) {
			addSuggestion(trie, seen, record, match.depth, normalized, [])
		}

		for (const cont of trie.continuations(match.stateID)) {
			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: match.depth })
		}
	}

	if (prefixState !== undefined) {
		// PARTIAL-token interpretation: complete the last token by prefix-filtering the continuation
		// edges. The exact edge is skipped — when it exists, the complete-token seeding above already
		// covered that state.
		for (const cont of trie.continuations(prefixState)) {
			if (cont.token === partial || !cont.token.startsWith(partial)) continue

			// This edge completes the typed partial token — its target is a real match at depth+1.
			for (const record of trie.entriesAt(cont.targetState, perBranchLimit)) {
				addSuggestion(trie, seen, record, complete.length + 1, normalized, [cont.token])
			}

			// BFS a little past it too (multi-token completions: "new yor" → "New York Mills").
			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: complete.length })
		}
	}

	// BFS expansion (shared by both paths) — find nearby completions up to maxExpansionDepth. Each
	// branch contributes only its top perBranchLimit entries: a dense state would otherwise blow the
	// budget before the BFS ever reaches a higher-ranked sibling branch. (#587)
	while (queue.length && seen.size < maxSuggestions * SUGGESTION_BUDGET_FACTOR) {
		const item = queue.shift()!

		if (item.depth > maxExpansionDepth) continue

		for (const record of trie.entriesAt(item.stateID, perBranchLimit)) {
			addSuggestion(trie, seen, record, item.base + item.depth, normalized, item.tokens)
		}

		if (item.depth < maxExpansionDepth) {
			for (const cont of trie.continuations(item.stateID)) {
				queue.push({
					stateID: cont.targetState,
					depth: item.depth + 1,
					tokens: [...item.tokens, cont.token],
					base: item.base,
				})
			}
		}
	}

	let suggestions = [...seen.values()].toSorted((a, b) => b.rank - a.rank)
	const dedupeKey = options.dedupe === true ? joinedPathKey : options.dedupe

	if (dedupeKey) {
		suggestions = dedupe(suggestions, dedupeKey)
	}

	return { tokens: normalized, depth, suggestions: suggestions.slice(0, maxSuggestions) }
}

/**
 * The `dedupe: true` key: the suggestion's full token path, NUL-joined so a token containing a space cannot collide
 * with a token boundary. Distinct entries at the same lexical surface (a city and a county sharing a name) collapse to
 * the highest-ranked one.
 */
function joinedPathKey(suggestion: AncestrieSuggestion<unknown>): string {
	return suggestion.tokens.join("\u0000")
}

function addSuggestion<TPayload>(
	trie: AncestrieReaderLike<TPayload>,
	seen: Map<number, AncestrieSuggestion<TPayload>>,
	record: AncestrieRecord<TPayload>,
	matchDepth: number,
	inputTokens: readonly string[],
	completionTokens: string[]
): void {
	const existing = seen.get(record.id)

	if (existing && existing.matchDepth <= matchDepth) return

	const base = matchDepth - completionTokens.length

	seen.set(record.id, {
		id: record.id,
		rank: record.rank,
		tokens: [...inputTokens.slice(0, base), ...completionTokens],
		completionTokens: [...completionTokens],
		matchDepth,
		chain: trie.ancestorsOf(record.id),
		parentIDs: record.parentIDs,
		...(record.payload === undefined ? {} : { payload: record.payload }),
	})
}

/**
 * Keep one suggestion per key — the highest-ranked. Input is already rank-sorted, so the first occurrence per key wins;
 * order is preserved.
 */
function dedupe<TPayload>(
	suggestions: AncestrieSuggestion<TPayload>[],
	key: (suggestion: AncestrieSuggestion<TPayload>) => string
): AncestrieSuggestion<TPayload>[] {
	const seenKeys = new Set<string>()
	const out: AncestrieSuggestion<TPayload>[] = []

	for (const suggestion of suggestions) {
		const k = key(suggestion)

		if (seenKeys.has(k)) continue
		seenKeys.add(k)
		out.push(suggestion)
	}

	return out
}
