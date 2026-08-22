/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The CA urban/rural split, which the code carries in its second character.
 *
 *   Canada Post puts a `0` in the second position of a RURAL forward sortation area. The two populations measure a
 *   granularity apart — urban 78 m p50, rural 2.08 km — so admitting CA wholesale would have claimed a tier for half
 *   the country that only the other half earns. These cases pin the boundary at the one character that decides it.
 */

import { isUnitGradePostcodeHit, UNIT_GRADE_POSTCODE } from "@mailwoman/codex/postcode-systems"
import { describe, expect, it } from "vitest"

const shapeAccepts = (code: string): boolean => UNIT_GRADE_POSTCODE.some((re) => re.test(code))

describe("CA urban LDU", () => {
	it("accepts an urban code in both spacings", () => {
		for (const code of ["M1J 1A8", "M1J1A8", "m1j 1a8", "V6B 1A1", "H3Z 2Y7", "T2P 5H1"]) {
			expect(shapeAccepts(code)).toBe(true)
		}
	})

	it("REFUSES a rural code — the `0` in the second position", () => {
		// T0H 1M0 is the worked case: 0.29 km from its locality centroid, 43.18 km from its own postal code.
		for (const code of ["T0H 1M0", "T0H1M0", "B0P 1E0", "G0X 2S8", "R0J 1W0"]) {
			expect(shapeAccepts(code)).toBe(false)
		}
	})

	it("refuses an FSA alone — there is no unit to be exact about", () => {
		for (const code of ["M1J", "M1J 1", "M1J 1A"]) {
			expect(shapeAccepts(code)).toBe(false)
		}
	})

	it("promotes only on an EXACT hit, never on a coarsened one", () => {
		expect(isUnitGradePostcodeHit("M1J 1A8", "m1j1a8")).toBe(true)
		expect(isUnitGradePostcodeHit("M1J 1A8", "M1J1A8")).toBe(true)
		// The resolver answered with the FSA. Area-class, and promoting it is the trade the epoch convention forbids.
		expect(isUnitGradePostcodeHit("M1J 1A8", "m1j")).toBe(false)
		expect(isUnitGradePostcodeHit("M1J 1A8", undefined)).toBe(false)
	})

	it("does not collide with the systems already in the tier", () => {
		// A GB unit and an NL PC6 keep matching; a US ZIP, a DE PLZ and a JP code stay out.
		expect(shapeAccepts("N7 0BT")).toBe(true)
		expect(shapeAccepts("1012 LG")).toBe(true)

		for (const code of ["62701", "12623", "100-0001", "2000"]) {
			expect(shapeAccepts(code)).toBe(false)
		}
	})
})
