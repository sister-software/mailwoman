/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The strip stays conservative: a parenthesis mid-name and a parenthetical-only surface come back
 *   unchanged, so it remains a fallback after an exact compare rather than a normalizer.
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
