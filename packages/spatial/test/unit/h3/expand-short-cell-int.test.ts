/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expandShortCellInt, type H3Cell, shortCellToInt } from "@mailwoman/spatial/h3/cell"
import { latLngToCell } from "h3-js"
import { describe, expect, it } from "vitest"

describe("expandShortCellInt", () => {
	it("inverts shortCellToInt at the stored resolution", () => {
		const cell = latLngToCell(51.5074, -0.1278, 9) as H3Cell

		expect(expandShortCellInt(shortCellToInt(cell), 9)).toBe(cell)
	})

	it("refuses an integer that names no cell at the stated resolution", () => {
		expect(() => expandShortCellInt(1, 9)).toThrow(/does not name a valid cell at resolution 9/)
	})
})
