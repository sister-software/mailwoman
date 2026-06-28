/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Solution, SolutionMatch, Span } from "@mailwoman/core"
import { expect, test } from "vitest"

import { PostcodePositionPenalty } from "./PostcodePositionPenalty.js"

const basePenalty = 0.1

/**
 * Helper to build a span with explicit offsets.
 */
function spanAt(body: string, start: number): Span {
	const span = Span.from(body)
	span.start = start
	span.end = start + body.length

	return span
}

test("postcode + single street, no house number → penalty applied", () => {
	// e.g. "rua godinho de faria 1200" — a postcode-looking trailing number with one street and
	// no house number is the uncommon shape this solver penalizes.
	const street = new SolutionMatch(spanAt("rua godinho de faria", 0), "street")
	const postcode = new SolutionMatch(spanAt("1200", 21), "postcode")

	const solution = new Solution([street, postcode])
	const solutions = [solution]

	new PostcodePositionPenalty().solve({ solutions })

	expect(solution.penalty).toBeCloseTo(basePenalty)
})

test("no postcode → no penalty", () => {
	const street = new SolutionMatch(spanAt("Main Street", 0), "street")

	const solution = new Solution([street])
	const solutions = [solution]

	new PostcodePositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("postcode present but house number present → no penalty", () => {
	const houseNumber = new SolutionMatch(spanAt("12", 0), "house_number")
	const street = new SolutionMatch(spanAt("Main Street", 3), "street")
	const postcode = new SolutionMatch(spanAt("90210", 15), "postcode")

	const solution = new Solution([houseNumber, street, postcode])
	const solutions = [solution]

	new PostcodePositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("postcode present but zero streets → no penalty", () => {
	const postcode = new SolutionMatch(spanAt("90210", 0), "postcode")
	const locality = new SolutionMatch(spanAt("Beverly Hills", 6), "locality")

	const solution = new Solution([postcode, locality])
	const solutions = [solution]

	new PostcodePositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("postcode with 2+ streets (intersection) → no penalty", () => {
	// Intersections legitimately carry a postcode without a house number, so they are exempt.
	const streetA = new SolutionMatch(spanAt("Main Street", 0), "street")
	const streetB = new SolutionMatch(spanAt("Oak Avenue", 12), "street")
	const postcode = new SolutionMatch(spanAt("90210", 23), "postcode")

	const solution = new Solution([streetA, streetB, postcode])
	const solutions = [solution]

	new PostcodePositionPenalty().solve({ solutions })

	expect(solution.penalty).toStrictEqual(0)
})

test("penalty accumulates on an existing penalty rather than overwriting it", () => {
	const street = new SolutionMatch(spanAt("rua godinho de faria", 0), "street")
	const postcode = new SolutionMatch(spanAt("1200", 21), "postcode")

	const solution = new Solution([street, postcode])
	solution.penalty = 0.2
	const solutions = [solution]

	new PostcodePositionPenalty().solve({ solutions })

	expect(solution.penalty).toBeCloseTo(0.2 + basePenalty)
})
