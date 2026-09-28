/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures the index and the feature count used to select its resolution.
 *   It checks how many features a polyfill-only index would drop.
 *   `classifyFeatureCells` cannot report that count because it refuses features that reach no cell.
 */

import { classifyFeatureCells, featureCellRows } from "@mailwoman/spatial"
import { polyfillFindsNothing, ZoningCellIndex } from "@mailwoman/zoning/sdk/cells"
import { exteriorRing } from "@mailwoman/zoning/test-kit"
import { describe, expect, it } from "vitest"

const ORIGIN = { lon: -6.5, lat: 53.4 } as const

/**
 * A square about 1.1 km on a side, several res-10 cells across.
 */
const BIG = [[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + 0.01, ORIGIN.lat + 0.01)]]

/**
 * A square about 5.5 m on a side — smaller than a res-11 cell, let alone a res-9 one.
 */
const SLIVER = [[exteriorRing(ORIGIN.lon, ORIGIN.lat, ORIGIN.lon + 0.00005, ORIGIN.lat + 0.00005)]]

describe("polyfillFindsNothing", () => {
	it("is TRUE for a polygon smaller than a cell, which is this layer's population", () => {
		expect(polyfillFindsNothing(SLIVER, 9)).toBe(true)
		expect(polyfillFindsNothing(SLIVER, 10)).toBe(true)
		expect(polyfillFindsNothing(SLIVER, 11)).toBe(true)
	})

	it("is FALSE for a polygon a cell centre falls inside", () => {
		expect(polyfillFindsNothing(BIG, 10)).toBe(false)
	})
})

describe("classifyFeatureCells over this layer's population", () => {
	it("still reaches a cell for the polygon the polyfill drops, at every candidate resolution", () => {
		for (const resolution of [9, 10, 11]) {
			const cells = classifyFeatureCells(SLIVER, resolution, "sliver", "zoning cells")

			expect(cells.whole.length + cells.partial.length).toBeGreaterThan(0)
		}
	})

	it("fills a large polygon's interior, so a probe inside it never reads geometry", () => {
		const cells = classifyFeatureCells(BIG, 10, "big", "zoning cells")

		expect(cells.whole.length).toBeGreaterThan(0)
		expect(cells.partial.length).toBeGreaterThan(0)
	})
})

describe("featureCellRows", () => {
	it("compacts the whole set and leaves the fringe at its own resolution", () => {
		const rows = featureCellRows(classifyFeatureCells(BIG, 10, "big", "zoning cells"))

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.some((row) => row.containment === "whole")).toBe(true)
		expect(rows.some((row) => row.containment === "partial")).toBe(true)

		// A cell is never both for one polygon.
		// A parent the partial set also names would duplicate it and the primary key
		// would reject the second insert mid-build.
		const cells = rows.map((row) => row.h3Cell)

		expect(new Set(cells).size).toBe(cells.length)
	})
})

describe("ZoningCellIndex", () => {
	it("reports candidates per cell, which is what a probe pays", () => {
		const index = new ZoningCellIndex(10)

		// The same polygon folded in twice: every cell it reaches now names two candidates.
		index.add(classifyFeatureCells(BIG, 10, "a", "zoning cells"))
		index.add(classifyFeatureCells(BIG, 10, "b", "zoning cells"))

		const measurement = index.finish()

		expect(measurement.features).toBe(2)
		expect(measurement.candidatesPerCell.mean).toBeCloseTo(2, 6)
		expect(measurement.candidatesPerCell.max).toBe(2)
		expect(measurement.multiCandidateShare).toBe(1)
		expect(measurement.zeroCellFeatures).toBe(0)
	})

	it("reports the polyfill-only zero-cell count only where the probe ran", () => {
		const measured = new ZoningCellIndex(9)

		measured.add(classifyFeatureCells(SLIVER, 9, "sliver", "zoning cells"))
		measured.addPolyfillProbe(polyfillFindsNothing(SLIVER, 9))

		expect(measured.finish().polyfillZeroCellFeatures).toBe(1)

		const unmeasured = new ZoningCellIndex(9)

		unmeasured.add(classifyFeatureCells(SLIVER, 9, "sliver", "zoning cells"))

		// Absent rather than zero: a column reporting "0 dropped" with no measurement
		// reads as the good news the measurement exists to establish.
		expect(unmeasured.finish().polyfillZeroCellFeatures).toBeUndefined()
	})

	it("counts stored rows as the compacted whole set plus the fringe", () => {
		const index = new ZoningCellIndex(10)

		index.add(classifyFeatureCells(BIG, 10, "a", "zoning cells"))

		const measurement = index.finish()

		expect(measurement.storedCellRows).toBe(measurement.compactedWholeCells + measurement.partialCells)
		expect(measurement.compactedWholeCells).toBeLessThanOrEqual(measurement.wholeCells)
		expect(measurement.touchedCells).toBe(measurement.wholeCells + measurement.partialCells)
	})
})
