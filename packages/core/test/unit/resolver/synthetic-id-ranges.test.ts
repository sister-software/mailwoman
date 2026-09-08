/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The synthetic id registry's one job: every base distinct, ascending, above any real WOF id, and with room before
 *   the next. Two builders once shared a base each (NZ localities / Code-Point, CZ districts / NI OSM) while each kept
 *   its own docstring of the ranges it believed taken.
 */

import { SYNTHETIC_ID_RANGE_MIN_WIDTH, SYNTHETIC_ID_RANGES } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { describe, expect, test } from "vitest"

/**
 * WOF ids are below this; every synthetic base sits above.
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
