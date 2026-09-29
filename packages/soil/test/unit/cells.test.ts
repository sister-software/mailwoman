/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { aggregateChunks } from "@mailwoman/soil/sdk/build-soil"
import { classifyDelineationCells, SoilCellIndex } from "@mailwoman/soil/sdk/cells"
import type { SoilChunkResult } from "@mailwoman/soil/sdk/ingest-chunk"
import { FIXTURE_ORIGIN } from "@mailwoman/soil/test-kit"
import { rectangleRing } from "@mailwoman/spatial"
import { describe, expect, it } from "vitest"

const { lat, lon } = FIXTURE_ORIGIN

describe("SoilCellIndex", () => {
	it("gives a sub-cell delineation only partial cells, which is why the index answers nothing alone", () => {
		// About 11 m across — far smaller than a resolution-9 cell, the typical size.
		const tiny = [[rectangleRing(lon, lat, lon + 0.0001, lat + 0.0001)]]
		const index = new SoilCellIndex(9)

		index.add("a:0", classifyDelineationCells(tiny, 9, "a:0"))

		const measurement = index.finish()

		expect(measurement.wholeCells).toBe(0)
		expect(measurement.partialShare).toBe(1)
		expect(measurement.compactedWholeCells).toBe(0)
	})

	it("gives a delineation several cells across an interior that compacts", () => {
		const wide = [[rectangleRing(lon, lat, lon + 0.02, lat + 0.02)]]
		const index = new SoilCellIndex(9)

		index.add("a:0", classifyDelineationCells(wide, 9, "a:0"))

		const measurement = index.finish()

		expect(measurement.wholeCells).toBeGreaterThan(0)
		expect(measurement.partialShare).toBeLessThan(1)
		expect(measurement.compactedWholeCells).toBeLessThanOrEqual(measurement.wholeCells)
	})

	it("counts the delineations reaching a cell, which is the mixture before any rating is read", () => {
		const index = new SoilCellIndex(9)
		const box = [[rectangleRing(lon, lat, lon + 0.0001, lat + 0.0001)]]

		index.add("a:0", classifyDelineationCells(box, 9, "a:0"))
		index.add("a:1", classifyDelineationCells(box, 9, "a:1"))

		expect(index.finish().meanDelineationsPerCell).toBeCloseTo(2, 6)
	})

	it("throws rather than skipping a delineation that reaches no cell", () => {
		// A skipped feature is an invented absence, indistinguishable downstream from unmapped ground.
		expect(() => classifyDelineationCells([], 9, "empty")).toThrow(/reaches no cell/u)
	})
})

function chunk(partial: Partial<SoilChunkResult>): SoilChunkResult {
	return {
		areaSymbol: "XX001",
		delineations: 0,
		coarsened: 0,
		observedByCoverageCell: [],
		mappedByCoverageCell: [],
		area: { nestedM2: 0, allExteriorM2: 0 },
		...partial,
	}
}

describe("aggregateChunks", () => {
	it("ADDS coverage-cell counts across chunks rather than replacing them", () => {
		// A coverage cell can straddle two survey areas, so taking the last chunk's value
		// would make a dense county under-report what it holds.
		const result = aggregateChunks([
			chunk({ delineations: 3, observedByCoverageCell: [[11, 3]], mappedByCoverageCell: [[11, 2]] }),
			chunk({ delineations: 4, observedByCoverageCell: [[11, 4]], mappedByCoverageCell: [[11, 4]] }),
		])

		expect(result.delineations).toBe(7)
		expect(result.observedByCoverageCell.get(11)).toBe(7)
		expect(result.mappedByCoverageCell.get(11)).toBe(6)
	})

	it("counts delineations per survey area, so a short read is nameable rather than only detectable", () => {
		const result = aggregateChunks([
			chunk({ areaSymbol: "IA153", delineations: 10_000 }),
			chunk({ areaSymbol: "IA153", delineations: 7966 }),
			chunk({ areaSymbol: "IA015", delineations: 5 }),
		])

		expect(result.byArea.get("IA153")).toBe(17_966)
		expect(result.byArea.get("IA015")).toBe(5)
	})

	it("keeps the two area readings apart, because the gap between them is the hole diagnosis", () => {
		const result = aggregateChunks([
			chunk({ area: { nestedM2: 100, allExteriorM2: 140 } }),
			chunk({ area: { nestedM2: 200, allExteriorM2: 260 } }),
		])

		expect(result.nestedM2).toBe(300)
		expect(result.allExteriorM2).toBe(400)
	})
})
