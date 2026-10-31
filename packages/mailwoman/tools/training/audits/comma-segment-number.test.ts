/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { commaSegmentCounts, isolatedPositions } from "./comma/segment/number.ts"

const row = (tokens: string[], labels: string[]) => ({ tokens, labels })

describe("isolatedPositions", () => {
	test("a number alone between commas is isolated", () => {
		expect(isolatedPositions(["301", "College", "Ave,", "101,", "Athens,", "GA", "30601"])).toEqual([3])
	})

	test("a number opening the row is isolated only when its segment ends there", () => {
		expect(isolatedPositions(["15,", "07691", "Portopetro,", "Spain"])).toEqual([0])
		expect(isolatedPositions(["301", "College", "Ave,", "Athens"])).toEqual([])
	})

	test("a number closing the row needs no trailing comma", () => {
		expect(isolatedPositions(["Athens,", "GA,", "30601"])).toEqual([2])
	})

	test("a superscript digit is no decimal digit, and a fullwidth one is", () => {
		expect(isolatedPositions(["²,", "Main"])).toEqual([])
		expect(isolatedPositions(["１５,", "Main"])).toEqual([0])
	})
})

test("leading and later positions are counted apart", () => {
	const rows = [
		row(["15,", "07691", "Portopetro,", "Spain"], ["B-house_number", "B-postcode", "B-locality", "B-country"]),
		row(
			["301", "College", "Ave,", "101,", "Athens,", "GA", "30601"],
			["B-house_number", "B-street", "I-street", "B-unit", "B-locality", "B-region", "B-postcode"]
		),
		row(["Athens,", "GA,", "30601"], ["B-locality", "B-region", "B-postcode"]),
	]

	expect(commaSegmentCounts(rows)).toEqual({ leading: { house_number: 1 }, later: { unit: 1, postcode: 1 } })
})
