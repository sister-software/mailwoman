/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The board-input register a recipe consults, and the rows it has to contain.
 */

import { normalizeGauntletSurface, readGauntletInputs } from "@mailwoman/corpus/tools/gauntlet-inputs"
import { beforeAll, describe, expect, it } from "vitest"

let inputs: ReadonlySet<string>

beforeAll(async () => {
	inputs = await readGauntletInputs()
})

describe("normalizeGauntletSurface", () => {
	it("folds the spacing a postcode differs by between board and corpus", () => {
		// A check that missed this pair would report a clean build over the leak it exists to catch.
		expect(normalizeGauntletSurface("100 00")).toBe(normalizeGauntletSurface("10000"))
		expect(normalizeGauntletSurface("SW1A 1AA")).toBe("SW1A1AA")
		expect(normalizeGauntletSurface("  1012 lg ")).toBe("1012LG")
	})
})

describe("readGauntletInputs", () => {
	it("reads the whole board corpus, not one country", () => {
		expect(inputs.size).toBeGreaterThan(1000)
	})

	it("contains the rows the leak was measured on", () => {
		expect(inputs.has("10000")).toBe(true)
		expect(inputs.has("11000")).toBe(true)
	})

	it("contains the bare-postcode board rows that had not leaked", () => {
		// These are the rows a future build must keep out.
		for (const surface of ["SW1A 1AA", "N7 0BT", "1012 LG", "811 01", "90210", "75008"]) {
			expect(inputs.has(normalizeGauntletSurface(surface)), surface).toBe(true)
		}
	})

	it("reaches a board row outside the two-letter country directories", () => {
		// `generalization/` holds parked passes the gauntlet loader skips, which this register must not.
		expect(inputs.has(normalizeGauntletSurface("Praha 100 00, Czechia"))).toBe(true)
	})

	it("answers an empty set for a directory holding no boards", async () => {
		// Absence is a real answer, not a failed read, because `readGauntletInputs` skips what it cannot parse.
		const empty = await readGauntletInputs("packages/corpus/lib/tools")

		expect(empty.size).toBe(0)
	})
})
