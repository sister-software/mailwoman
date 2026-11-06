/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { clarityVariants, gradeClarityAnswer, holdsDownTo, locateComponents } from "./clarity.ts"

const LIBRARY = {
	id: "us-opt-accident-library",
	input: "Accident Library, 106 S North St, Accident, MD 21520",
	country: "US",
	components: {
		venue: "Accident Library",
		house_number: "106",
		locality: "Accident",
		region: "MD",
		postcode: "21520",
	},
}

function inputsOf(row: Parameters<typeof clarityVariants>[0]): Record<string, string> {
	return Object.fromEntries(clarityVariants(row).map((variant) => [variant.level, variant.input]))
}

describe("locateComponents", () => {
	it("keeps a repeated value out of the longer value that holds it", () => {
		const spans = locateComponents(LIBRARY.input, LIBRARY.components)
		const locality = spans.find((span) => span.tag === "locality")!

		expect(LIBRARY.input.slice(locality.start, locality.end)).toBe("Accident")
		expect(locality.start).toBeGreaterThan(LIBRARY.input.indexOf("North"))
	})

	it("leaves out a value the input does not write", () => {
		expect(locateComponents("Paris", { locality: "Paris", country: "France" }).map((span) => span.tag)).toEqual([
			"locality",
		])
	})
})

describe("clarityVariants", () => {
	it("renders a row from its full address down to its bare name", () => {
		const inputs = inputsOf(LIBRARY)

		expect(inputs).toMatchObject({
			no_postcode: "Accident Library, 106 S North St, Accident, MD",
			no_venue: "106 S North St, Accident, MD 21520",
			venue_locality_region: "Accident Library, Accident, MD",
			venue_locality: "Accident Library, Accident",
			venue_region: "Accident Library, MD",
			venue_only: "Accident Library",
			locality_region: "Accident, MD",
			locality_only: "Accident",
			region_form: "Accident Library, 106 S North St, Accident, Maryland 21520",
		})
	})

	it("marks a bare name unanchored and a surviving locality anchored", () => {
		const variants = clarityVariants(LIBRARY)

		expect(variants.find((variant) => variant.level === "venue_only")?.anchored).toBe(false)
		expect(variants.find((variant) => variant.level === "venue_locality")?.anchored).toBe(true)
	})

	it("renders no venue level for a row with no venue", () => {
		const inputs = inputsOf({
			id: "us-a",
			input: "888 County Rd CW, Watertown, WI 53094",
			country: "US",
			components: {
				house_number: "888",
				street: "County Rd CW",
				locality: "Watertown",
				region: "WI",
				postcode: "53094",
			},
		})

		expect(inputs["venue_only"]).toBeUndefined()
		expect(inputs["no_postcode"]).toBe("888 County Rd CW, Watertown, WI")
	})
})

describe("gradeClarityAnswer", () => {
	const truth = { lat: 37.9217379, lon: -95.3452908, toleranceKm: 0.3 }
	const ladder = null
	const elsewhere = { lat: 40, lon: -100, declaredAmbiguity: false, candidates: [] }

	it("fails a silent wrong place at every level", () => {
		expect(gradeClarityAnswer({ answer: elsewhere, truth, ladder, anchored: false }).met).toBe(false)
	})

	it("accepts an abstention on a bare name and refuses one with a surviving locality", () => {
		const answer = { lat: null, lon: null, declaredAmbiguity: false, candidates: [] }

		expect(gradeClarityAnswer({ answer, truth, ladder, anchored: false })).toMatchObject({
			outcome: "abstained",
			met: true,
		})

		expect(gradeClarityAnswer({ answer, truth, ladder, anchored: true }).met).toBe(false)
	})

	it("accepts a declared ambiguity only when the truth is among the alternatives", () => {
		const declared = { ...elsewhere, declaredAmbiguity: true, candidates: [truth] }

		expect(gradeClarityAnswer({ answer: declared, truth, ladder, anchored: false })).toMatchObject({
			outcome: "declared",
			met: true,
		})

		expect(
			gradeClarityAnswer({ answer: { ...elsewhere, declaredAmbiguity: true }, truth, ladder, anchored: false }).outcome
		).toBe("wrong_place")
	})
})

describe("holdsDownTo", () => {
	it("reads the sparsest level that answered inside tolerance", () => {
		expect(
			holdsDownTo([
				{ level: "full", outcome: "exact" },
				{ level: "venue_locality", outcome: "exact" },
				{ level: "venue_only", outcome: "wrong_place" },
			])
		).toBe("venue_locality")
	})

	it("reports null when no rendering answered", () => {
		expect(holdsDownTo([{ level: "full", outcome: "wrong_place" }])).toBeNull()
	})
})
