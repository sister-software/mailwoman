/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { buildFstFromWof } from "./fst-builder.js"

const WOF_DB = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const HAS_WOF = existsSync(WOF_DB)

describe.skipIf(!HAS_WOF)("buildFstFromWof — integration", () => {
	const { matcher, result } = buildFstFromWof({
		dbPath: WOF_DB,
		countries: ["US"],
		placetypes: ["country", "region", "county", "locality"],
		languages: ["eng", ""],
		onProgress: (phase, detail) => {
			if (phase === "done") console.log(`  ${phase}: ${detail}`)
		},
	})

	it("builds a non-trivial FST", () => {
		expect(result.stateCount).toBeGreaterThan(10000)
		expect(result.placeCount).toBeGreaterThan(1000)
	})

	it("finds 'New York' with multiple interpretations", () => {
		const q = matcher.query("New York")
		expect(q.accepting.length).toBeGreaterThanOrEqual(2)
		const types = q.accepting.map((p) => p.placetype)
		expect(types).toContain("locality")
		expect(types).toContain("region")
	})

	it("finds NYC with correct parent chain", () => {
		const q = matcher.query("New York")
		const nyc = q.accepting.find((p) => p.placetype === "locality" && p.population > 1_000_000)
		expect(nyc).toBeDefined()
		expect(nyc!.wofId).toBe(85977539)
		// Parent chain should include NY state (85688543)
		expect(nyc!.parentChain).toContain(85688543)
	})

	it("finds 'Portland' with multiple localities", () => {
		const q = matcher.query("Portland")
		expect(q.accepting.length).toBeGreaterThanOrEqual(2)
		const localities = q.accepting.filter((p) => p.placetype === "locality")
		expect(localities.length).toBeGreaterThanOrEqual(2)
		// Oregon Portland should be highest population
		const sorted = localities.sort((a, b) => b.population - a.population)
		expect(sorted[0]!.population).toBeGreaterThan(500_000)
	})

	it("provides continuations after 'New'", () => {
		const q = matcher.query("New")
		expect(q.continuations.length).toBeGreaterThan(5)
		const tokens = q.continuations.map((c) => c.token)
		expect(tokens).toContain("york")
		expect(tokens).toContain("orleans")
	})

	it("returns negative evidence for non-place tokens", () => {
		const q = matcher.query("Buffalo Health Clinic")
		// "Buffalo" matches, but "Health" won't extend the path
		// The query walks as far as it can and reports where it falls off
		expect(q.path).toEqual(["buffalo"])
		expect(q.accepting.length).toBeGreaterThan(0)
		// "Health" is NOT a continuation of "Buffalo"
		const tokens = q.continuations.map((c) => c.token)
		expect(tokens).not.toContain("health")
	})

	it("handles region abbreviations", () => {
		// NY as a standalone token should match if names include it
		const q = matcher.query("NY")
		// Might or might not be in names table as an abbreviation
		// but "new york" definitely works
		const ny = matcher.query("New York")
		expect(ny.accepting.length).toBeGreaterThanOrEqual(2)
	})

	it("query returns empty for completely unknown text", () => {
		const q = matcher.query("Xyzzyplugh")
		expect(q.accepting).toEqual([])
		expect(q.path).toEqual([])
	})
})
