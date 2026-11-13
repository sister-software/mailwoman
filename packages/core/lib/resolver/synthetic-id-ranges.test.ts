// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The synthetic ID registry requires every base to be distinct, ascending
 *   and above any real WOF ID, with room before the next base.
 *
 *   Two builder pairs once shared a base: NZ localities and Code-Point, plus CZ districts and NI OSM.
 *   Each pair kept its own docstring of the ranges it believed taken.
 */

import { describe, expect, test } from "vitest"

import {
	MAILWOMAN_WOF_ID_BASE,
	MAILWOMAN_WOF_ID_END,
	nextMailwomanWOFID,
	SYNTHETIC_ID_RANGE_MIN_WIDTH,
	SYNTHETIC_ID_RANGES,
} from "#resolver/synthetic-id-ranges"

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

	test("the mailwoman WOF range sits above upstream WOF ids and below every synthetic base", () => {
		expect(MAILWOMAN_WOF_ID_BASE).toBeGreaterThan(WOF_ID_CEILING)

		for (const { name, base } of SYNTHETIC_ID_RANGES) {
			expect(MAILWOMAN_WOF_ID_END, name).toBeLessThanOrEqual(base)
		}
	})
})

describe("nextMailwomanWOFID", () => {
	test("starts the range at its base and continues past the largest minted id, ignoring ids outside it", () => {
		expect(nextMailwomanWOFID([])).toBe(MAILWOMAN_WOF_ID_BASE)

		expect(nextMailwomanWOFID([85_806_761, MAILWOMAN_WOF_ID_BASE + 4, MAILWOMAN_WOF_ID_BASE + 1])).toBe(
			MAILWOMAN_WOF_ID_BASE + 5
		)
	})

	test("refuses to mint past the range", () => {
		expect(() => nextMailwomanWOFID([MAILWOMAN_WOF_ID_END - 1])).toThrow("the mailwoman WOF id range ends at")
	})
})
