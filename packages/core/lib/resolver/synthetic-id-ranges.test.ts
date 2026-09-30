/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic ID registry requires every base to be distinct, ascending and above any real WOF ID, with room before
 *   the next base. Two builder pairs once shared a base: NZ localities and Code-Point, plus CZ districts and NI OSM. Each pair kept
 *   its own docstring of the ranges it believed taken.
 */

import { describe, expect, test } from "vitest"

import { SYNTHETIC_ID_RANGE_MIN_WIDTH, SYNTHETIC_ID_RANGES } from "#resolver/synthetic-id-ranges"

/**
 * WOF ids are below this.
 * Every synthetic base sits above.
 */
const WOF_ID_CEILING = 2_000_000_000

describe("SYNTHETIC_ID_RANGES", () => {
	test("every base is distinct", () => {
		const bases = SYNTHETIC_ID_RANGES.map((r) => r.base)

		expect(new Set(bases).size).toBe(bases.length)
	})

	test("the table is ascending, and each range has at least the minimum width before the next base", () => {
		for (let i = 1; i < SYNTHETIC_ID_RANGES.length; i++) {
			const previous = SYNTHETIC_ID_RANGES[i - 1]!
			const current = SYNTHETIC_ID_RANGES[i]!

			expect(current.base - previous.base, `${previous.name} → ${current.name}`).toBeGreaterThanOrEqual(
				SYNTHETIC_ID_RANGE_MIN_WIDTH
			)
		}
	})

	test("every base is above any real WOF id and safe as a JavaScript integer", () => {
		for (const { name, base } of SYNTHETIC_ID_RANGES) {
			expect(base, name).toBeGreaterThan(WOF_ID_CEILING)
			expect(Number.isSafeInteger(base + SYNTHETIC_ID_RANGE_MIN_WIDTH), name).toBe(true)
		}
	})
})
