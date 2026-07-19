/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the POI query board's grading core (`gradeCase`) and the committed fixture contract.
 *   No db, no classifier, no resolver — `gradeCase` is graded against synthetic `PoiBoardOutcome`
 *   fakes, matching the "no db needed" discipline `fragment-board.test.ts` set for the interval math.
 */

import { readFileSync } from "node:fs"

import type { POIIntentOutcome } from "@mailwoman/core/pipeline"
import { describe, expect, it } from "vitest"

import { gradeCase, POI_BOARD_FIXTURES, type PoiBoardFixture, type PoiBoardOutcome } from "./poi-board.ts"

const fixtures = readFileSync(POI_BOARD_FIXTURES, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as PoiBoardFixture)

function intentOutcome(poiIntent: POIIntentOutcome): PoiBoardOutcome {
	return { path: "poi", poiIntent }
}

const resultsFixture: PoiBoardFixture = {
	id: "t-results",
	query: "cafe near Springfield IL",
	expect: {
		kind: "results",
		categoryID: "cafe",
		anchorGold: { latitude: 39.7817, longitude: -89.6501 },
		maxNearestKm: 25,
	},
}

const abstainFixture: PoiBoardFixture = {
	id: "t-abstain",
	query: "fire hydrant near Springfield IL",
	expect: { kind: "abstain", reason: "requires_build_local_layer" },
}

const addressFixture: PoiBoardFixture = {
	id: "t-address",
	query: "350 5th Ave, New York, NY 10118",
	expect: { kind: "address" },
}

function poiResult(
	overrides: Partial<NonNullable<Extract<POIIntentOutcome, { type: "intent" }>["results"]>[number]> = {}
) {
	return {
		name: "Some Place",
		categoryID: "cafe",
		brandWikidata: null,
		latitude: 39.78,
		longitude: -89.65,
		country: "US",
		confidence: 0.9,
		gersID: "gers-1",
		...overrides,
	}
}

describe("gradeCase — results expectation", () => {
	it("passes when ≥1 result, nearest within range, top category matches", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "cafe", matched: "cafe" } },
			results: [poiResult({ latitude: 39.7817, longitude: -89.6501 })],
		})

		const grade = gradeCase(resultsFixture, outcome)

		expect(grade.pass).toBe(true)
		expect(grade.nearestKm).toBeCloseTo(0, 3)
		expect(grade.resultCount).toBe(1)
	})

	it("uses the NEAREST result's distance, not necessarily the top-ranked one", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "cafe", matched: "cafe" } },
			results: [
				poiResult({ latitude: 10, longitude: 10 }), // top-ranked, far away
				poiResult({ latitude: 39.7817, longitude: -89.6501 }), // second, right on the gold point
			],
		})

		const grade = gradeCase(resultsFixture, outcome)

		// Nearest distance is ~0 even though the top result is far — but the top-category check still
		// applies to the TOP result, so this fixture (both results categoryID "cafe") still passes.
		expect(grade.nearestKm).toBeLessThan(1)
	})

	it("fails when the nearest result is outside maxNearestKm", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "cafe", matched: "cafe" } },
			results: [poiResult({ latitude: 10, longitude: 10 })], // far from Springfield IL
		})

		const grade = gradeCase(resultsFixture, outcome)

		expect(grade.pass).toBe(false)
		expect(grade.detail).toMatch(/> maxNearestKm/)
	})

	it("fails when the top result's category doesn't match, even if in range", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "cafe", matched: "cafe" } },
			results: [poiResult({ latitude: 39.7817, longitude: -89.6501, categoryID: "restaurant" })],
		})

		const grade = gradeCase(resultsFixture, outcome)

		expect(grade.pass).toBe(false)
		expect(grade.detail).toMatch(/top category restaurant !== expected cafe/)
	})

	it("fails on zero results", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "cafe", matched: "cafe" } },
			results: [],
		})

		const grade = gradeCase(resultsFixture, outcome)

		expect(grade.pass).toBe(false)
		expect(grade.resultCount).toBe(0)
		expect(grade.nearestKm).toBeUndefined()
	})

	it("fails when the outcome is an abstain instead of results", () => {
		const outcome = intentOutcome({ type: "abstain", reason: "anchor_required" })
		const grade = gradeCase(resultsFixture, outcome)

		expect(grade.pass).toBe(false)
		expect(grade.detail).toMatch(/got abstain\(anchor_required\)/)
	})

	it("fails when the pipeline never took the poi path at all", () => {
		const grade = gradeCase(resultsFixture, { path: "full" })

		expect(grade.pass).toBe(false)
		expect(grade.detail).toMatch(/no poi intent/)
	})
})

describe("gradeCase — abstain expectation", () => {
	it("passes on an exact reason match", () => {
		const outcome = intentOutcome({ type: "abstain", reason: "requires_build_local_layer" })
		const grade = gradeCase(abstainFixture, outcome)

		expect(grade.pass).toBe(true)
	})

	it("fails on a different abstain reason", () => {
		const outcome = intentOutcome({ type: "abstain", reason: "anchor_required" })
		const grade = gradeCase(abstainFixture, outcome)

		expect(grade.pass).toBe(false)
		expect(grade.detail).toMatch(/expected abstain\(requires_build_local_layer\), got abstain\(anchor_required\)/)
	})

	it("fails when the outcome carries results instead of an abstain", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "fire_hydrant", matched: "fire hydrant" } },
			results: [poiResult({ categoryID: "fire_hydrant" })],
		})

		const grade = gradeCase(abstainFixture, outcome)

		expect(grade.pass).toBe(false)
	})
})

describe("gradeCase — address expectation", () => {
	it("passes when the pipeline never claims the poi path", () => {
		const grade = gradeCase(addressFixture, { path: "full" })

		expect(grade.pass).toBe(true)
	})

	it("passes when path is full-length address parse even with poiIntent absent", () => {
		const grade = gradeCase(addressFixture, { path: "fast-path" })

		expect(grade.pass).toBe(true)
	})

	it("fails when the poi branch wrongly claims a full address", () => {
		const outcome = intentOutcome({
			type: "intent",
			intent: { subject: { kind: "category", categoryID: "hospital", matched: "hospital" } },
		})

		const grade = gradeCase(addressFixture, outcome)

		expect(grade.pass).toBe(false)
		expect(grade.detail).toMatch(/poi branch claimed it/)
	})
})

describe("the committed poi-board fixture set", () => {
	it("carries ~45 cases", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(40)
		expect(fixtures.length).toBeLessThanOrEqual(50)
	})

	it("has unique ids", () => {
		const ids = fixtures.map((f) => f.id)

		expect(new Set(ids).size).toBe(ids.length)
	})

	it("carries every expect kind the spec requires", () => {
		const kinds = new Set(fixtures.map((f) => f.expect.kind))

		expect(kinds).toContain("results")
		expect(kinds).toContain("abstain")
		expect(kinds).toContain("address")
	})

	it("covers all four poi.db countries with ≥4 category+anchor cases each (via well-known city anchors)", () => {
		const cityToCountry: Record<string, string> = {
			springfield: "US",
			chicago: "US",
			austin: "US",
			seattle: "US",
			denver: "US",
			toronto: "CA",
			ottawa: "CA",
			vancouver: "CA",
			calgary: "CA",
			montreal: "CA",
			guadalajara: "MX",
			tijuana: "MX",
			monterrey: "MX",
			cancun: "MX",
			mexico: "MX",
			lyon: "FR",
			marseille: "FR",
			toulouse: "FR",
			nice: "FR",
			paris: "FR",
		}

		const counts: Record<string, number> = { US: 0, CA: 0, MX: 0, FR: 0 }

		for (const f of fixtures) {
			if (f.expect.kind !== "results") continue
			const lower = f.query.toLowerCase()
			const hit = Object.entries(cityToCountry).find(([city]) => lower.includes(city))

			if (hit) {
				counts[hit[1]]!++
			}
		}

		for (const country of ["US", "CA", "MX", "FR"]) {
			expect(counts[country], `${country} count`).toBeGreaterThanOrEqual(4)
		}
	})

	it("gates at least one locale-synonym case to an exact locale, and at least one is ungated", () => {
		const withLocale = fixtures.filter((f) => f.locale)

		expect(withLocale.length).toBeGreaterThanOrEqual(1)

		const withoutLocale = fixtures.filter((f) => !f.locale && f.expect.kind === "results")

		expect(withoutLocale.length).toBeGreaterThanOrEqual(1)
	})

	it("every results-kind expect carries a plausible lat/lon and a positive maxNearestKm", () => {
		for (const f of fixtures) {
			if (f.expect.kind !== "results") continue
			const { latitude, longitude } = f.expect.anchorGold

			expect(Math.abs(latitude), f.id).toBeLessThanOrEqual(90)
			expect(Math.abs(longitude), f.id).toBeLessThanOrEqual(180)
			expect(f.expect.maxNearestKm, f.id).toBeGreaterThan(0)
		}
	})

	it("every abstain-kind expect carries a non-empty reason", () => {
		for (const f of fixtures) {
			if (f.expect.kind !== "abstain") continue
			expect(f.expect.reason.length, f.id).toBeGreaterThan(0)
		}
	})
})
