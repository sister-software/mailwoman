/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { countOption } from "mailwoman/cli-kit"
import { describe, expect, it } from "vitest"

describe("countOption", () => {
	it("reads ZERO as zero, which `Number(raw) || fallback` cannot", () => {
		// The whole reason this helper exists. `corpus slice --variants 0` asks a recipe to emit its self-contained
		// rows and none of its tuple-driven ones; the falsy-zero idiom answered the fallback and the po-box military
		// slice came out at 10,558 rows against the 5,279 requested, every one of them a row nobody asked for.
		expect(countOption("0", 1)).toBe(0)
		expect(countOption("3", 1)).toBe(3)
	})

	it("falls back only when the flag is absent", () => {
		expect(countOption(undefined, 1)).toBe(1)
		expect(countOption(undefined, 24)).toBe(24)
	})

	it("REFUSES a value that is not a non-negative integer rather than falling back", () => {
		// A typo that falls back is a slice size nobody chose, which is the same defect one step further away.
		for (const bad of ["", "  ", "two", "1.5", "-1", "NaN", "1e3x"]) {
			expect(() => countOption(bad, 1), bad).toThrow(/non-negative integer/u)
		}
	})
})
