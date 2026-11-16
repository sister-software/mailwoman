// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Pinned against the official test vectors (google/open-location-code/test_data/decoding.csv)
 *   plus the board's live Nicaraguan pair.
 */

import type { Validated } from "@mailwoman/recognize/types"
import { describe, expect, it } from "vitest"

import { decodePlusCode, encodePlusCode, recoverNearestPlusCode } from "#open-location-code"
import { recognizePointQuery } from "#point/reading"

/**
 * The validated code the recognizer reads from a text: the only way a test holds a branded code of its own.
 */
function recognizedCode(text: string): Validated.FullPlusCode | Validated.ShortPlusCode {
	const reading = recognizePointQuery(text)

	if (reading?.kind !== "plus_code") throw new Error(`${text} is not a plus code the recognizer validates`)

	return reading.code
}

function recognizedFull(text: string): Validated.FullPlusCode {
	const reading = recognizePointQuery(text)

	if (reading?.kind !== "plus_code" || !reading.full)
		throw new Error(`${text} is not a full code the recognizer validates`)

	return reading.code
}

function recognizedShort(text: string): Validated.ShortPlusCode {
	const reading = recognizePointQuery(text)

	if (reading?.kind !== "plus_code" || reading.full)
		throw new Error(`${text} is not a short code the recognizer validates`)

	return reading.code
}

describe("encodePlusCode", () => {
	it("matches the official encoding vectors", () => {
		// lat, lon, length, code — rows from encoding.csv.
		const vectors: Array<[number, number, 10 | 11, string]> = [
			[47.36559, 8.524997, 10, "8FVC9G8F+6X"],
			[47.36559, 8.524997, 11, "8FVC9G8F+6XQ"],
		]

		for (const [lat, lon, length, code] of vectors) {
			expect(encodePlusCode(lat, lon, length)).toBe(code)
		}
	})

	it("round-trips through the decoder inside the cell", () => {
		for (const [lat, lon] of [
			[12.8884531, -86.5398875],
			[-41.273, 174.786],
			[38.8977, -77.0365],
		] as const) {
			for (const length of [10, 11] as const) {
				const code = encodePlusCode(lat, lon, length)
				const cell = decodePlusCode(code)

				expect(recognizedCode(code), code).toBe(code)
				// A point on a cell edge, such as 174.786, lands in either neighbor by floating-point rounding.
				expect(Math.abs(cell.lat - lat)).toBeLessThanOrEqual(cell.latSpanDeg / 2 + 1e-9)
				expect(Math.abs(cell.lon - lon)).toBeLessThanOrEqual(cell.lonSpanDeg / 2 + 1e-9)
			}
		}
	})
})

describe("decodePlusCode", () => {
	it("matches the official decoding vectors (cell centers)", () => {
		// code, latLo, lonLo, latHi, lonHi — verbatim rows from decoding.csv.
		const vectors: Array<[string, number, number, number, number]> = [
			["7FG49QCJ+2V", 20.37, 2.782125, 20.370125, 2.78225],
			["7FG49QCJ+2VX", 20.3701, 2.78221875, 20.370125, 2.78225],
			["8FVC2222+22", 47, 8, 47.000125, 8.000125],
			["4VCPPQGP+Q9", -41.273125, 174.785875, -41.273, 174.786],
		]

		for (const [code, latLo, lonLo, latHi, lonHi] of vectors) {
			const cell = decodePlusCode(recognizedFull(code))

			expect(cell.lat, code).toBeCloseTo((latLo + latHi) / 2, 9)
			expect(cell.lon, code).toBeCloseTo((lonLo + lonHi) / 2, 9)
		}
	})

	it("decodes the El Sauce full code to the board row's gold cell", () => {
		const cell = decodePlusCode(recognizedFull("764MVFQ6+92P"))

		// The board's gold (12.8884531, -86.5398875) is Google's snap of the same cell — within ~4 m.
		expect(cell.lat).toBeCloseTo(12.8884531, 4)
		expect(cell.lon).toBeCloseTo(-86.5398875, 3)
	})

	it("takes only the full brand, so a short code fails to compile", () => {
		// @ts-expect-error a short code needs a reference position and has its own brand
		const refused = (): unknown => decodePlusCode(recognizedShort("VFQ6+92P"))

		expect(refused).toBeTypeOf("function")
	})

	it("is never reached by padded forms and ordinary words: the recognizer reads no code from them", () => {
		for (const text of ["MAIN+ST", "8FVC0000+", "VFQ+92P"]) {
			expect(recognizePointQuery(text)?.kind, text).not.toBe("plus_code")
		}
	})
})

describe("recoverNearestPlusCode", () => {
	it("recovers the El Sauce short code against the village node", () => {
		// Reference = the resolved El Sauce NI locality (candidate.db row), inside the true cell's degree.
		const cell = recoverNearestPlusCode(recognizedShort("VFQ6+92P"), 12.88687, -86.53903)

		expect(cell.lat).toBeCloseTo(12.8884625, 6)
		expect(cell.lon).toBeCloseTo(-86.5399219, 6)
	})

	it("shifts to the nearest bearer across a prefix-cell edge", () => {
		// 2222+22 decodes at the low corner of every prefix cell.
		// A reference 0.001 degrees below a cell boundary must recover the cell above-left of naive prefixing.
		const cell = recoverNearestPlusCode(recognizedShort("2222+22"), 46.999, 7.999)

		expect(cell.lat).toBeCloseTo(47.0000625, 6)
		expect(cell.lon).toBeCloseTo(8.0000625, 6)
	})

	it("takes only the short brand, so a full code fails to compile", () => {
		// @ts-expect-error a full code needs no reference and has its own brand
		const refused = (): unknown => recoverNearestPlusCode(recognizedFull("764MVFQ6+92P"), 0, 0)

		expect(refused).toBeTypeOf("function")
	})
})

describe("the recognizer's reading of a token", () => {
	it("classifies full vs short", () => {
		expect(recognizePointQuery("764MVFQ6+92P")).toMatchObject({ kind: "plus_code", full: true })
		expect(recognizePointQuery("VFQ6+92P")).toMatchObject({ kind: "plus_code", full: false })
	})

	it("refuses an odd count of digits before the separator", () => {
		expect(recognizePointQuery("VFQ+92")).toBeNull()
	})
})
