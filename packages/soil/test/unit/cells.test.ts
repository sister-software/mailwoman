/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The cell index this layer keeps, and the arithmetic the batched path cannot reach from a fixture build.
 *
 *   THE INVERSION IS PINNED HERE AS A PROPERTY, NOT AS A NUMBER. A polygon smaller than a cell produces
 *   only `partial` cells — that is what makes this layer's containment index answer almost nothing on its
 *   own — while a polygon several cells across produces an interior that compacts. The measured shares on
 *   the real product are in the workspace README; what this file pins is that the two shapes behave
 *   differently at all, which is the fact the resolution choice rests on.
 */

import { aggregateChunks } from "@mailwoman/soil/sdk/build-soil"
import { classifyDelineationCells, SoilCellIndex } from "@mailwoman/soil/sdk/cells"
import type { SoilChunkResult } from "@mailwoman/soil/sdk/ingest-chunk"
import { FIXTURE_ORIGIN, rectangleRing } from "@mailwoman/soil/test-kit"
import { describe, expect, it } from "vitest"

const { lat, lon } = FIXTURE_ORIGIN

describe("SoilCellIndex", () => {
	it("gives a sub-cell delineation only partial cells, which is why the index answers nothing alone", () => {
		// About 11 m across — far smaller than a resolution-9 cell, and typical: 85.4% of IA153's 17,966 delineations are
		// smaller than one.
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

		// Two delineations over the same ground: a cell they both reach names both.
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
		// A coverage cell straddles chunk boundaries — a range of feature ids is not a region, and a coverage cell can
		// straddle two survey areas. Taking the last chunk's value would report a dense county as holding only its final
		// few delineations, which is a well-formed artifact that under-reports what it holds.
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
