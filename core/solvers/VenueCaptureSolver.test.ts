/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

import { VenueCaptureSolver } from "./VenueCaptureSolver.js"

/**
 * NOTE: In its current form `VenueCaptureSolver` is effectively a no-op. Its loop bodies only `continue` and never
 * mutate the solution, the matches, or the context. The strongest honest assertion we can make is therefore that it
 * leaves the solutions completely untouched — both when a venue is present and when it is absent. (See report: this
 * solver's intended capture behavior is unimplemented and these tests pin the current contract.)
 */

test("venue present (not at start): leaves the solution unchanged", () => {
	const street = Span.from("main")
	street.start = 0
	street.end = 4

	const venue = Span.from("cafe")
	venue.start = 5
	venue.end = 9

	const streetMatch = new SolutionMatch(street, "street")
	const venueMatch = new SolutionMatch(venue, "venue")

	const solution = new Solution([streetMatch, venueMatch])
	const solutions = [solution]

	new VenueCaptureSolver().solve({ solutions })

	// Solver does not add, remove, reorder, or reclassify any match.
	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(2)
	expect(solutions[0]!.matches[0]).toStrictEqual(streetMatch)
	expect(solutions[0]!.matches[1]).toStrictEqual(venueMatch)
})

test("venue at start: leaves the solution unchanged", () => {
	const venue = Span.from("cafe")
	venue.start = 0
	venue.end = 4

	const venueMatch = new SolutionMatch(venue, "venue")
	const solution = new Solution([venueMatch])
	const solutions = [solution]

	new VenueCaptureSolver().solve({ solutions })

	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(1)
	expect(solutions[0]!.matches[0]).toStrictEqual(venueMatch)
})

test("no venue: leaves the solution unchanged", () => {
	const street = Span.from("main")
	street.start = 0
	street.end = 4

	const streetMatch = new SolutionMatch(street, "street")
	const solution = new Solution([streetMatch])
	const solutions = [solution]

	new VenueCaptureSolver().solve({ solutions })

	expect(solutions.length).toStrictEqual(1)
	expect(solutions[0]!.matches.length).toStrictEqual(1)
	expect(solutions[0]!.matches[0]).toStrictEqual(streetMatch)
})
