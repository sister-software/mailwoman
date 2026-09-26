/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Autocomplete over a sealed ancestrie: prefix walk plus BFS expansion collecting ranked suggestions, each carrying its containment lineage.
 *
 *   Both interpretations of the last token always run — it can be a complete edge and a partial of longer edges at once — because letting a successful walk short-circuit silently drops every longer completion.
 */

import type {
	AncestrieReaderLike,
	AncestrieRecord,
	AncestrieSuggestion,
	AutocompleteOptions,
	AutocompleteResult,
	JSONValue,
} from "#types"

const DEFAULT_MAX_SUGGESTIONS = 10

const DEFAULT_MAX_EXPANSION_DEPTH = 2

/**
 * Default max entries collected per BFS branch, so one dense branch cannot starve a higher-ranked sibling.
 */
const DEFAULT_PER_BRANCH_LIMIT = 4

/**
 * The BFS stops once `maxSuggestions ×` this many candidates are collected,
 * enough surplus for the final sort and dedupe without exhausting a wide trie.
 */
const SUGGESTION_BUDGET_FACTOR = 4

interface BFSItem {
	stateID: number
	depth: number
	tokens: string[]

	/**
	 * Absolute token depth the item's expansion started from, which the two seeding
	 * interpretations place one token apart.
	 */
	base: number
}

/**
 * Autocomplete from the current token prefix, returning suggestions in rank-descending order.
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
		for (const record of trie.entriesAt(match.stateID)) {
			addSuggestion(trie, seen, record, match.depth, normalized, [])
		}

		for (const cont of trie.continuations(match.stateID)) {
			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: match.depth })
		}
	}

	if (prefixState !== undefined) {
		// The exact edge is skipped because the complete-token seeding above already covered that state.
		for (const cont of trie.continuations(prefixState)) {
			if (cont.token === partial || !cont.token.startsWith(partial)) continue

			for (const record of trie.entriesAt(cont.targetState, perBranchLimit)) {
				addSuggestion(trie, seen, record, complete.length + 1, normalized, [cont.token])
			}

			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: complete.length })
		}
	}

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
 * The `dedupe: true` key: the suggestion's full token path, NUL-joined so a token
 * containing a space cannot collide with a token boundary.
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
 * Keep one suggestion per key, relying on the rank-sorted input so the first occurrence wins.
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
