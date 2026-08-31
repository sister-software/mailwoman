/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The batched build's arithmetic — the one part of that path a fixture build cannot reach, because a
 *   fixture runs in a single process.
 *
 *   A RANGE OF FEATURE IDS IS NOT A REGION, so a coverage cell is reached by several chunks and their
 *   counts must ADD. Taking the last chunk's value instead would report a busy floodplain as holding
 *   only the polygons whose ids happened to fall in the final range — a well-formed artifact that
 *   under-reports what the authority mapped, with nothing anywhere to say so.
 */

import { aggregateChunks } from "@mailwoman/flood/sdk/build-flood"
import type { FloodChunkResult } from "@mailwoman/flood/sdk/ingest-chunk"
import { describe, expect, it } from "vitest"

function chunk(partial: Partial<FloodChunkResult> = {}): FloodChunkResult {
	return {
		features: 0,
		coarsened: 0,
		zoneCounts: {},
		observedByCoverageCell: [],
		area: { sourceM2: 0, nestedM2: 0, allExteriorM2: 0 },
		...partial,
	}
}

describe("aggregateChunks", () => {
	it("adds a coverage cell's counts across the chunks that reached it", () => {
		const result = aggregateChunks([
			chunk({
				observedByCoverageCell: [
					[100, 3],
					[200, 1],
				],
			}),
			chunk({
				observedByCoverageCell: [
					[100, 5],
					[300, 2],
				],
			}),
		])

		expect(result.observedByCoverageCell.get(100)).toBe(8)
		expect(result.observedByCoverageCell.get(200)).toBe(1)
		expect(result.observedByCoverageCell.get(300)).toBe(2)
	})

	it("adds feature counts, coarsened counts and per-zone counts", () => {
		const result = aggregateChunks([
			chunk({ features: 100_000, coarsened: 2, zoneCounts: { FZ2: 60_000, FZ3: 40_000 } }),
			chunk({ features: 13_627, coarsened: 1, zoneCounts: { FZ3: 13_627 } }),
		])

		expect(result.features).toBe(113_627)
		expect(result.coarsened).toBe(3)
		expect(result.zoneCounts).toEqual({ FZ2: 60_000, FZ3: 53_627 })
	})

	it("computes the area gap over the SUMMED totals, not per chunk", () => {
		// Each chunk is 1% out on its own and they cancel; the whole-file reading is what the tolerance is about.
		const result = aggregateChunks([
			chunk({ area: { sourceM2: 1_000_000, nestedM2: 1_010_000, allExteriorM2: 1_100_000 } }),
			chunk({ area: { sourceM2: 1_000_000, nestedM2: 990_000, allExteriorM2: 1_100_000 } }),
		])

		const { area } = result

		if (area.witness !== "source") throw new Error("the summed area reading carries no source witness")

		expect(area.sourceKM2).toBeCloseTo(2, 6)
		expect(area.nestedKM2).toBeCloseTo(2, 6)
		expect(area.relativeGap).toBeCloseTo(0, 6)
		expect(area.allExteriorKM2).toBeCloseTo(2.2, 6)
	})

	it("reports an ABSENT witness for an empty run rather than a zero gap", () => {
		expect(aggregateChunks([]).area.witness).toBe("absent")
	})
})
