/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { frameToANSILines, overlayText, rasterizeToFrame, rgbToPacked } from "./frame.ts"
import { RGBAGrid } from "./raster.ts"

const BRAILLE_FULL = 0x28_ff

// all 8 dots

describe("rasterizeToFrame", () => {
	it("turns a fully lit grid into full braille cells", () => {
		const grid = new RGBAGrid(4, 8)

		// 2 columns × 2 rows of cells
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 4; x++) {
				grid.setPixel(x, y, [255, 255, 255])
			}
		}

		const frame = rasterizeToFrame(grid, 2, 2, "test")
		expect(Array.from(frame.chars)).toEqual([BRAILLE_FULL, BRAILLE_FULL, BRAILLE_FULL, BRAILLE_FULL])
	})

	it("leaves a dark grid blank", () => {
		const frame = rasterizeToFrame(new RGBAGrid(4, 8), 2, 2, "")
		expect(frame.chars[0]).toBe(0x28_00)
		expect(frame.colors[0]).toBe(0)
	})
})

describe("frameToANSILines", () => {
	it("emits one line per row and resets styling", () => {
		const grid = new RGBAGrid(4, 8)
		grid.setPixel(0, 0, [255, 0, 0])
		const frame = rasterizeToFrame(grid, 2, 2, "")
		const lines = frameToANSILines(frame)
		expect(lines).toHaveLength(2)
		expect(lines[0]).toContain("\u001B[38;2;")
		expect(lines[0]!.endsWith("\u001B[0m")).toBe(true)
	})

	it("strips styling when color is off", () => {
		const grid = new RGBAGrid(4, 8)
		grid.setPixel(0, 0, [255, 0, 0])
		const frame = rasterizeToFrame(grid, 2, 2, "")
		expect(frameToANSILines(frame, { color: false })[0]).not.toContain("\u001B[")
	})
})

describe("overlayText", () => {
	it("writes text cells and reports collision through the bitmap", () => {
		const frame = rasterizeToFrame(new RGBAGrid(20, 4), 10, 1, "")
		const occupied = new Uint8Array(10)
		expect(overlayText(frame, 1, 0, "Portland", 0xff_ff_ff, occupied)).toBe(true)
		expect(String.fromCodePoint(frame.chars[1]!)).toBe("P")
		expect(overlayText(frame, 3, 0, "X", 0xff_ff_ff, occupied)).toBe(false)
	})

	it("does not collide across rows — the bitmap is row-aware", () => {
		const frame = rasterizeToFrame(new RGBAGrid(20, 8), 10, 2, "")
		const occupied = new Uint8Array(20)
		expect(overlayText(frame, 1, 0, "Portland", 0xff_ff_ff, occupied)).toBe(true)
		// Same columns as "Portland" above, but on the next row — must NOT collide.
		expect(overlayText(frame, 3, 1, "X", 0xff_ff_ff, occupied)).toBe(true)
		expect(String.fromCodePoint(frame.chars[1 * 10 + 3]!)).toBe("X")
	})
})

describe("rgbToPacked", () => {
	it("packs RGB channels into 0xRRGGBB", () => {
		expect(rgbToPacked([255, 128, 0])).toBe(0xff_80_00)
	})
})
