/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { existsSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { beforeAll, describe, expect, it } from "vitest"

import { buildFSTFromWOF } from "./fst-builder.ts"
import type { FSTMatcher } from "./fst-matcher.ts"
import type { BuildFSTResult } from "./fst-types.ts"

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

// The curation block runs against the canonical admin DB (the artifact the shipped per-locale FSTs
// are actually built from) — the per-repo DB above is a legacy fixture absent on newer hosts.
const ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))
const HAS_ADMIN = existsSync(ADMIN_DB)

describe.skipIf(!HAS_ADMIN)("buildFSTFromWOF — degenerate-surface curation", () => {
	let matcher: FSTMatcher
	let provenance: import("./fst-types.ts").FSTProvenance

	beforeAll(() => {
		const built = buildFSTFromWOF({
			dbPath: ADMIN_DB,
			countries: ["US"],
			placetypes: ["country", "region", "county", "locality"],
			languages: ["eng", ""],
			// The shipped-index victims: "la" = the case-folded Los Angeles alias colliding with the
			// French article; "boulevard" = Boulevard, CA colliding with the street-type word.
			excludeSurfaces: new Set(["la", "boulevard"]),
			excludeAllTokensOf: new Set(["de", "la", "du", "des"]),
			exclusionPolicy: "test-policy",
		})
		matcher = built.matcher
		provenance = built.provenance
	}, 60_000)

	it("refuses whole-surface degenerate keys", () => {
		expect(matcher.query("la").accepting).toEqual([])
		expect(matcher.query("boulevard").accepting).toEqual([])
	})

	it("keeps multi-token names containing a degenerate token", () => {
		// Curation is whole-surface only — Los Angeles must remain findable.
		expect(matcher.query("Los Angeles").accepting.length).toBeGreaterThan(0)
	})

	it("refuses all-function-word compositions", () => {
		expect(matcher.query("de la").accepting).toEqual([])
	})

	it("records the policy + excluded count in provenance", () => {
		expect(provenance.exclusionPolicy).toBe("test-policy")
		expect(provenance.excludedInsertions).toBeGreaterThan(0)
	})
})
