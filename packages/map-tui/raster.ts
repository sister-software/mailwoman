/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * RGBA pixel rasterizer for map-tui's debug view.
 *
 * Rasterizes vector geometry (polylines, filled polygons, circles) onto a plain RGBA byte grid — the shape asciify's
 * rasterize step consumes. Every draw call clips through {@link RGBAGrid.setPixel}, so callers never need to
 * bounds-check geometry themselves. The polyline and circle primitives floor their coordinates to integers on entry;
 * {@link fillPolygon} does not — its scanline edge math keeps ring vertices as given, see its own docstring.
 */

import type { RGB } from "#style"

/**
 * A row-major RGBA pixel buffer. Alpha starts at 0 (unlit/transparent) everywhere; drawing a pixel sets it to 255,
 * which is how callers (including this module's own tests) distinguish "lit" from "background".
 */
export class RGBAGrid {
	readonly width: number
	readonly height: number
	/**
	 * RGBA, row-major, width * height * 4 bytes — the shape asciify's rasterize consumes.
	 */
	readonly data: Uint8ClampedArray

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
		this.data = new Uint8ClampedArray(width * height * 4)
	}

	/**
	 * Writes a pixel's RGB channels and sets alpha to fully opaque (255). Coordinates outside the grid are silently
	 * ignored — this is the one clipping boundary every drawing primitive in this module routes through, so geometry that
	 * runs off the grid (or arrives with negative/oversized coordinates) never needs special-casing upstream.
	 */
	setPixel(x: number, y: number, color: RGB): void {
		const px = Math.floor(x)
		const py = Math.floor(y)

		if (px < 0 || px >= this.width || py < 0 || py >= this.height) return

		const offset = (py * this.width + px) * 4

		this.data[offset] = color[0]
		this.data[offset + 1] = color[1]
		this.data[offset + 2] = color[2]
		this.data[offset + 3] = 255
	}
}

/**
 * Stamps a `width`-sized square centered on (x, y) — used by {@link drawPolyline} for `width > 1`. `width === 1` callers
 * should use `grid.setPixel` directly rather than pay the square-stamp loop.
 */
function stampSquare(grid: RGBAGrid, x: number, y: number, color: RGB, width: number): void {
	const half = Math.floor(width / 2)

	for (let dy = 0; dy < width; dy++) {
		for (let dx = 0; dx < width; dx++) {
			grid.setPixel(x - half + dx, y - half + dy, color)
		}
	}
}

/**
 * Draws a single line segment with the integer Bresenham algorithm. Coordinates are floored on entry; every plotted
 * point routes through `grid.setPixel`, so segments that run partly or fully off-grid clip for free.
 */
function drawSegment(grid: RGBAGrid, x0: number, y0: number, x1: number, y1: number, color: RGB, width: number): void {
	let x = Math.floor(x0)
	let y = Math.floor(y0)
	const endX = Math.floor(x1)
	const endY = Math.floor(y1)

	const dx = Math.abs(endX - x)
	const dy = -Math.abs(endY - y)
	const stepX = x < endX ? 1 : -1
	const stepY = y < endY ? 1 : -1
	let error = dx + dy

	for (;;) {
		if (width > 1) {
			stampSquare(grid, x, y, color, width)
		} else {
			grid.setPixel(x, y, color)
		}

		if (x === endX && y === endY) break

		const doubleError = 2 * error

		if (doubleError >= dy) {
			error += dy
			x += stepX
		}

		if (doubleError <= dx) {
			error += dx
			y += stepY
		}
	}
}

/**
 * Draws a connected polyline through `points`, one Bresenham segment per consecutive pair. `width > 1` stamps a
 * `width`-sized square at every plotted step instead of a single pixel, thickening the line. Segments that run outside
 * the grid clip through `setPixel` rather than throwing.
 */
export function drawPolyline(
	grid: RGBAGrid,
	points: ReadonlyArray<{ x: number; y: number }>,
	color: RGB,
	width: number
): void {
	for (let index = 0; index < points.length - 1; index++) {
		const a = points[index]!
		const b = points[index + 1]!

		drawSegment(grid, a.x, a.y, b.x, b.y, color, width)
	}
}

/**
 * Fills one or more polygon rings with the even-odd rule: a pixel is interior when a ray from it crosses an odd number
 * of ring edges. Rings after the first behave as holes wherever they overlap the first ring, and holes nested inside
 * holes fill again, purely as a consequence of the parity count — no explicit hole/outer distinction is tracked.
 * Scanlines sample row centers (`y + 0.5`) rather than integer row coordinates, which is what keeps horizontal edges
 * and grid-aligned polygon boundaries from producing degenerate (zero-width or doubled) intersections. Coordinates are
 * floored to the grid via `setPixel`; edge math itself uses the ring vertices as given.
 */
export function fillPolygon(
	grid: RGBAGrid,
	rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
	color: RGB
): void {
	for (let y = 0; y < grid.height; y++) {
		const scanY = y + 0.5
		const intersections: number[] = []

		for (const ring of rings) {
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i]!
				const b = ring[(i + 1) % ring.length]!

				// Skip horizontal edges — they contribute no crossing at any non-integer scanY.
				if (a.y === b.y) continue

				const yMin = Math.min(a.y, b.y)
				const yMax = Math.max(a.y, b.y)

				if (scanY < yMin || scanY >= yMax) continue

				const t = (scanY - a.y) / (b.y - a.y)
				intersections.push(a.x + t * (b.x - a.x))
			}
		}

		intersections.sort((left, right) => left - right)

		for (let i = 0; i + 1 < intersections.length; i += 2) {
			const startX = Math.ceil(intersections[i]! - 0.5)
			const endX = Math.ceil(intersections[i + 1]! - 0.5)

			for (let x = startX; x < endX; x++) {
				grid.setPixel(x, y, color)
			}
		}
	}
}

/**
 * Draws a circle's outline (ring, not a filled disc) with the midpoint circle algorithm, plotting all eight symmetric
 * octant points per step. `centerX`/`centerY`/`radius` are floored on entry; every plotted point routes through
 * `setPixel`, so a circle that runs off the grid clips rather than throwing.
 */
export function drawCircle(grid: RGBAGrid, centerX: number, centerY: number, radius: number, color: RGB): void {
	const cx = Math.floor(centerX)
	const cy = Math.floor(centerY)
	const r = Math.floor(radius)

	let x = r
	let y = 0
	let error = 1 - r

	const plotOctants = (px: number, py: number): void => {
		grid.setPixel(cx + px, cy + py, color)
		grid.setPixel(cx - px, cy + py, color)
		grid.setPixel(cx + px, cy - py, color)
		grid.setPixel(cx - px, cy - py, color)
		grid.setPixel(cx + py, cy + px, color)
		grid.setPixel(cx - py, cy + px, color)
		grid.setPixel(cx + py, cy - px, color)
		grid.setPixel(cx - py, cy - px, color)
	}

	while (x >= y) {
		plotOctants(x, y)

		y++

		if (error < 0) {
			error += 2 * y + 1
		} else {
			x--
			error += 2 * (y - x) + 1
		}
	}
}
