/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-feature cell rows and the per-scenario measurement.
 *
 *   THE MEASUREMENT MUST STAY SPLIT BY SCENARIO. Twelve layers cover the same frontages with different
 *   extents, so a pooled `partial` share averages a present-day designation together with a 2105 projection
 *   and describes neither. The test below folds two scenarios into one index and asserts they come back
 *   apart.
 */

import { classifyFeatureCells, CoastalCellIndex, featureCellRows } from "@mailwoman/coastal/sdk/cells"
import { FIXTURE_ORIGIN, FIXTURE_SIDE, rectangleRing } from "@mailwoman/coastal/test-kit"
import type { MultiPolygonRings } from "@mailwoman/spatial"
import { getResolution } from "h3-js"
import { describe, expect, it } from "vitest"

const { lon, lat } = FIXTURE_ORIGIN

const band: MultiPolygonRings = [[rectangleRing(lon, lat, lon + FIXTURE_SIDE, lat + FIXTURE_SIDE)]]

/**
 * About 5.5 m across — well under a resolution-11 cell.
 */
const sliver: MultiPolygonRings = [[rectangleRing(lon, lat, lon + 0.00005, lat + 0.00005)]]

describe("featureCellRows", () => {
	it("splits one feature's classification into whole and partial rows", () => {
		const rows = featureCellRows(classifyFeatureCells(band, 10, "band", "test"))

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.some((row) => row.containment === "whole")).toBe(true)
		expect(rows.some((row) => row.containment === "partial")).toBe(true)
	})

	it("never emits the same cell as both whole and partial", () => {
		const rows = featureCellRows(classifyFeatureCells(band, 10, "band", "test"))
		const whole = new Set(rows.filter((row) => row.containment === "whole").map((row) => row.h3Cell))

		for (const row of rows.filter((entry) => entry.containment === "partial")) {
			expect(whole.has(row.h3Cell)).toBe(false)
		}
	})

	it("carries the resolution each row's cell was captured at, because compaction mixes them", () => {
		const classified = classifyFeatureCells(band, 11, "band", "test")
		const rows = featureCellRows(classified)

		for (const row of rows) {
			expect(row.resolution).toBeLessThanOrEqual(11)
			expect(row.resolution).toBeGreaterThan(0)
		}

		// A compacted whole row can be coarser than the index resolution; a partial row never is.
		const partial = rows.filter((row) => row.containment === "partial")

		expect(partial.every((row) => row.resolution === classified.resolution)).toBe(true)
	})

	it("indexes a polygon smaller than a cell rather than returning nothing", () => {
		const rows = featureCellRows(classifyFeatureCells(sliver, 9, "sliver", "test"))

		// Cell-touches-polygon, not centre-in-polygon: a polyfill keyed on centres returns zero cells here, and a feature
		// indexed to nothing reads downstream as an absence. It touches two cells rather than one at this coordinate,
		// because a 5.5 m square that straddles a cell boundary is in both — which is the answer overlapping containment
		// is supposed to give.
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.every((row) => row.containment === "partial")).toBe(true)

		for (const row of rows) {
			expect(getResolution(`8${row.resolution.toString(16)}${row.h3Cell.toString(16).padStart(13, "0")}`)).toBe(
				row.resolution
			)
		}
	})
})

describe("CoastalCellIndex", () => {
	it("reports each scenario separately rather than pooling them", () => {
		const index = new CoastalCellIndex(10)

		index.add("NFI_2055_0CC", classifyFeatureCells(band, 10, "a", "test"))
		index.add("SMP_2105_95CC", classifyFeatureCells(sliver, 10, "b", "test"))

		const measurement = index.finish()

		expect(measurement.perScenario.map((scenario) => scenario.scenarioKey)).toEqual(["NFI_2055_0CC", "SMP_2105_95CC"])

		const [nfi, smp] = measurement.perScenario

		expect(nfi!.features).toBe(1)
		expect(smp!.features).toBe(1)

		// The band has an interior; the sliver is entirely fringe. So the two scenarios' partial shares are genuinely
		// different numbers — and a pooled report would have averaged them into one that describes neither. The pooled
		// value sits strictly between them, which is exactly why it cannot be read as either.
		expect(nfi!.partialShare).toBeLessThan(1)
		expect(smp!.partialShare).toBe(1)
		expect(measurement.pooledPartialShare).toBeGreaterThan(nfi!.partialShare)
		expect(measurement.pooledPartialShare).toBeLessThan(smp!.partialShare)
	})

	it("sums stored rows across scenarios rather than taking their union", () => {
		const index = new CoastalCellIndex(10)

		index.add("NFI_2055_0CC", classifyFeatureCells(band, 10, "a", "test"))
		index.add("SMP_2105_95CC", classifyFeatureCells(band, 10, "b", "test"))

		const measurement = index.finish()
		const [first, second] = measurement.perScenario

		// The same ground under two scenarios is two claims and therefore two rows, not one.
		expect(measurement.storedCellRows).toBe(
			first!.compactedWholeCells + first!.partialCells + second!.compactedWholeCells + second!.partialCells
		)
	})

	it("reports zero shares rather than dividing by zero on an empty index", () => {
		const measurement = new CoastalCellIndex(10).finish()

		expect(measurement.perScenario).toEqual([])
		expect(measurement.pooledPartialShare).toBe(0)
		expect(measurement.storedCellRows).toBe(0)
	})
})
