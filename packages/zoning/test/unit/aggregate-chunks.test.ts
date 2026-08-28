/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The chunk merge, which is the part of the batched path a fixture build cannot reach.
 *
 *   TWO OF THESE MERGES PRODUCE A WELL-FORMED WRONG ARTIFACT WHEN THEY GO WRONG, and neither would fail
 *   anything else.
 *
 *   1. COVERAGE COUNTS ADD RATHER THAN REPLACE. A coverage cell straddles chunk boundaries, so taking the
 *      last chunk's value reports the cell as holding only the last range's polygons.
 *   2. CROSSWALK PAIRS MERGE AS A UNION. A mapping that is not a function can look like one inside any single
 *      chunk — Cork County Council's `Special Policy Area` takes 14 generic types across the county, and a
 *      chunk holding a prefix of its feature ids may well have seen one. A per-chunk verdict would report the
 *      mapping as a function and license an edge table the publisher never authored.
 */

import { aggregateChunks, nonFunctionalPairs } from "@mailwoman/zoning/sdk/build-zoning"
import type { ZoningChunkResult } from "@mailwoman/zoning/sdk/ingest-chunk"
import { describe, expect, it } from "vitest"

/**
 * One chunk report, with everything a caller does not care about at its zero.
 */
function chunk(overrides: Partial<ZoningChunkResult> = {}): ZoningChunkResult {
	return {
		features: 0,
		coarsened: 0,
		wholeCellRows: 0,
		partialCellRows: 0,
		observedByCoverageCell: [],
		area: { signedM2: 0, nestedM2: 0, allExteriorM2: 0 },
		rings: { total: 0, exteriors: 0, holes: 0, nestedHoles: 0, adjacentHoles: 0, exteriorByMagnitude: 0 },
		jurisdictions: [],
		plans: [],
		vocabulary: [],
		crosswalkPairs: [],
		...overrides,
	}
}

describe("aggregateChunks", () => {
	it("ADDS the coverage counts for a cell two chunks both reach", () => {
		const merged = aggregateChunks([
			chunk({ features: 2, observedByCoverageCell: [[1, 2]] }),
			chunk({
				features: 3,
				observedByCoverageCell: [
					[1, 3],
					[2, 1],
				],
			}),
		])

		expect(merged.features).toBe(5)
		expect(merged.observedByCoverageCell.get(1)).toBe(5)
		expect(merged.observedByCoverageCell.get(2)).toBe(1)
	})

	it("UNIONS the crosswalk codes a pair takes across chunks", () => {
		const merged = aggregateChunks([
			chunk({ crosswalkPairs: [["CO", "Special Policy Area", ["C2.1"]]] }),
			chunk({ crosswalkPairs: [["CO", "Special Policy Area", ["M1", "R2"]]] }),
		])

		expect(merged.crosswalkPairs).toHaveLength(1)
		expect(merged.crosswalkPairs[0]![2]).toEqual(["C2.1", "M1", "R2"])

		// EACH CHUNK ALONE LOOKS LIKE A FUNCTION. That is the whole reason the pairs merge here rather than being decided per
		// chunk.
		expect(nonFunctionalPairs([["CO", "Special Policy Area", ["C2.1"]]])).toHaveLength(0)
		expect(nonFunctionalPairs(merged.crosswalkPairs)).toHaveLength(1)
	})

	it("keeps a local code that contains spaces intact across the merge", () => {
		// The pair key joins two free-text values, and a local code routinely contains spaces — `Special Policy Area`,
		// `RA - Rural Area`. A key a reader had to split back apart would mangle exactly the vocabulary this layer carries
		// verbatim.
		const merged = aggregateChunks([
			chunk({ crosswalkPairs: [["ME", "RA - Rural Area", ["P5"]]] }),
			chunk({ crosswalkPairs: [["ME", "RA - Rural Area", ["P1"]]] }),
		])

		expect(merged.crosswalkPairs[0]![0]).toBe("ME")
		expect(merged.crosswalkPairs[0]![1]).toBe("RA - Rural Area")
		expect(merged.crosswalkPairs[0]![2]).toEqual(["P1", "P5"])
	})

	it("adds the vocabulary row counts and keeps the first label", () => {
		const merged = aggregateChunks([
			chunk({ vocabulary: [["IE-GZT", "R2", "Existing residential", 4]] }),
			chunk({ vocabulary: [["IE-GZT", "R2", "Existing residential", 6]] }),
		])

		expect(merged.vocabulary).toHaveLength(1)
		expect(merged.vocabulary[0]).toEqual(["IE-GZT", "R2", "Existing residential", 10])
	})

	it("de-duplicates the authorities and the plans, which every chunk that touches one reports", () => {
		const plan = {
			planID: "FX-DP-2024",
			authorityCode: "Fx",
			name: "Fixture County Development Plan",
			level: "DP",
			from: null,
			to: null,
			currentPlan: 1,
		}

		const merged = aggregateChunks([
			chunk({ jurisdictions: [["Fx", "Fixture County Council"]], plans: [plan] }),
			chunk({ jurisdictions: [["Fx", "Fixture County Council"]], plans: [plan] }),
		])

		expect(merged.jurisdictions).toEqual([["Fx", "Fixture County Council"]])
		expect(merged.plans).toHaveLength(1)
	})

	it("sums the ring census and the three area readings", () => {
		const merged = aggregateChunks([
			chunk({
				rings: { total: 3, exteriors: 2, holes: 1, nestedHoles: 1, adjacentHoles: 0, exteriorByMagnitude: 0 },
				area: { signedM2: 10, nestedM2: 10, allExteriorM2: 14 },
			}),
			chunk({
				rings: { total: 2, exteriors: 1, holes: 1, nestedHoles: 0, adjacentHoles: 1, exteriorByMagnitude: 1 },
				area: { signedM2: 5, nestedM2: 5, allExteriorM2: 9 },
			}),
		])

		expect(merged.rings).toEqual({
			total: 5,
			exteriors: 3,
			holes: 2,
			nestedHoles: 1,
			adjacentHoles: 1,
			exteriorByMagnitude: 1,
		})

		expect(merged.area).toEqual({ signedM2: 15, nestedM2: 15, allExteriorM2: 23 })
	})
})
