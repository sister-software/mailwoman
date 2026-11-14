// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import {
	countShapes,
	countSourceShapes,
	intendedShapeDraws,
	intendedShapeExposure,
	poissonLowerTailBound,
	shapeExposure,
} from "./shapes.ts"

describe("intended country–shape exposure", () => {
	const street = ["house_number", "street", "locality"]
	const venue = ["venue", "street", "locality", "region", "postcode"]

	const sources = countSourceShapes(
		[
			{ source: "a", country: "FR", spanTags: street },
			{ source: "a", country: "FR", spanTags: street },
			{ source: "a", country: "FR", spanTags: street },
			{ source: "a", country: "BE", spanTags: street },
			{ source: "b", country: "US", spanTags: venue },
			// Never drawn: a zero-weighted country.
			{ source: "b", country: "XX", spanTags: venue },
		],
		{ FR: 1, BE: 1, US: 1, XX: 0 }
	)

	it("spreads each source's requested share over its keys by their rows", () => {
		const intended = intendedShapeDraws(
			new Map([
				["a", 0.8],
				["b", 0.2],
			]),
			1000,
			sources
		)

		expect(intended.get("FR|house_number -> street -> locality")).toBeCloseTo(600, 9)
		expect(intended.get("BE|house_number -> street -> locality")).toBeCloseTo(200, 9)
		expect(intended.get("US|venue -> street -> locality -> region -> postcode")).toBeCloseTo(200, 9)
		expect(intended.has("XX|venue -> street -> locality -> region -> postcode")).toBe(false)
	})

	it("refuses a requested source it counted no rows for", () => {
		expect(() => intendedShapeDraws(new Map([["missing", 1]]), 10, sources)).toThrow("'missing' has no counted")
	})

	it("reports under-exposed, unreachable retained and unintended keys", () => {
		const intended = new Map([
			["FR|street", 600],
			["BE|street", 200],
			["PF|street -> postcode", 0.2],
		])

		const report = intendedShapeExposure(
			intended,
			new Map([
				["FR|street", 590],
				["BE|street", 120],
				["US|unit -> street", 3],
			]),
			713,
			["PF|street -> postcode", "FR|street"]
		)

		expect(report.underExposed).toEqual(["BE|street"])
		expect(report.retainedBelowOneIntended).toEqual(["PF|street -> postcode"])
		expect(report.unintended).toEqual(["US|unit -> street"])
		expect(report.keys).toBe(4)
	})

	it("bounds the Poisson lower tail from above", () => {
		// P(X = 0 | λ = 5) is e^-5 exactly. P(X ≤ 3 | λ = 10) is 0.0103, under its bound.
		expect(poissonLowerTailBound(0, 5)).toBeCloseTo(Math.exp(-5), 12)
		expect(poissonLowerTailBound(3, 10)).toBeGreaterThan(0.0103)
		expect(poissonLowerTailBound(12, 10)).toBe(1)
	})
})

describe("shapeExposure", () => {
	it("counts rows by the retention table's key and reports the retained keys never drawn", () => {
		const { counts, rows } = countShapes([
			{ country: "FR", spanTags: ["house_number", "street", "locality"] },
			{ country: "FR", spanTags: ["house_number", "street", "locality"] },
			{ country: "US", spanTags: ["venue", "locality"] },
			{ country: null, spanTags: ["street"] },
		])

		expect(rows).toBe(4)
		expect(counts.get("FR|house_number -> street -> locality")).toBe(2)

		const report = shapeExposure(
			["FR|house_number -> street -> locality", "US|venue -> locality", "GB|unit -> street"],
			counts,
			rows
		)

		expect(report).toMatchObject({ retainedKeys: 3, drawn: 2, undrawn: ["GB|unit -> street"], consumedRows: 4 })
		expect(report.byKey[0]).toEqual({ key: "GB|unit -> street", consumed: 0 })
	})
})
