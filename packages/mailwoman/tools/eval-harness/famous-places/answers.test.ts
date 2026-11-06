// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { gradeFamousPlaceAnswer, tallyFamousPlaceAnswers } from "./answers.ts"

const CENTRAL_PARK = { lat: 40.7825, lon: -73.966111111, tolerance_m: 5000 }

describe("gradeFamousPlaceAnswer", () => {
	it("passes an answer inside the row's tolerance", () => {
		const graded = gradeFamousPlaceAnswer(CENTRAL_PARK, { lat: 40.78260075, lon: -73.96554959 })

		expect(graded.outcome).toBe("within_tolerance")
		expect(graded.km).toBeLessThan(1)
	})

	it("reports a coordinate outside the tolerance as the wrong place, with its distance", () => {
		const graded = gradeFamousPlaceAnswer(CENTRAL_PARK, { lat: 40.751775, lon: -73.485888 })

		expect(graded.outcome).toBe("wrong_place")
		expect(graded.km).toBeGreaterThan(5)
	})

	it("keeps an absent coordinate apart from a wrong one", () => {
		expect(gradeFamousPlaceAnswer(CENTRAL_PARK, { lat: null, lon: null })).toEqual({
			outcome: "no_coordinate",
			km: null,
		})
	})

	it("reads the tolerance from the row", () => {
		const answer = { lat: 40.751775, lon: -73.485888 }

		expect(gradeFamousPlaceAnswer({ ...CENTRAL_PARK, tolerance_m: 50_000 }, answer).outcome).toBe("within_tolerance")
	})
})

describe("tallyFamousPlaceAnswers", () => {
	const row = (input: string, kind: string, form: string) => ({ input, kind, form })
	const answered = { lat: 1, lon: 2, tier: "admin" }
	const unanswered = { lat: null, lon: null, tier: "admin" }

	const tally = tallyFamousPlaceAnswers([
		{ row: row("A", "landmark", "en"), answer: answered, graded: { outcome: "within_tolerance", km: 0.1 } },
		{ row: row("B", "landmark", "en"), answer: answered, graded: { outcome: "wrong_place", km: 40 } },
		{ row: row("C", "capital", "local"), answer: unanswered, graded: { outcome: "no_coordinate", km: null } },
	])

	it("counts each outcome per kind and form", () => {
		expect(tally.n).toBe(3)
		expect(tally.withinTolerance).toBe(1)

		expect(tally.byKindForm).toEqual({
			"landmark/en": { within_tolerance: 1, wrong_place: 1, no_coordinate: 0, n: 2 },
			"capital/local": { within_tolerance: 0, wrong_place: 0, no_coordinate: 1, n: 1 },
		})
	})

	it("lists every missed row with its input and answer", () => {
		expect(tally.misses.map((miss) => [miss.input, miss.outcome, miss.tier])).toEqual([
			["B", "wrong_place", "admin"],
			["C", "no_coordinate", "admin"],
		])
	})
})
