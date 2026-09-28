/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The predicate is exported rather than exercised through the fold, which streams the Overture divisions theme remotely with no local fixture.
 */

import { isDivisionName } from "mailwoman/gazetteer-pipeline/admin/fold/overture"
import { describe, expect, it } from "vitest"

/**
 * The rule this predicate replaced, kept as the comparison arm.
 */
const isLatin = (s: string): boolean => /^[\p{Script=Latin}\p{N}\p{P}\s]+$/u.test(s)

describe("admitting an Overture division name", () => {
	it("admits a name in the script its country writes", () => {
		// Singapore, Sri Lanka and Malaysia: their Overture primary is already Latin,
		// so `common` is the only place their own script appears.
		expect(isDivisionName("新加坡")).toBe(true)
		expect(isDivisionName("சிங்கப்பூர்")).toBe(true)
		expect(isDivisionName("ශ්‍රී ලංකාව")).toBe(true)
		expect(isDivisionName("كوالا لومڤور")).toBe(true)
	})

	it("still admits the Latin names it always did", () => {
		for (const name of ["Singapore", "Moscow", "Moskva", "Kuala Lumpur", "Bandaranayake"]) {
			expect(isDivisionName(name)).toBe(true)
		}
	})

	it("refuses the packing noise the old rule's character class refused", () => {
		for (const noise of ["(( Karis Landskommun ))", "Noise Town [old]", "a|b", "name/other", "x_y"]) {
			expect(isDivisionName(noise)).toBe(false)
		}
	})

	it("refuses a value carrying no letter, so a bare code is not a name", () => {
		expect(isDivisionName("35001")).toBe(false)
		expect(isDivisionName("   ")).toBe(false)
	})

	it("differs from the old rule exactly where the old rule tested script", () => {
		expect(isLatin("Vulapük")).toBe(true)
		expect(isLatin("新加坡")).toBe(false)

		expect(isDivisionName("Vulapük")).toBe(true)
		expect(isDivisionName("新加坡")).toBe(true)
	})

	it("agrees with the old rule on a plain Latin name", () => {
		for (const value of ["Singapore", "Moscow", "Kuala Lumpur"]) {
			expect(isDivisionName(value)).toBe(true)
			expect(isLatin(value)).toBe(true)
		}
	})

	it("refuses noise the old rule admitted, which is the half its docstring claimed", () => {
		for (const value of ["(( Karis Landskommun ))", "Noise Town [old]", "name/other", "x_y"]) {
			expect(isLatin(value)).toBe(true)
			expect(isDivisionName(value)).toBe(false)
		}

		expect(isLatin("35001")).toBe(true)
		expect(isDivisionName("35001")).toBe(false)
	})
})
