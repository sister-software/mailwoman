/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import { autocomplete } from "./fst-autocomplete.js"
import { buildFstFromWof } from "./fst-builder.js"
import type { FstMatcher } from "./fst-matcher.js"

const WOF_DB = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const HAS_WOF = existsSync(WOF_DB)

describe.skipIf(!HAS_WOF)("FST autocomplete — integration", () => {
	let matcher: FstMatcher

	beforeAll(() => {
		const built = buildFstFromWof({
			dbPath: WOF_DB,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
			onProgress: (phase, detail) => {
				if (phase === "done") console.log(`  ${phase}: ${detail}`)
			},
		})
		matcher = built.matcher
	}, 30_000)

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

	it("ranks by population (NYC before small towns)", () => {
		const result = autocomplete(matcher, "New York", { maxSuggestions: 5 })
		const localities = result.suggestions.filter((s) => s.placetype === "locality")
		if (localities.length >= 2) {
			expect(localities[0]!.population).toBeGreaterThan(localities[1]!.population)
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
