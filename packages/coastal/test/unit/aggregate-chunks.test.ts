/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The batched path's arithmetic — the one part a fixture build cannot reach, and the one whose failure
 *   produces a well-formed artifact.
 *
 *   A CHUNK HERE IS ONE SCENARIO, AND EVERY SCENARIO COVERS THE SAME COAST. So a coverage cell appears in
 *   twelve chunks and the counts must ADD; taking the last chunk's value would report a cell as holding one
 *   scenario's polygons, which is a twelfth of what is there — a number that looks entirely plausible on a
 *   receipt.
 */

import { aggregateChunks } from "@mailwoman/coastal/sdk/build-coastal"
import type { CoastalChunkResult } from "@mailwoman/coastal/sdk/ingest-chunk"
import { describe, expect, it } from "vitest"

function chunk(overrides: Partial<CoastalChunkResult> = {}): CoastalChunkResult {
	return {
		erosionFeatures: 0,
		instabilityFeatures: 0,
		coarsened: 0,
		scenarioCounts: {},
		wholeCellRows: 0,
		partialCellRows: 0,
		observedByCoverageCell: [],
		area: { sourceM2: 0, nestedM2: 0, allExteriorM2: 0 },
		defenceTypeCounts: [],
		...overrides,
	}
}

describe("aggregateChunks", () => {
	it("adds a coverage cell's counts across chunks rather than replacing them", () => {
		const result = aggregateChunks([
			chunk({ observedByCoverageCell: [[7, 3]] }),
			chunk({ observedByCoverageCell: [[7, 4]] }),
			chunk({ observedByCoverageCell: [[8, 1]] }),
		])

		expect(result.observedByCoverageCell.get(7)).toBe(7)
		expect(result.observedByCoverageCell.get(8)).toBe(1)
	})

	it("keeps the two feature populations apart", () => {
		const result = aggregateChunks([
			chunk({ erosionFeatures: 7379 }),
			chunk({ erosionFeatures: 7501 }),
			chunk({ instabilityFeatures: 160 }),
		])

		expect(result.erosionFeatures).toBe(14_880)
		expect(result.instabilityFeatures).toBe(160)
	})

	it("sums the per-scenario counts under their own keys", () => {
		const result = aggregateChunks([
			chunk({ scenarioCounts: { NFI_2055_0CC: 7379 } }),
			chunk({ scenarioCounts: { SMP_2105_95CC: 7492 } }),
			chunk({ scenarioCounts: { NFI_2055_0CC: 1 } }),
		])

		expect(result.scenarioCounts).toEqual({ NFI_2055_0CC: 7380, SMP_2105_95CC: 7492 })
	})

	it("sums the cell rows by tier", () => {
		const result = aggregateChunks([
			chunk({ wholeCellRows: 10, partialCellRows: 90 }),
			chunk({ wholeCellRows: 5, partialCellRows: 45 }),
		])

		expect(result.wholeCellRows).toBe(15)
		expect(result.partialCellRows).toBe(135)
	})

	it("computes the area gap over the summed totals, not per chunk", () => {
		const result = aggregateChunks([
			chunk({ area: { sourceM2: 1_000_000, nestedM2: 1_000_000, allExteriorM2: 1_100_000 } }),
			chunk({ area: { sourceM2: 1_000_000, nestedM2: 990_000, allExteriorM2: 1_090_000 } }),
		])

		expect(result.area.sourceKM2).toBe(2)
		expect(result.area.nestedKM2).toBe(1.99)
		expect(result.area.relativeGap).toBeCloseTo(0.005, 6)
	})

	it("reports a zero gap rather than a NaN when the source reports no area", () => {
		expect(aggregateChunks([chunk()]).area.relativeGap).toBe(0)
	})

	it("pools the defence-type census and orders it by count", () => {
		const result = aggregateChunks([
			chunk({ defenceTypeCounts: [["Sheet piles", 1344]] }),
			chunk({
				defenceTypeCounts: [
					["Sheet Piles", 270],
					["Sheet piles", 6],
				],
			}),
		])

		// The two spellings stay APART in the census: the fold is what the domain check compares on, and folding the
		// receipt too would hide the source's own inconsistency from the reader who has to see it.
		expect(result.defenceTypeCounts).toEqual([
			["Sheet piles", 1350],
			["Sheet Piles", 270],
		])
	})
})
