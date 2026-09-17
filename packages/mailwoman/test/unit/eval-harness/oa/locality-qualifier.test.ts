/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The OpenAddresses parenthetical strip, pinned at its edges (#2308).
 *
 *   The cases worth holding are the ones where the strip leaves a name alone: a parenthesis mid-name, and a surface
 *   that is nothing but a parenthetical. Both come back unchanged, which is what keeps the function a fallback the
 *   grader reaches for after an exact compare rather than a normalization that rewrites every expectation.
 */

import { hasParentheticalQualifier, stripParentheticalQualifier } from "mailwoman/eval-harness/oa/locality-qualifier"
import { describe, expect, it } from "vitest"

describe("stripParentheticalQualifier", () => {
	it("removes the source's delivery marker, in either casing", () => {
		expect(stripParentheticalQualifier("Manilla (Rural)")).toBe("Manilla")
		expect(stripParentheticalQualifier("Denison (rural)")).toBe("Denison")
	})

	it("removes a qualifier with no space before it", () => {
		expect(stripParentheticalQualifier("Denison(rural)")).toBe("Denison")
	})

	it("leaves a name that carries none", () => {
		expect(stripParentheticalQualifier("Orland Park")).toBe("Orland Park")
		expect(stripParentheticalQualifier("Butte-Silver Bow")).toBe("Butte-Silver Bow")
	})

	it("leaves a parenthesis that is not a suffix", () => {
		expect(stripParentheticalQualifier("St. Mary (Bay) Township")).toBe("St. Mary (Bay) Township")
	})

	it("hands back a surface that is nothing but a parenthetical rather than emptying it", () => {
		expect(stripParentheticalQualifier("(Rural)")).toBe("(Rural)")
	})

	it("strips only the last of two", () => {
		expect(stripParentheticalQualifier("Springfield (Town) (Rural)")).toBe("Springfield (Town)")
	})
})

describe("hasParentheticalQualifier", () => {
	it("agrees with the strip on every shape", () => {
		for (const name of ["Manilla (Rural)", "Denison(rural)", "Springfield (Town) (Rural)"]) {
			expect(hasParentheticalQualifier(name)).toBe(true)
		}

		for (const name of ["Orland Park", "(Rural)", "St. Mary (Bay) Township"]) {
			expect(hasParentheticalQualifier(name)).toBe(false)
		}
	})
})
