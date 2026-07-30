/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { latLngToCell } from "h3-js"
import { expect, test } from "vitest"

import { shortCellToInt, shortenH3Cell, type H3Cell } from "./cell.ts"

// A real resolution-9 cell (White House, 38.8977, -77.0365) from h3-js itself, not a synthetic
// hex string — this exercises the actual encoding shortCellToInt is packing.
const CELL = latLngToCell(38.8977, -77.0365, 9) as H3Cell

test("shortCellToInt: packs a real res-9 cell to the 48-bit short-cell integer", () => {
	// Computed here via the existing shortenH3Cell, not a hand-copied literal, so this can't drift
	// from shortenH3Cell's own encoding.
	const expected = Number(BigInt(`0x${shortenH3Cell(CELL)}`))

	expect(shortCellToInt(CELL)).toBe(expected)
	expect(Number.isInteger(shortCellToInt(CELL))).toBe(true)
	expect(Number.isSafeInteger(shortCellToInt(CELL))).toBe(true)
})
