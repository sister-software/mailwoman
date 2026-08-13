import { describe, expect, it } from "vitest"

import { drawCircle, drawPolyline, fillPolygon, RGBAGrid } from "./raster.ts"

function litPixels(grid: RGBAGrid): Array<[number, number]> {
	const lit: Array<[number, number]> = []

	for (let y = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++) {
			if (grid.data[(y * grid.width + x) * 4 + 3]! > 0) {
				lit.push([x, y])
			}
		}
	}

	return lit
}

describe("drawPolyline", () => {
	it("draws a contiguous diagonal", () => {
		const grid = new RGBAGrid(8, 8)

		drawPolyline(
			grid,
			[
				{ x: 0, y: 0 },
				{ x: 7, y: 7 },
			],
			[255, 255, 255],
			1
		)

		const lit = litPixels(grid)
		expect(lit).toHaveLength(8)
		expect(lit).toContainEqual([0, 0])
		expect(lit).toContainEqual([7, 7])
	})

	it("clips out-of-bounds segments instead of throwing", () => {
		const grid = new RGBAGrid(4, 4)

		drawPolyline(
			grid,
			[
				{ x: -10, y: 2 },
				{ x: 10, y: 2 },
			],
			[255, 0, 0],
			1
		)

		expect(litPixels(grid)).toHaveLength(4)
	})
})

describe("fillPolygon", () => {
	it("fills a rectangle interior", () => {
		const grid = new RGBAGrid(10, 10)

		fillPolygon(
			grid,
			[
				[
					{ x: 2, y: 2 },
					{ x: 7, y: 2 },
					{ x: 7, y: 7 },
					{ x: 2, y: 7 },
				],
			],
			[0, 0, 255]
		)

		const lit = litPixels(grid)
		expect(lit).toContainEqual([4, 4])
		expect(lit).not.toContainEqual([0, 0])
		expect(lit).not.toContainEqual([9, 9])
	})

	it("respects holes (even-odd rule)", () => {
		const grid = new RGBAGrid(12, 12)

		fillPolygon(
			grid,
			[
				[
					{ x: 1, y: 1 },
					{ x: 10, y: 1 },
					{ x: 10, y: 10 },
					{ x: 1, y: 10 },
				],
				[
					{ x: 4, y: 4 },
					{ x: 7, y: 4 },
					{ x: 7, y: 7 },
					{ x: 4, y: 7 },
				],
			],
			[0, 255, 0]
		)

		const lit = litPixels(grid)
		expect(lit).toContainEqual([2, 2])
		expect(lit).not.toContainEqual([5, 5])
	})
})

describe("drawCircle", () => {
	it("draws a ring, not a disc", () => {
		const grid = new RGBAGrid(16, 16)
		drawCircle(grid, 8, 8, 5, [255, 255, 0])
		const lit = litPixels(grid)
		expect(lit.length).toBeGreaterThan(8)
		expect(lit).not.toContainEqual([8, 8])
	})
})
