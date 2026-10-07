/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { POSTCODE_SHAPES, WHOLE_POSTCODE_SHAPES, wholePostcodeShape } from "#postcode/shapes"

/**
 * One spaced postcode per label that states an anchored form, written as a person writes it.
 */
const SPACED: ReadonlyArray<readonly [label: string, postcode: string]> = [
	["GB", "SW1A 1AA"],
	["CA", "M5V 2T6"],
	["IE", "D02 AF30"],
	["NL", "1012 LG"],
]

describe("WHOLE_POSTCODE_SHAPES", () => {
	it("states an anchored form for every label a row gives one", () => {
		expect([...WHOLE_POSTCODE_SHAPES.keys()].toSorted()).toEqual(["CA", "GB", "IE", "NL"])
	})

	it.each(SPACED)("the %s scan and anchored forms both accept %s", (label, postcode) => {
		const scan = POSTCODE_SHAPES.find((shape) => shape.label === label)

		expect(scan).toBeDefined()

		// A `g`-flagged RegExp keeps `lastIndex` across calls, so the scan form is
		// re-compiled here rather than reused between assertions.
		expect(new RegExp(scan!.re.source).test(postcode)).toBe(true)
		expect(wholePostcodeShape(label).test(postcode)).toBe(true)
	})

	it.each(SPACED)("the %s anchored form refuses %s with text around it", (label, postcode) => {
		expect(wholePostcodeShape(label).test(`${postcode} LONDON`)).toBe(false)
		expect(wholePostcodeShape(label).test(`FLAT 2 ${postcode}`)).toBe(false)
	})

	it.each([
		["GB", "sw1a 1aa"],
		["CA", "m5v 2t6"],
		["IE", "d02 af30"],
		["NL", "1012 lg"],
	])("the %s anchored form accepts %s, because a caller already isolated the span", (label, postcode) => {
		expect(wholePostcodeShape(label).test(postcode)).toBe(true)
	})

	it.each([
		["GB", "SW1A1AA"],
		["CA", "M5V2T6"],
		["IE", "D02AF30"],
		["NL", "1012LG"],
	])("the %s anchored form accepts %s, where the scan form requires the space", (label, postcode) => {
		expect(wholePostcodeShape(label).test(postcode)).toBe(true)
	})

	it("carries no g flag, so repeated tests of one pattern agree", () => {
		const gb = wholePostcodeShape("GB")

		expect(gb.global).toBe(false)
		expect(gb.test("SW1A 1AA")).toBe(true)
		expect(gb.test("SW1A 1AA")).toBe(true)
	})

	it("throws on a label no row carries, rather than answering no match", () => {
		expect(() => wholePostcodeShape("DE")).toThrow(/states no anchored pattern for "DE"/)
		expect(() => wholePostcodeShape("ZZ")).toThrow(/states no anchored pattern/)
	})
})
