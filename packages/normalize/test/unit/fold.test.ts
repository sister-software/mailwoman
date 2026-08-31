/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { foldCaseWhitespace, stripCombiningMarks } from "@mailwoman/normalize/fold"
import { describe, expect, it } from "vitest"

describe("foldCaseWhitespace", () => {
	it("lower-cases, collapses whitespace runs and trims", () => {
		expect(foldCaseWhitespace("  Saint-Étienne \t  CEDEX\n")).toBe("saint-étienne cedex")
	})
})

describe("stripCombiningMarks", () => {
	it("removes marks and keeps case, whitespace and non-decomposable letters", () => {
		expect(stripCombiningMarks("Saint-Étienne  Łódź")).toBe("Saint-Etienne  Łodz")
	})
})
