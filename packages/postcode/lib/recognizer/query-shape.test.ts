// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it, test } from "vitest"

import { computeQueryShape } from "#recognizer/query-shape"

describe("the region abbreviations of computeQueryShape", () => {
	it.each([
		["Washington, DC 20500", "DC"],
		["350 5th Ave, New York, NY 10118", "NY"],
		["1600 Pennsylvania Ave NW, Washington, DC 20500", "DC"],
		["Pier 39, San Francisco, CA 94133", "CA"],
	])("finds the abbreviation in %s", (text, abbreviation) => {
		expect(computeQueryShape(text).regionAbbreviations.map(({ span }) => span)).toEqual([abbreviation])
	})

	it.each(["New York NY 10118", "Paris", "the street, dc area", "hello, WORLD"])("finds none in %s", (text) => {
		expect(computeQueryShape(text).regionAbbreviations).toEqual([])
	})
})

describe("the empty and degenerate inputs of computeQueryShape", () => {
	it("reports the empty text as an alpha text with nothing in it", () => {
		expect(computeQueryShape("")).toEqual({
			characterClass: "alpha",
			scripts: [],
			tokenClasses: [],
			segments: [],
			regionAbbreviations: [],
			totalLength: 0,
			knownFormats: [],
		})
	})
})

/**
 * One "City, ST ZIP" record.
 *
 * Each repetition grows segments and tokens together.
 * A routine that pairs them is quadratic.
 */
const UNIT = "123 Main St, Springfield, IL 62701, "

const TIMING_SAMPLES = 5

function timeAt(input: string): number {
	const start = performance.now()

	computeQueryShape(input)

	return performance.now() - start
}

/**
 * Samples both sizes interleaved, small and large in turn, and keeps each size's minimum.
 *
 * Contention only adds time to a sample, so the minimum is the run that the
 * rest of the machine disturbed least.
 */
function bestOfBoth(smallReps: number, largeReps: number): { small: number; large: number } {
	const smallInput = UNIT.repeat(smallReps)
	const largeInput = UNIT.repeat(largeReps)

	// Warm first, because a cold JIT on the smaller sample would inflate the ratio.
	computeQueryShape(smallInput)
	computeQueryShape(largeInput)

	let small = Number.POSITIVE_INFINITY
	let large = Number.POSITIVE_INFINITY

	for (let sample = 0; sample < TIMING_SAMPLES; sample++) {
		small = Math.min(small, timeAt(smallInput))
		large = Math.min(large, timeAt(largeInput))
	}

	return { small, large }
}

test("computeQueryShape stays linear as the segment count doubles", () => {
	const { small, large } = bestOfBoth(4000, 8000)
	const ratio = large / Math.max(small, 0.001)

	// Linear is about 2x and quadratic is about 4x, so 3.5 separates the two and tolerates a loaded runner.
	expect(
		ratio,
		`doubling the input multiplied the cost by ${ratio.toFixed(2)}x (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms)`
	).toBeLessThan(3.5)
})
