/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span } from "@mailwoman/core"
import { expect, test } from "vitest"
import { LeadingAreaDeclassifier } from "./LeadingAreaDeclassifier.js"

/**
 * Rule: within a solution, an admin match (locality / region / country) is removed when it ends
 * before the last NON-admin match. Postcode is treated as "neutral" — it neither advances the
 * non-admin cursor nor is it ever removed.
 */

test("leading admin before a non-admin match is removed", () => {
	// "CA main" — region precedes a street, so region.end (2) < street.end (7) => declassified.
	const region = Span.from("CA")
	region.start = 0
	region.end = 2

	const street = Span.from("main")
	street.start = 3
	street.end = 7

	const regionMatch = new SolutionMatch(region, "region")
	const streetMatch = new SolutionMatch(street, "street")

	const solutions = [new Solution([regionMatch, streetMatch])]

	new LeadingAreaDeclassifier().solve({ solutions })

	expect(solutions[0]!.matches.length).toStrictEqual(1)
	expect(solutions[0]!.matches[0]).toStrictEqual(streetMatch)
})

test("trailing admin after the last non-admin match is retained", () => {
	// "main CA" — region follows the street, so region.end (7) is NOT < street.end (4) => kept.
	const street = Span.from("main")
	street.start = 0
	street.end = 4

	const region = Span.from("CA")
	region.start = 5
	region.end = 7

	const streetMatch = new SolutionMatch(street, "street")
	const regionMatch = new SolutionMatch(region, "region")

	const solutions = [new Solution([streetMatch, regionMatch])]

	new LeadingAreaDeclassifier().solve({ solutions })

	expect(solutions[0]!.matches.length).toStrictEqual(2)
	// Matches are re-sorted by span.start ascending.
	expect(solutions[0]!.matches[0]).toStrictEqual(streetMatch)
	expect(solutions[0]!.matches[1]).toStrictEqual(regionMatch)
})

test("postcode is neutral: a leading admin is removed but the postcode survives", () => {
	// "12345 CA main" — postcode is neutral (does not advance the cursor and is never removed),
	// the region precedes the street so it is declassified, and the postcode + street remain.
	const postcode = Span.from("12345")
	postcode.start = 0
	postcode.end = 5

	const region = Span.from("CA")
	region.start = 6
	region.end = 8

	const street = Span.from("main")
	street.start = 9
	street.end = 13

	const postcodeMatch = new SolutionMatch(postcode, "postcode")
	const regionMatch = new SolutionMatch(region, "region")
	const streetMatch = new SolutionMatch(street, "street")

	const solutions = [new Solution([postcodeMatch, regionMatch, streetMatch])]

	new LeadingAreaDeclassifier().solve({ solutions })

	const labels = solutions[0]!.matches.map((m) => m.classification)

	expect(labels).toStrictEqual(["postcode", "street"])
})

test("admin-only solution: nothing is removed (cursor never advances past 0)", () => {
	// With no non-admin match, lastNonAdminCursorPosition stays 0, so no admin is < 0 => all kept.
	const region = Span.from("CA")
	region.start = 0
	region.end = 2

	const country = Span.from("USA")
	country.start = 3
	country.end = 6

	const regionMatch = new SolutionMatch(region, "region")
	const countryMatch = new SolutionMatch(country, "country")

	const solutions = [new Solution([regionMatch, countryMatch])]

	new LeadingAreaDeclassifier().solve({ solutions })

	expect(solutions[0]!.matches.length).toStrictEqual(2)
})

test("solutions are sorted by score descending", () => {
	const spanA = Span.from("main")
	spanA.start = 0
	spanA.end = 4

	const spanB = Span.from("oak")
	spanB.start = 0
	spanB.end = 3

	const low = new Solution([new SolutionMatch(spanA, "street")])
	low.score = 1

	const high = new Solution([new SolutionMatch(spanB, "street")])
	high.score = 5

	const solutions = [low, high]

	new LeadingAreaDeclassifier().solve({ solutions })

	expect(solutions[0]).toStrictEqual(high)
	expect(solutions[1]).toStrictEqual(low)
})
