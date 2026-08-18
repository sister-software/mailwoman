/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parity pin for the #1728 phase-2 migration: `fst-autocomplete.ts` now delegates the #587
 *   algorithm to `@mailwoman/ancestrie`, and this suite proves the delegated implementation is
 *   OBSERVATIONALLY IDENTICAL to the algorithm it replaced — same suggestions, same order, same
 *   fields, on the same artifacts.
 *
 *   THE FROZEN COPY IS THE POINT. `legacyAutocomplete` below is the pre-migration implementation,
 *   verbatim. It exists only here, as the reference the adapter is measured against — the shipped
 *   code path is the ancestrie-backed one. If a deliberate behavior change ever lands in ancestrie's
 *   `autocomplete`, this suite fails and the change must be RE-RATIFIED by updating the frozen copy
 *   in the same commit, which is what makes drift between the two homes visible (the #861 rule: the
 *   function is shared; this is the tripwire proving it stays shared).
 *
 *   Two legs:
 *
 *   - Synthetic (always runs): a hand-built trie covering the behavior matrix — referential ties,
 *       states denser than the per-branch cap, encyclopedic present/absent (the two-score split),
 *       per-surface `crossCountryBranches`, deep parent chains, one id reachable at several depths,
 *       the complete+partial shadowing case — pushed through a serialize→deserialize round trip so
 *       the bytes path is exercised too.
 *   - Shipped artifacts (skips when absent): the real `fst-per-locale` binaries for en-gb, es-es and
 *       it-it, queried over a battery derived deterministically from each artifact's own root plus
 *       curated locale surfaces. Format v5 is asserted so the leg cannot silently pin against a
 *       stale-format file.
 */

import { existsSync, readFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

import type { AutocompleteOpts, AutocompleteResult, AutocompleteSuggestion } from "./fst-autocomplete.ts"
import { autocomplete } from "./fst-autocomplete.ts"
import { peekFSTStampFields } from "./fst-freshness.ts"
import { FSTMatcher, normalizeTokens } from "./fst-matcher.ts"
import { deserializeFST, serializeFST } from "./fst-serialize.ts"
import type { PlaceEntry, PlacetypeID } from "./fst-types.ts"

// MARK: The FROZEN pre-migration implementation, verbatim

interface BfsItem {
	stateID: number
	depth: number
	tokens: string[]
	base: number
}

const PER_BRANCH = 4

function topByReferential(entries: readonly PlaceEntry[], k: number): PlaceEntry[] {
	if (entries.length <= k) return [...entries]

	return [...entries].toSorted((a, b) => b.referential - a.referential).slice(0, k)
}

function legacyAutocomplete(fst: FSTMatcher, query: string, opts: AutocompleteOpts = {}): AutocompleteResult {
	const maxSuggestions = opts.maxSuggestions ?? 10
	const maxExpansionDepth = opts.maxExpansionDepth ?? 2
	const normalizedTokens = normalizeTokens(query)

	if (!normalizedTokens.length) {
		return { query, normalizedTokens: [], depth: 0, suggestions: [] }
	}

	const seen = new Map<number, AutocompleteSuggestion>()
	const queue: BfsItem[] = []

	const match = fst.walk(normalizedTokens)
	const complete = normalizedTokens.slice(0, -1)
	const partial = normalizedTokens.at(-1)!
	const prefixState = !complete.length ? 0 : (fst.walk(complete)?.stateID ?? undefined)

	if (!match && prefixState === undefined) {
		return { query, normalizedTokens, depth: 0, suggestions: [] }
	}

	const depth = match?.depth ?? complete.length

	if (match) {
		for (const entry of fst.accepting(match.stateID)) {
			addSuggestion(seen, entry, match.depth, [])
		}

		for (const cont of fst.continuations(match.stateID)) {
			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: match.depth })
		}
	}

	if (prefixState !== undefined) {
		for (const cont of fst.continuations(prefixState)) {
			if (cont.token === partial || !cont.token.startsWith(partial)) continue

			for (const entry of topByReferential(fst.accepting(cont.targetState), PER_BRANCH)) {
				addSuggestion(seen, entry, complete.length + 1, [cont.token])
			}

			queue.push({ stateID: cont.targetState, depth: 1, tokens: [cont.token], base: complete.length })
		}
	}

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
		suggestions = legacyDedupeByName(suggestions)
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

function legacyDedupeByName(suggestions: AutocompleteSuggestion[]): AutocompleteSuggestion[] {
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

// MARK: The comparison harness.

/**
 * Option sets every query runs under — defaults, dedupe, a tight suggestion cap, a shallow expansion.
 */
const OPTION_SETS: readonly AutocompleteOpts[] = [
	{},
	{ dedupeByName: true },
	{ maxSuggestions: 3 },
	{ maxExpansionDepth: 1 },
	{ maxSuggestions: 25, dedupeByName: true },
]

function expectParity(matcher: FSTMatcher, queries: readonly string[]): void {
	for (const query of queries) {
		for (const opts of OPTION_SETS) {
			const legacy = legacyAutocomplete(matcher, query, opts)
			const migrated = autocomplete(matcher, query, opts)

			expect(migrated, `query ${JSON.stringify(query)} opts ${JSON.stringify(opts)}`).toStrictEqual(legacy)
		}
	}
}

// MARK: Synthetic leg — always runs.

describe("fst-autocomplete ↔ ancestrie parity — synthetic", () => {
	const place = (
		wofID: number,
		name: string,
		placetype: PlacetypeID,
		referential: number,
		extra: Partial<PlaceEntry> = {}
	): PlaceEntry => ({
		wofID,
		name,
		placetype,
		referential,
		parentChain: [],
		lat: referential * 10,
		lon: -referential * 10,
		...extra,
	})

	// Root: new, san, chic, chicago, springfield. Behavior matrix in the states:
	//  - "new london": referential TIE between city and county (tie order = insertion order).
	//  - "springfield": SIX entries at one state — denser than PER_BRANCH, forcing the top-4 cut.
	//  - "new york": encyclopedic present + crossCountryBranches + a deep parent chain.
	//  - wofID 4 reachable at BOTH "san francisco" (depth 2) and "chic …" BFS (the shallowest-depth rule).
	//  - "chic" is a complete edge AND a prefix of "chicago" (the #587 shadowing case).
	const nodesMatcher = deserializeThroughBytes([
		{
			edges: new Map([
				["new", 1],
				["san", 4],
				["chic", 6],
				["chicago", 7],
				["springfield", 9],
			]),
			places: [],
		},
		{
			edges: new Map([
				["york", 2],
				["london", 3],
			]),
			places: [],
		},
		{
			edges: new Map(),
			places: [
				place(1, "New York", "locality", 0.9, {
					encyclopedic: 0.75,
					crossCountryBranches: 3,
					parentChain: [11, 12, 13, 14],
				}),
				place(2, "New York", "region", 0.9, { crossCountryBranches: 3, parentChain: [13, 14] }),
			],
		},
		{
			edges: new Map(),
			places: [place(5, "New London", "locality", 0.5), place(6, "New London", "county", 0.5)],
		},
		{ edges: new Map([["francisco", 5]]), places: [] },
		{ edges: new Map(), places: [place(4, "San Francisco", "locality", 0.8, { encyclopedic: 0.6 })] },
		{ edges: new Map([["chi", 8]]), places: [place(10, "Chic", "locality", 0.1)] },
		{ edges: new Map(), places: [place(11, "Chicago", "locality", 0.85, { parentChain: [21, 22] })] },
		{ edges: new Map(), places: [place(4, "San Francisco", "locality", 0.8, { encyclopedic: 0.6 })] },
		{
			edges: new Map(),
			places: [
				place(30, "Springfield", "locality", 0.31),
				place(31, "Springfield", "locality", 0.37),
				place(32, "Springfield", "locality", 0.33),
				place(33, "Springfield", "locality", 0.37),
				place(34, "Springfield", "locality", 0.3),
				place(35, "Springfield", "county", 0.35),
			],
		},
	])

	const QUERIES = [
		"",
		"new",
		"new york",
		"new yor",
		"new london",
		"ne",
		"san",
		"san fr",
		"san francisco",
		"chic",
		"chicago",
		"chic chi",
		"springfield",
		"springfiel",
		"xyzzy",
		"new xyzzy",
		"NEW  YORK.",
	] as const

	it("every query × option set answers identically", () => {
		expectParity(nodesMatcher, QUERIES)
	})
})

/**
 * Round the synthetic trie through the real serializer so parity is measured on entries as the BYTES deliver them (f32
 * referential, flag-gated encyclopedic and ambiguity reads) — not on the hand-built object graph.
 */
function deserializeThroughBytes(nodes: ConstructorParameters<typeof FSTMatcher>[0]): FSTMatcher {
	return deserializeFST(serializeFST(new FSTMatcher(nodes)))
}

// MARK: Shipped-artifact leg — skips when the data root lacks them

/**
 * Locale surfaces worth pinning by name, beyond the derived battery: high-traffic capitals, the multi-token and partial
 * shapes, and (es) the Portopetro pair from the promotion battery.
 */
const CURATED_QUERIES: Record<string, readonly string[]> = {
	"en-gb": ["london", "birming", "st margarets hope", "manchester", "newcastle upon", "isle of"],
	"es-es": ["madrid", "barcel", "illes balears", "portopetro", "san sebastian", "donostia"],
	"it-it": ["roma", "milano", "napo", "reggio di", "citta di"],
}

for (const locale of ["en-gb", "es-es", "it-it"]) {
	const artifactPath = String(dataRootPath("wof", "fst-per-locale", `fst-${locale}.bin`))
	const present = existsSync(artifactPath)

	describe.skipIf(!present)(`fst-autocomplete ↔ ancestrie parity — shipped ${locale}`, () => {
		it("answers identically across the derived + curated battery", () => {
			const stamp = peekFSTStampFields(artifactPath)

			// v5 = the two-score split. A stale-format artifact would pin parity against bytes production
			// no longer ships — fail loudly instead.
			expect(stamp?.formatVersion).toBe(5)

			const matcher = deserializeFST(readFileSync(artifactPath))

			// Deterministic derived battery: the artifact's first dozen root tokens (sorted), each as a
			// bare query, a two-token walk through its own first continuation, and a partial prefix.
			const rootTokens = matcher
				.continuations(0)
				.map((c) => c.token)
				.toSorted()
				.slice(0, 12)

			const derived: string[] = []

			for (const token of rootTokens) {
				derived.push(token, token.slice(0, Math.max(1, token.length - 2)))
				const state = matcher.walk([token])

				if (state) {
					const [first] = matcher.continuations(state.stateID)

					if (first) {
						derived.push(`${token} ${first.token}`, `${token} ${first.token.slice(0, 1)}`)
					}
				}
			}

			expectParity(matcher, [...derived, ...(CURATED_QUERIES[locale] ?? [])])
		})
	})
}
