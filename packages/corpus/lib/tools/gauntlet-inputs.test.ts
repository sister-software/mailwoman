/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The board-input register a recipe consults, and the rows it has to contain.
 *
 *   Two independent held-out registers exist and neither knew the other did: a recipe's own reserve list, and the
 *   gauntlet boards. `100 00` and `110 00` reached the v0.30.0 parquet through the gap, after which those two board
 *   rows measured recall of two strings rather than the capability they were written for.
 */

import { normalizeGauntletSurface, readGauntletInputs } from "@mailwoman/corpus/tools/gauntlet-inputs"
import { beforeAll, describe, expect, it } from "vitest"

let inputs: ReadonlySet<string>

beforeAll(async () => {
	inputs = await readGauntletInputs()
})

describe("normalizeGauntletSurface", () => {
	it("folds the spacing a postcode differs by between board and corpus", () => {
		// The board spells it `100 00` and the recipe holds `10000`. A check that missed this pair would report a
		// clean build over the leak it exists to catch.
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
		// The two that reached the parquet.
		expect(inputs.has("10000")).toBe(true)
		expect(inputs.has("11000")).toBe(true)
	})

	it("contains the bare-postcode board rows that had not leaked", () => {
		// These are the rows a future build must keep out, and they are in the same files as the two above.
		for (const surface of ["SW1A 1AA", "N7 0BT", "1012 LG", "811 01", "90210", "75008"]) {
			expect(inputs.has(normalizeGauntletSurface(surface)), surface).toBe(true)
		}
	})

	it("reaches a board row outside the two-letter country directories", () => {
		// `generalization/` holds parked passes. The gauntlet loader skips it. this register must not, because a
		// parked row is still an input a recipe would be training on.
		expect(inputs.has(normalizeGauntletSurface("Praha 100 00, Czechia"))).toBe(true)
	})

	it("answers an empty set for a directory holding no boards", async () => {
		// Absence is a real answer, and a caller treating it as "nothing is reserved" is reading the truth about an
		// empty directory rather than a failed read — `readGauntletInputs` skips what it cannot parse.
		const empty = await readGauntletInputs("packages/corpus/lib/tools")

		expect(empty.size).toBe(0)
	})
})
