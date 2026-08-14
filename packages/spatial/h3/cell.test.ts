/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { getBaseCellNumber, latLngToCell } from "h3-js"
import { expect, test } from "vitest"

import { expandH3Cell, isH3Cell, shortCellToInt, shortenH3Cell, type H3Cell, type H3CellShort } from "./cell.ts"

// A real resolution-9 cell (White House, 38.8977, -77.0365) from h3-js itself, not a synthetic
// hex string — this exercises the actual encoding shortCellToInt is packing.
const CELL = latLngToCell(38.8977, -77.0365, 9) as H3Cell

// Every resolution H3 defines, so the round-trip is asserted across the whole range rather than at
// the resolutions this repo happens to use today.
const RESOLUTIONS = Array.from({ length: 16 }, (_, resolution) => resolution)

test("shortCellToInt: packs a real res-9 cell to the 48-bit short-cell integer", () => {
	// Computed here via the existing shortenH3Cell, not a hand-copied literal, so this can't drift
	// from shortenH3Cell's own encoding.
	const expected = Number(BigInt(`0x${shortenH3Cell(CELL)}`))

	expect(shortCellToInt(CELL)).toBe(expected)
	expect(Number.isInteger(shortCellToInt(CELL))).toBe(true)
	expect(Number.isSafeInteger(shortCellToInt(CELL))).toBe(true)
})

test.for(RESOLUTIONS)("expandH3Cell: round-trips a cell captured at resolution %i", (resolution) => {
	const cell = latLngToCell(38.8977, -77.0365, resolution) as H3Cell

	expect(expandH3Cell(shortenH3Cell(cell), resolution)).toBe(cell)
})

// Base cells 0-7 leave the top nibble of the short form zero, so the hex string only survives the
// round-trip if both halves agree on a fixed 13-character width.
test("expandH3Cell: round-trips a cell whose base cell zeroes the leading nibble", () => {
	const cell = latLngToCell(64.3025, 135.29175, 15) as H3Cell

	expect(getBaseCellNumber(cell)).toBeLessThan(8)
	expect(shortenH3Cell(cell)).toHaveLength(13)
	expect(expandH3Cell(shortenH3Cell(cell), 15)).toBe(cell)
})

// A short cell derived from an integer key has lost its leading zeros; expansion has to restore them
// rather than shift the digit path.
test("expandH3Cell: accepts an unpadded short cell recovered from its integer form", () => {
	const cell = latLngToCell(64.3025, 135.29175, 15) as H3Cell
	const unpadded = shortCellToInt(cell).toString(16) as H3CellShort

	expect(unpadded).toHaveLength(12)
	expect(expandH3Cell(unpadded, 15)).toBe(cell)
})

test("expandH3Cell: rejects a resolution the short cell was not captured at", () => {
	const short = shortenH3Cell(latLngToCell(38.8977, -77.0365, 15) as H3Cell)

	expect(() => expandH3Cell(short, 9)).toThrow(/does not name a valid cell at resolution 9/)
})

test("expandH3Cell: rejects a resolution outside the range H3 defines", () => {
	const short = shortenH3Cell(CELL)

	expect(() => expandH3Cell(short, 16)).toThrow(RangeError)
	expect(() => expandH3Cell(short, -1)).toThrow(RangeError)
	expect(() => expandH3Cell(short, 9.5)).toThrow(RangeError)
})

test("expandH3Cell: rejects a short cell wider than the encoding holds", () => {
	expect(() => expandH3Cell("2aa845a18a50bff" as H3CellShort, 15)).toThrow(RangeError)
})

test("isH3Cell rejects well-shaped strings that are not cells", () => {
	// Fifteen lowercase hex characters each, so a shape check passes all four. Only the third is a
	// real cell — the guard has to know the difference, because its return type claims it does.
	expect(isH3Cell("000000000000000")).toBe(false)
	expect(isH3Cell("fffffffffffffff")).toBe(false)
	expect(isH3Cell("123456789abcdef")).toBe(false)
	expect(isH3Cell("8f0494516235000")).toBe(true)
})
