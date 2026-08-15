/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Pinned against the official test vectors
 *   (google/open-location-code/test_data/decoding.csv) plus the board's live Nicaraguan pair.
 */

import { describe, expect, it } from "vitest"

import { decodePlusCode, isFullPlusCode, isShortPlusCode, recoverNearestPlusCode } from "./open-location-code.ts"

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
			const cell = decodePlusCode(code)

			expect(cell, code).not.toBeNull()
			expect(cell!.lat).toBeCloseTo((latLo + latHi) / 2, 9)
			expect(cell!.lon).toBeCloseTo((lonLo + lonHi) / 2, 9)
		}
	})

	it("decodes the El Sauce full code to the board row's gold cell", () => {
		const cell = decodePlusCode("764MVFQ6+92P")!

		// The board's gold (12.8884531, -86.5398875) is Google's snap of the same cell — within ~4 m.
		expect(cell.lat).toBeCloseTo(12.8884531, 4)
		expect(cell.lon).toBeCloseTo(-86.5398875, 3)
	})

	it("rejects short codes, padded forms, and ordinary words", () => {
		expect(decodePlusCode("VFQ6+92P")).toBeNull()
		expect(decodePlusCode("MAIN+ST")).toBeNull()
		expect(decodePlusCode("8FVC0000+")).toBeNull()
	})
})

describe("recoverNearestPlusCode", () => {
	it("recovers the El Sauce short code against the village node", () => {
		// Reference = the resolved El Sauce NI locality (candidate.db row), inside the true cell's degree.
		const cell = recoverNearestPlusCode("VFQ6+92P", 12.88687, -86.53903)!

		expect(cell.lat).toBeCloseTo(12.8884625, 6)
		expect(cell.lon).toBeCloseTo(-86.5399219, 6)
	})

	it("shifts to the nearest bearer across a prefix-cell edge", () => {
		// 2222+22 decodes at the LOW corner of every prefix cell; a reference just BELOW a cell
		// boundary must recover the cell above-left of naive prefixing.
		const cell = recoverNearestPlusCode("2222+22", 46.999, 7.999)!

		expect(cell.lat).toBeCloseTo(47.0000625, 6)
		expect(cell.lon).toBeCloseTo(8.0000625, 6)
	})

	it("returns null for an invalid short shape", () => {
		expect(recoverNearestPlusCode("VFQ+92", 0, 0)).toBeNull()
	})
})

describe("token shape guards", () => {
	it("classifies full vs short", () => {
		expect(isFullPlusCode("764MVFQ6+92P")).toBe(true)
		expect(isFullPlusCode("VFQ6+92P")).toBe(false)
		expect(isShortPlusCode("VFQ6+92P")).toBe(true)
		expect(isShortPlusCode("764MVFQ6+92P")).toBe(false)
	})
})
