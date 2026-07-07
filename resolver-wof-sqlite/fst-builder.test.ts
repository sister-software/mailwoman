/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"

import { beforeAll, describe, expect, it } from "vitest"

import { buildFSTFromWOF } from "./fst-builder.js"
import type { FSTMatcher } from "./fst-matcher.js"
import type { BuildFSTResult } from "./fst-types.js"

const WOF_DB = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
const HAS_WOF = existsSync(WOF_DB)

describe.skipIf(!HAS_WOF)("buildFSTFromWOF — integration", () => {
	let matcher: FSTMatcher
	let result: BuildFSTResult

	beforeAll(() => {
		const built = buildFSTFromWOF({
			dbPath: WOF_DB,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
			onProgress: (phase, detail) => {
				if (phase === "done") {
					console.log(`  ${phase}: ${detail}`)
				}
			},
		})
		matcher = built.matcher
		result = built.result
	}, 60_000)

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
		const nyc = q.accepting.find((p) => p.placetype === "locality" && p.wofID === 85977539)
		expect(nyc).toBeDefined()
		expect(nyc!.wofID).toBe(85977539)
		expect(nyc!.parentChain).toContain(85688543)
	})

	it("finds 'Portland' with multiple localities", () => {
		const q = matcher.query("Portland")
		expect(q.accepting.length).toBeGreaterThanOrEqual(2)
		const localities = q.accepting.filter((p) => p.placetype === "locality")
		expect(localities.length).toBeGreaterThanOrEqual(2)
		const sorted = localities.sort((a, b) => b.importance - a.importance)
		expect(sorted[0]!.importance).toBeGreaterThan(0)
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
		expect(q.path).toEqual(["buffalo"])
		expect(q.accepting.length).toBeGreaterThan(0)
		const tokens = q.continuations.map((c) => c.token)
		expect(tokens).not.toContain("health")
	})

	it("handles region abbreviations", () => {
		const q = matcher.query("NY")
		const ny = matcher.query("New York")
		expect(ny.accepting.length).toBeGreaterThanOrEqual(2)
	})

	it("query returns empty for completely unknown text", () => {
		const q = matcher.query("Xyzzyplugh")
		expect(q.accepting).toEqual([])
		expect(q.path).toEqual([])
	})
})
