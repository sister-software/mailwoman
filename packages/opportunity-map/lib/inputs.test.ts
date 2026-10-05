/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { checkLineCoordinates, MapInputError } from "#inputs"

describe("MapInputError", () => {
	test("names the input it refuses", () => {
		const error = new MapInputError("paths[ghost]", "the scenario defines no segment ghost")

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe("MapInputError")
		expect(error.path).toBe("paths[ghost]")
		expect(error.message).toBe("paths[ghost]: the scenario defines no segment ghost")
	})
})

describe("checkLineCoordinates", () => {
	test("accepts two or more positions inside the range of longitude and latitude", () => {
		expect(() =>
			checkLineCoordinates(
				[
					[-180, -90],
					[180, 90],
				],
				"line"
			)
		).not.toThrow()
	})

	test("refuses a line with fewer than two positions", () => {
		expect(() => checkLineCoordinates([[0, 0]], "line")).toThrow(
			"line.coordinates: a line needs at least two positions"
		)
	})

	test("refuses a position outside the range, including one that is not a number", () => {
		for (const position of [
			[180.5, 0],
			[0, -90.5],
			[Number.NaN, 0],
		] as const) {
			expect(() => checkLineCoordinates([[0, 0], [...position]], "line")).toThrow(/line\.coordinates\[1\]: .* outside/)
		}
	})
})
