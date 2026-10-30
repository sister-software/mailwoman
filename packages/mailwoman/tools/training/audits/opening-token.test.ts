/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { openingCounts } from "./opening-token.ts"

describe("openingCounts", () => {
	it("nests the openings of a Czech postcode row: any digits, three digits, NNN NN, and the whole row", () => {
		expect(openingCounts(["100", "00"], ["B-postcode", "I-postcode"])).toEqual([
			"any_digits_postcode",
			"three_digits_postcode",
			"nnn_nn_postcode",
			"nnn_nn_postcode_whole_row",
		])
	})

	it("drops the whole-row opening once the row continues past the NNN NN group", () => {
		expect(openingCounts(["100", "00", "Praha"], ["B-postcode", "I-postcode", "B-locality"])).toEqual([
			"any_digits_postcode",
			"three_digits_postcode",
			"nnn_nn_postcode",
		])
	})

	it("counts a leading house number under the house openings", () => {
		expect(openingCounts(["123", "Main", "St"], ["B-house_number", "B-street", "I-street"])).toEqual([
			"any_digits_house",
			"three_digits_house",
		])

		expect(openingCounts(["42", "Main"], ["B-house_number", "B-street"])).toEqual(["any_digits_house"])
	})

	it("counts nothing for a row that opens on letters, on another label, or with no token", () => {
		expect(openingCounts(["Main", "St"], ["B-street", "I-street"])).toEqual([])
		expect(openingCounts(["100", "00"], ["B-unit", "I-unit"])).toEqual([])
		expect(openingCounts([], [])).toEqual([])
	})

	it("reads a fullwidth number as digits, as Python's str.isdigit does", () => {
		expect(openingCounts(["１２３"], ["B-house_number"])).toEqual(["any_digits_house", "three_digits_house"])
	})
})
