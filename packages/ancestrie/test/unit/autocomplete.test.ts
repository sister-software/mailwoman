/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Autocomplete behaviors ported from mailwoman's `fst-autocomplete` (#587): partial-last-token
 *   completion, the complete-token-must-not-shadow rule, the per-branch cap, dedupe, and the
 *   robustness contract (never throw, [] over garbage). Plus the parts the FST could not answer:
 *   every suggestion's containment chain.
 */

import { autocomplete } from "@mailwoman/ancestrie/autocomplete"
import { AncestrieBuilder } from "@mailwoman/ancestrie/builder"
import { Ancestrie } from "@mailwoman/ancestrie/reader"
import type { AncestrieEntry } from "@mailwoman/ancestrie/types"
import { describe, expect, it } from "vitest"

function seal(entries: readonly AncestrieEntry[]): Ancestrie {
	const builder = new AncestrieBuilder()

	for (const entry of entries) {
		builder.add(entry)
	}

	return Ancestrie.from(builder.seal())
}

// The synthetic trie the FST suite used:
//   root --new--> [york → New York; london → New London ×2 (city 2 + county 3)]
//        --san--> [francisco → San Francisco]
//        --chicago--> Chicago
const CITIES = seal([
	{ tokens: ["new", "york"], id: 1, parentIDs: [], rank: 0.9, payload: { name: "New York" } },
	{ tokens: ["new", "london"], id: 2, parentIDs: [], rank: 0.5, payload: { name: "New London" } },
	{ tokens: ["new", "london"], id: 3, parentIDs: [], rank: 0.4, payload: { name: "New London" } },
	{ tokens: ["san", "francisco"], id: 4, parentIDs: [], rank: 0.8, payload: { name: "San Francisco" } },
	{ tokens: ["chicago"], id: 5, parentIDs: [], rank: 0.85, payload: { name: "Chicago" } },
])

describe("char-level partial completion + BFS (#587 ports)", () => {
	it("completes a PARTIAL last token: 'new yor' → New York", () => {
		const r = autocomplete(CITIES, ["new", "yor"])

		expect(r.suggestions.map((s) => s.id)).toContain(1)
		expect(r.suggestions.find((s) => s.id === 1)!.completionTokens).toEqual(["york"])
		expect(r.suggestions.find((s) => s.id === 1)!.tokens).toEqual(["new", "york"])
	})

	it("completes a single partial token from the root: 'chic' → Chicago", () => {
		const r = autocomplete(CITIES, ["chic"])

		expect(r.suggestions[0]?.id).toBe(5)
	})

	it("a complete-token walk must not SHADOW the partial interpretation", () => {
		// The live FST artifact held a place literally named "Chic" — the typed prefix is BOTH a
		// complete edge and a partial of "chicago", and letting the successful walk short-circuit
		// silently dropped every longer completion.
		const shadowed = seal([
			{ tokens: ["chic"], id: 10, parentIDs: [], rank: 0.1 },
			{ tokens: ["chicago"], id: 11, parentIDs: [], rank: 0.85 },
			{ tokens: ["chicago", "heights"], id: 12, parentIDs: [], rank: 0.4 },
		])

		const r = autocomplete(shadowed, ["chic"])
		const ids = r.suggestions.map((s) => s.id)

		expect(ids).toContain(10)
		expect(ids).toContain(11)
		expect(r.suggestions[0]?.id).toBe(11)
	})

	it("does not mis-complete: 'san fr' → San Francisco only", () => {
		const r = autocomplete(CITIES, ["san", "fr"])

		expect(r.suggestions.map((s) => s.id)).toEqual([4])
	})

	it("complete-token path is unchanged: 'new york' resolves exactly", () => {
		const r = autocomplete(CITIES, ["new", "york"])

		expect(r.suggestions[0]?.id).toBe(1)
		expect(r.suggestions[0]?.completionTokens).toEqual([])
		expect(r.depth).toBe(2)
	})

	it("BFS reaches multi-token completions past a partial: 'new yor' → New York Mills", () => {
		const mills = seal([
			{ tokens: ["new", "york"], id: 1, parentIDs: [], rank: 0.9 },
			{ tokens: ["new", "york", "mills"], id: 2, parentIDs: [], rank: 0.3 },
		])

		const r = autocomplete(mills, ["new", "yor"])
		const suggestion = r.suggestions.find((s) => s.id === 2)

		expect(suggestion?.completionTokens).toEqual(["york", "mills"])
		expect(suggestion?.tokens).toEqual(["new", "york", "mills"])
	})

	it("a dense branch does not starve a high-rank sibling (#587 per-branch cap)", () => {
		// "go" → "diego" (12 low-rank entries) + "tham" (one high-rank Gotham). Without the cap the
		// 12 fill the budget before "tham" is visited, and the entry a user most likely wants drops.
		const dense = seal([
			...Array.from({ length: 12 }, (_, i): AncestrieEntry => {
				return { tokens: ["go", "diego"], id: 100 + i, parentIDs: [], rank: 0.1 }
			}),
			{ tokens: ["go", "tham"], id: 200, parentIDs: [], rank: 0.9 },
		])

		const r = autocomplete(dense, ["go"], { maxSuggestions: 3 })

		expect(r.suggestions[0]?.id).toBe(200)
	})
})

describe("dedupe", () => {
	it("off by default: distinct same-surface entries all surface", () => {
		const r = autocomplete(CITIES, ["new", "london"])

		expect(r.suggestions.filter((s) => s.tokens.join(" ") === "new london")).toHaveLength(2)
	})

	it("dedupe: true collapses same-token-path suggestions to the highest-ranked", () => {
		const r = autocomplete(CITIES, ["new", "london"], { dedupe: true })
		const newLondons = r.suggestions.filter((s) => s.tokens.join(" ") === "new london")

		expect(newLondons).toHaveLength(1)
		expect(newLondons[0]?.id).toBe(2)
	})

	it("dedupe accepts a caller-supplied key function", () => {
		// Collapse by payload name — the literal dedupeByName the FST shipped.
		const r = autocomplete(CITIES, ["new", "london"], {
			dedupe: (s) => ((s.payload as { name: string }).name ?? "").toLowerCase(),
		})

		expect(r.suggestions.filter((s) => s.id === 2 || s.id === 3)).toHaveLength(1)
	})
})

describe("robustness contract", () => {
	it("empty and whitespace-collapsed queries → no suggestions, depth 0", () => {
		for (const query of [[], [""], ["", ""]] as string[][]) {
			const r = autocomplete(CITIES, query)

			expect(r.suggestions).toEqual([])
			expect(r.depth).toBe(0)
		}
	})

	it("an unmatched prefix → []", () => {
		expect(autocomplete(CITIES, ["xyz"]).suggestions).toEqual([])
	})

	it("a partial last token matching no continuation → [] (not a wrong completion)", () => {
		expect(autocomplete(CITIES, ["new", "zzz"]).suggestions).toEqual([])
	})

	it("respects maxSuggestions", () => {
		const r = autocomplete(CITIES, ["new"], { maxSuggestions: 1 })

		expect(r.suggestions).toHaveLength(1)
	})

	it("never throws on single-character input", () => {
		expect(() => autocomplete(CITIES, ["n"])).not.toThrow()
		const r = autocomplete(CITIES, ["n"])

		expect(r.suggestions.every((s) => typeof s.id === "number")).toBe(true)
	})
})

describe("the normalizeToken boundary", () => {
	it("the same normalizer on both sides makes cased queries meet folded entries", () => {
		const fold = (token: string) => token.normalize("NFKC").toLowerCase()
		const builder = new AncestrieBuilder({ normalizeToken: fold })
		builder.add({ tokens: ["New", "York"], id: 1, parentIDs: [], rank: 0.9 })
		const trie = Ancestrie.from(builder.seal())

		expect(autocomplete(trie, ["NEW", "YOR"], { normalizeToken: fold }).suggestions.map((s) => s.id)).toEqual([1])
		// Without the query-side normalizer the cased query misses — the normalization boundary is the caller's contract.
		expect(autocomplete(trie, ["NEW", "YOR"]).suggestions).toEqual([])
	})
})

describe("New-York-style fixture: same surface, different entries, chains attached", () => {
	// US (100) ⊃ New York State (10) ⊃ New York County (21) ⊃ New York City (11).
	// State, county, and city all accept at the surface "new york"; "nyc" aliases the city.
	const nyTrie = seal([
		{ tokens: ["united", "states"], id: 100, parentIDs: [], rank: 0.95 },
		{ tokens: ["new", "york"], id: 10, parentIDs: [100], rank: 0.7, payload: { kind: "region" } },
		{ tokens: ["new", "york"], id: 21, parentIDs: [10], rank: 0.4, payload: { kind: "county" } },
		{ tokens: ["new", "york"], id: 11, parentIDs: [21], rank: 0.9, payload: { kind: "locality" } },
		{ tokens: ["nyc"], id: 11, parentIDs: [21], rank: 0.9, payload: { kind: "locality" } },
	])

	it("an exact walk surfaces all three same-surface entries, rank-descending", () => {
		const r = autocomplete(nyTrie, ["new", "york"])
		const exact = r.suggestions.filter((s) => s.completionTokens.length === 0)

		expect(exact.map((s) => s.id)).toEqual([11, 10, 21])
	})

	it("dedupe: true keeps only the city — the highest-ranked at that surface", () => {
		const r = autocomplete(nyTrie, ["new", "york"], { dedupe: true })
		const exact = r.suggestions.filter((s) => s.completionTokens.length === 0)

		expect(exact.map((s) => s.id)).toEqual([11])
	})

	it("every suggestion carries its containment chain, nearest parent first", () => {
		const r = autocomplete(nyTrie, ["new", "yor"])
		const city = r.suggestions.find((s) => s.id === 11)!
		const county = r.suggestions.find((s) => s.id === 21)!

		expect(city.chain).toEqual([21, 10, 100])
		expect(county.chain).toEqual([10, 100])
		expect(city.parentIDs).toEqual([21])
	})

	it("the alias surface reaches the same entry with the same chain", () => {
		const r = autocomplete(nyTrie, ["nyc"])
		const city = r.suggestions.find((s) => s.id === 11)!

		expect(city.tokens).toEqual(["nyc"])
		expect(city.chain).toEqual([21, 10, 100])
		expect(city.payload).toEqual({ kind: "locality" })
	})

	it("chains agree with the interval answers", () => {
		expect(nyTrie.contains(100, 11)).toBe(true)
		expect(nyTrie.contains(10, 11)).toBe(true)
		expect(nyTrie.contains(11, 10)).toBe(false)
		expect(nyTrie.descendantsOf(10)).toEqual([21, 11])
	})
})
