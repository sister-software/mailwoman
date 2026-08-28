/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The cell classification: the zero-cell trap the zoning survey measured, the whole/partial split, and
 *   the adaptive resolution that keeps a continental polygon inside h3's allocator.
 */

import {
	classifyFeatureCells,
	estimateCellCount,
	resolutionForFeature,
	CELL_ESTIMATE_BUDGET,
} from "@mailwoman/flood/sdk/cells"
import { FIXTURE_ORIGIN, holeRing, rectangleRing } from "@mailwoman/flood/test-kit"
import { POLYGON_TO_CELLS_FLAGS, polygonToCells, polygonToCellsExperimental } from "h3-js"
import { describe, expect, it } from "vitest"

/**
 * The first feature of the real EA product, verbatim from the published geodatabase: a 128 m² square off Great
 * Yarmouth. Carried here because it is the smallest real thing the source contains, and the trap it demonstrates is not
 * hypothetical.
 */
const TINY_REAL_FEATURE = [
	[
		[
			[1.6981513, 52.64813],
			[1.6981634, 52.6482736],
			[1.6980454, 52.6482772],
			[1.6980333, 52.6481337],
			[1.6981513, 52.64813],
		],
	],
]

describe("classifyFeatureCells", () => {
	it("indexes a polygon smaller than a cell, which a centre-containment polyfill drops entirely", () => {
		for (const resolution of [7, 8, 9, 10]) {
			// The trap, stated as a measurement rather than a worry: h3's default polyfill keeps a cell whose CENTRE is
			// inside, and this real feature contains no cell centre at any of these resolutions.
			expect(polygonToCells(TINY_REAL_FEATURE[0] as number[][][], resolution, true)).toHaveLength(0)

			const cells = classifyFeatureCells(TINY_REAL_FEATURE, resolution, "1")

			expect(cells.whole.length + cells.partial.length).toBeGreaterThan(0)
			expect(cells.whole).toHaveLength(0)
			expect(cells.partial.length).toBeGreaterThan(0)
		}
	})

	it("splits a polygon several cells across into an interior and a fringe", () => {
		const square = [[rectangleRing(1.9, 52.6, 1.92, 52.62)]]
		const cells = classifyFeatureCells(square, 9, "square")

		expect(cells.whole.length).toBeGreaterThan(0)
		expect(cells.partial.length).toBeGreaterThan(0)
		expect(cells.resolution).toBe(9)

		// A cell is one or the other, never both.
		expect(new Set([...cells.whole, ...cells.partial]).size).toBe(cells.whole.length + cells.partial.length)
	})

	it("coarsens a polygon whose bounding box would overrun h3's allocator, and says which resolution it used", () => {
		// A degenerate polygon spanning most of Great Britain — the shape a long meandering river's bounding box takes.
		const wide = [[rectangleRing(-6, 50, 2, 56)]]

		expect(estimateCellCount(wide, 9)).toBeGreaterThan(CELL_ESTIMATE_BUDGET)
		expect(resolutionForFeature(wide, 9)).toBeLessThan(9)

		const cells = classifyFeatureCells(wide, 9, "wide")

		expect(cells.resolution).toBeLessThan(9)
		expect(estimateCellCount(wide, cells.resolution)).toBeLessThanOrEqual(CELL_ESTIMATE_BUDGET)
	})

	it("leaves a small polygon at the target resolution", () => {
		expect(resolutionForFeature(TINY_REAL_FEATURE, 9)).toBe(9)
	})

	it("throws rather than skipping a feature that reaches no cell", () => {
		// A feature whose geometry carries no ring reaches nothing. A build that skipped it would publish an absence it
		// invented, indistinguishable downstream from the designated Zone 1 absence this layer exists to report.
		expect(() => classifyFeatureCells([], 9, "empty")).toThrow(/reaches no cell/u)
	})

	it("still indexes a ring collapsed to a single point, because overlapping containment touches its cell", () => {
		// Recorded rather than assumed: the zero-cell guard above does NOT fire on a degenerate ring, so a source that
		// published one would be indexed to the cell containing it rather than dropped.
		const collapsed = [
			[
				[
					[1.9, 52.6],
					[1.9, 52.6],
					[1.9, 52.6],
					[1.9, 52.6],
				],
			],
		]

		expect(classifyFeatureCells(collapsed, 9, "collapsed").partial).toHaveLength(1)
	})
})

/**
 * The unconditional allocator path: every part through h3, no fast paths at all.
 *
 * The differential below is the two-path discipline applied to this module's own optimization. Two of its shortcuts — a
 * part that fits inside one cell, and a part too narrow to contain one — replace an h3 call with a claim about
 * geometry, and a claim about geometry that is subtly wrong produces a well-formed wrong index rather than an error.
 * Measured over the real product before it landed: 60,000 features at resolution 9, zero disagreements.
 */
function referenceClassification(polygons: number[][][][], resolution: number) {
	const touched = new Set<string>()
	const full = new Set<string>()

	for (const rings of polygons) {
		for (const cell of polygonToCellsExperimental(
			rings,
			resolution,
			POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
			true
		)) {
			touched.add(cell)
		}

		for (const cell of polygonToCellsExperimental(rings, resolution, POLYGON_TO_CELLS_FLAGS.containmentFull, true)) {
			full.add(cell)
		}
	}

	return {
		whole: [...full].toSorted(),
		partial: [...touched].filter((cell) => !full.has(cell)).toSorted(),
	}
}

describe("the allocator-free shortcuts agree with the allocator", () => {
	const { lon, lat } = FIXTURE_ORIGIN

	const cases: Array<[string, number[][][][]]> = [
		["a sub-cell square", [[rectangleRing(lon, lat, lon + 0.0001, lat + 0.0001)]]],
		[
			"a sub-cell square straddling a cell edge",
			[[rectangleRing(lon + 0.00317, lat + 0.00211, lon + 0.0042, lat + 0.0031)]],
		],
		["a square several cells across", [[rectangleRing(lon, lat, lon + 0.02, lat + 0.02)]]],
		[
			"a square with a hole",
			[[rectangleRing(lon, lat, lon + 0.02, lat + 0.02), holeRing(lon + 0.008, lat + 0.008, lon + 0.012, lat + 0.012)]],
		],
		[
			"a multi-part feature mixing both sizes",
			[
				[rectangleRing(lon, lat, lon + 0.0001, lat + 0.0001)],
				[rectangleRing(lon + 0.05, lat + 0.05, lon + 0.07, lat + 0.07)],
			],
		],
		["the real 128 m² first feature", TINY_REAL_FEATURE],
	]

	for (const [label, polygons] of cases) {
		it(`matches the unconditional polyfill on ${label}`, () => {
			for (const resolution of [7, 9, 11]) {
				const fast = classifyFeatureCells(polygons, resolution, label)

				// The comparison is only meaningful where the adaptive path did not coarsen.
				if (fast.resolution !== resolution) continue

				const reference = referenceClassification(polygons, resolution)

				expect([...fast.whole].toSorted()).toEqual(reference.whole)
				expect([...fast.partial].toSorted()).toEqual(reference.partial)
			}
		})
	}
})
