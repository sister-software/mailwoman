/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"

import { beforeAll, describe, expect, it } from "vitest"

import { autocomplete } from "./fst-autocomplete.js"
import { buildFSTFromWOF } from "./fst-builder.js"
import { FSTMatcher } from "./fst-matcher.js"
import type { PlaceEntry, PlacetypeID } from "./fst-types.js"

const WOF_DB = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const HAS_WOF = existsSync(WOF_DB)

describe.skipIf(!HAS_WOF)("FST autocomplete — integration", () => {
	let matcher: FSTMatcher

	beforeAll(() => {
		const built = buildFSTFromWOF({
			dbPath: WOF_DB,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
			onProgress: (phase, detail) => {
				if (phase === "done") console.log(`  ${phase}: ${detail}`)
			},
		})
		matcher = built.matcher
	}, 60_000)

	it("returns suggestions for 'New'", () => {
		const result = autocomplete(matcher, "New", { maxSuggestions: 5 })
		expect(result.suggestions.length).toBeGreaterThan(0)
		const names = result.suggestions.map((s) => s.name.toLowerCase())
		expect(names.some((n) => n.includes("york") || n.includes("new"))).toBe(true)
	})

	it("returns exact matches for 'New York'", () => {
		const result = autocomplete(matcher, "New York")
		const exactMatches = result.suggestions.filter((s) => s.completionTokens.length === 0)
		expect(exactMatches.length).toBeGreaterThanOrEqual(2)
		const types = exactMatches.map((s) => s.placetype)
		expect(types).toContain("locality")
		expect(types).toContain("region")
	})

	it("ranks by importance (prominent places first)", () => {
		const result = autocomplete(matcher, "New York", { maxSuggestions: 5 })
		const localities = result.suggestions.filter((s) => s.placetype === "locality")

		if (localities.length >= 2) {
			expect(localities[0]!.importance).toBeGreaterThanOrEqual(localities[1]!.importance)
		}
	})

	it("returns no suggestions for garbage input", () => {
		const result = autocomplete(matcher, "Xyzzyplugh")
		expect(result.suggestions.length).toBe(0)
		expect(result.depth).toBe(0)
	})

	it("expands completions for 'San'", () => {
		const result = autocomplete(matcher, "San", { maxSuggestions: 10 })
		expect(result.suggestions.length).toBeGreaterThan(0)
		const names = result.suggestions.map((s) => s.name.toLowerCase())
		expect(names.some((n) => n.includes("francisco") || n.includes("san"))).toBe(true)
	})

	it("reports correct depth for partial matches", () => {
		const result = autocomplete(matcher, "New York City")
		expect(result.depth).toBeGreaterThanOrEqual(2)
	})
})

// Synthetic-FST unit tests (no WOF DB needed → always run in CI). Cover the #587 char-level
// partial-last-token completion + dedupeByName. The trie:
//   root --new--> [york -> New York; london -> New London ×2 (city+county)]
//        --san--> [francisco -> San Francisco]
//        --chicago--> Chicago
describe("FST autocomplete — char-level + dedupe (synthetic)", () => {
	const place = (wofID: number, name: string, placetype: PlacetypeID, importance: number): PlaceEntry => ({
		wofID,
		name,
		placetype,
		importance,
		parentChain: [],
		lat: 0,
		lon: 0,
	})
	const matcher = new FSTMatcher([
		{
			edges: new Map([
				["new", 1],
				["san", 4],
				["chicago", 6],
			]),
			places: [],
		}, // 0 root
		{
			edges: new Map([
				["york", 2],
				["london", 3],
			]),
			places: [],
		}, // 1 "new"
		{ edges: new Map(), places: [place(1, "New York", "locality", 0.9)] }, // 2 "new york"
		{ edges: new Map(), places: [place(2, "New London", "locality", 0.5), place(3, "New London", "county", 0.4)] }, // 3 "new london"
		{ edges: new Map([["francisco", 5]]), places: [] }, // 4 "san"
		{ edges: new Map(), places: [place(4, "San Francisco", "locality", 0.8)] }, // 5 "san francisco"
		{ edges: new Map(), places: [place(5, "Chicago", "locality", 0.85)] }, // 6 "chicago"
	])

	it("completes a PARTIAL last token (the #587 fix): 'new yor' → New York", () => {
		const r = autocomplete(matcher, "new yor")
		expect(r.suggestions.map((s) => s.name)).toContain("New York")
	})

	it("completes a single partial token from the root: 'chic' → Chicago", () => {
		const r = autocomplete(matcher, "chic")
		expect(r.suggestions[0]?.name).toBe("Chicago")
	})

	it("does not mis-complete: 'san fr' → San Francisco (not San anything-else)", () => {
		const r = autocomplete(matcher, "san fr")
		expect(r.suggestions.map((s) => s.name)).toEqual(["San Francisco"])
	})

	it("complete-token path is unchanged: 'new york' resolves exactly", () => {
		const r = autocomplete(matcher, "new york")
		expect(r.suggestions[0]?.name).toBe("New York")
	})

	it("dedupeByName collapses same-name places (two New Londons → one)", () => {
		const without = autocomplete(matcher, "new london")
		expect(without.suggestions.filter((s) => s.name === "New London").length).toBe(2)
		const withDedupe = autocomplete(matcher, "new london", { dedupeByName: true })
		expect(withDedupe.suggestions.filter((s) => s.name === "New London").length).toBe(1)
		// keeps the higher-importance one (the locality, 0.5 > the county's 0.4)
		expect(withDedupe.suggestions[0]?.placetype).toBe("locality")
	})

	it("returns nothing for an unmatched prefix", () => {
		expect(autocomplete(matcher, "xyz").suggestions).toEqual([])
	})

	it("a dense branch does not starve a high-importance sibling (#587 per-branch cap)", () => {
		// "go" → "diego" (12 low-importance places) + "tham" (one high-importance Gotham). Without the
		// per-branch cap, the 12 "Go Diego"s blow the budget before "tham" is ever visited, so Gotham
		// (the place a user most likely wants) is dropped — the real "new → New London not New York" bug.
		const dense = new FSTMatcher([
			{ edges: new Map([["go", 1]]), places: [] },
			{
				edges: new Map([
					["diego", 2],
					["tham", 3],
				]),
				places: [],
			},
			{
				edges: new Map(),
				places: Array.from({ length: 12 }, (_, i) => place(100 + i, `Go Diego ${i}`, "locality", 0.1)),
			},
			{ edges: new Map(), places: [place(200, "Gotham", "locality", 0.9)] },
		])
		const r = autocomplete(dense, "go", { maxSuggestions: 3 })
		expect(r.suggestions[0]?.name).toBe("Gotham")
	})

	// Robustness contract for the demo typeahead (#190/#585): the box feeds raw, half-typed input on
	// every keystroke, so the function must never throw and must return [] (not garbage) for input it
	// can't complete. These lock that in so a future refactor can't reintroduce the "Denver for New
	// Yor" class of bug.
	it("empty / whitespace-only query → no suggestions, depth 0", () => {
		for (const q of ["", "   ", "\t"]) {
			const r = autocomplete(matcher, q)
			expect(r.suggestions).toEqual([])
			expect(r.depth).toBe(0)
		}
	})

	it("a partial last token that matches no continuation → [] (not a wrong completion)", () => {
		// "new" walks to a real state, but "zzz" prefixes none of its edges (york/london).
		expect(autocomplete(matcher, "new zzz").suggestions).toEqual([])
	})

	it("respects maxSuggestions (caps a branch with more matches than the limit)", () => {
		// "new" → New York + two New Londons (3 places); cap to 1.
		const r = autocomplete(matcher, "new", { maxSuggestions: 1 })
		expect(r.suggestions.length).toBe(1)
	})

	it("never throws on single-character input", () => {
		expect(() => autocomplete(matcher, "n")).not.toThrow()
		// 'n' prefixes 'new' from the root → at least surfaces the New* places, none mis-typed.
		const r = autocomplete(matcher, "n")
		expect(r.suggestions.every((s) => typeof s.name === "string")).toBe(true)
	})
})
