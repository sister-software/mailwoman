/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit cover for the exclusion-grade coverage composition, plus the write-and-read leg: cells produced
 *   here go through `@mailwoman/core/layers` and come back answering `supportsExclusion` true, while the
 *   pipeline's default path comes back answering false.
 */

import {
	CoverageBasis,
	createLayerCoverageTable,
	readLayerCoverage,
	supportsExclusion,
	writeLayerCoverage,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { type GeojsonGeometry, type GeojsonPosition, shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToBoundary, latLngToCell } from "h3-js"
import { describe, expect, it } from "vitest"

import type { CaptureRow } from "#gazetteer-pipeline/poi/capture-recapture"
import { interiorCoverageCells } from "#gazetteer-pipeline/poi/coverage-region"
import { buildExclusionCoverage } from "#gazetteer-pipeline/poi/exclusion-coverage"

const RESOLUTION = 6

function square(minLon: number, minLat: number, size: number): GeojsonGeometry {
	const ring: GeojsonPosition[] = [
		[minLon, minLat],
		[minLon + size, minLat],
		[minLon + size, minLat + size],
		[minLon, minLat + size],
		[minLon, minLat],
	]

	return { type: "Polygon", coordinates: [ring] }
}

const REGION = square(2, 48.5, 1)

/**
 * The centre of the nth interior cell — a coordinate guaranteed to land inside the region's cell set.
 */
function interiorCentre(n: number): { latitude: number; longitude: number } {
	const cells = interiorCoverageCells(REGION, RESOLUTION)
	const vertices = cellToBoundary(cells[n % cells.length]!) as number[][]
	let lat = 0
	let lon = 0

	for (const [vLat, vLon] of vertices) {
		lat += vLat!
		lon += vLon!
	}

	return { latitude: lat / vertices.length, longitude: lon / vertices.length }
}

function rows(count: number, name: (i: number) => string | null): CaptureRow[] {
	return Array.from({ length: count }, (_, i) => ({ ...interiorCentre(i), name: name(i) }))
}

describe("buildExclusionCoverage", () => {
	it("writes one surveyed cell per interior cell, empty ones included", () => {
		const subject = rows(12, (i) => `Pharmacie ${i}`)
		const result = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		expect(result.cells).toHaveLength(interiorCoverageCells(REGION, RESOLUTION).length)
		expect(result.cells.every((cell) => cell.basis === CoverageBasis.Surveyed)).toBe(true)
		expect(result.emptyCells).toBe(result.cells.length - 12)
		expect(result.emptyCells).toBeGreaterThan(0)
	})

	it("never writes a cell outside the region", () => {
		const interior = new Set(interiorCoverageCells(REGION, RESOLUTION).map((c) => shortCellToInt(c as H3Cell)))
		const subject = rows(6, (i) => `Pharmacie ${i}`)
		const result = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		for (const cell of result.cells) {
			expect(interior.has(cell.h3Cell)).toBe(true)
		}
	})

	it("counts rows that fell outside the region rather than dropping them silently", () => {
		const subject = [...rows(4, (i) => `Pharmacie ${i}`), { latitude: 10, longitude: 10, name: "Elsewhere" }]
		const result = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		expect(result.subjectOutsideRegion).toBe(1)
		expect(result.cells.reduce((sum, cell) => sum + cell.observedRows, 0)).toBe(4)
	})

	it("counts a non-finite coordinate as outside rather than crashing on it", () => {
		const subject = [...rows(3, (i) => `Pharmacie ${i}`), { latitude: Number.NaN, longitude: 2.5, name: "Broken" }]
		const result = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		expect(result.subjectOutsideRegion).toBe(1)
	})

	it("records a lower completeness when the two inventories agree less", () => {
		const shared = rows(10, (i) => `Pharmacie ${i}`)

		const agreeing = buildExclusionCoverage({
			geometry: REGION,
			resolution: RESOLUTION,
			subject: shared,
			reference: shared,
		})

		const disagreeing = buildExclusionCoverage({
			geometry: REGION,
			resolution: RESOLUTION,
			subject: shared,
			// Same places, but only three of the names survive — the rest read as a different inventory.
			reference: shared.map((row, i) => (i < 3 ? row : { ...row, name: `Boulangerie ${i}` })),
		})

		expect(disagreeing.completeness.recorded).toBeLessThan(agreeing.completeness.recorded)
	})

	it("refuses a region no cell fits inside", () => {
		expect(() =>
			buildExclusionCoverage({
				geometry: square(2, 48.5, 0.001),
				resolution: RESOLUTION,
				subject: [],
				reference: [],
			})
		).toThrow(/no res-6 cell lies wholly inside/)
	})
})

describe("the layer contract's read of these cells", () => {
	async function openCoverageDB() {
		const db = DatabaseClient.temp<LayerContractDatabase>()
		await createLayerCoverageTable(db)

		return db
	}

	it("answers supportsExclusion true for a surveyed pilot cell, empty or not", async () => {
		using db = await openCoverageDB()
		const subject = rows(5, (i) => `Pharmacie ${i}`)
		const { cells } = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		await writeLayerCoverage(db, cells)

		const occupied = cells.find((cell) => cell.observedRows > 0)!
		const empty = cells.find((cell) => cell.observedRows === 0)!

		for (const cell of [occupied, empty]) {
			const back = await readLayerCoverage(db, cell.h3Cell)

			expect(back?.basis).toBe(CoverageBasis.Surveyed)
			expect(supportsExclusion(back!)).toBe(true)
			expect(back?.completeness).toBeCloseTo(cell.completeness, 12)
		}
	})

	it("still answers undefined — not zero — for a cell outside the pilot region", async () => {
		using db = await openCoverageDB()
		const subject = rows(5, (i) => `Pharmacie ${i}`)
		const { cells } = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		await writeLayerCoverage(db, cells)

		// A cell on the other side of the world — unsurveyed by any reading of this pilot.
		const outside = shortCellToInt(latLngToCell(35.68, 139.76, RESOLUTION) as H3Cell)

		expect(cells.some((cell) => cell.h3Cell === outside)).toBe(false)
		expect(await readLayerCoverage(db, outside)).toBeUndefined()
	})

	it("answers supportsExclusion false for the source-present cells the rest of the pipeline writes", async () => {
		using db = await openCoverageDB()
		const subject = rows(3, (i) => `Pharmacie ${i}`)
		const { cells } = buildExclusionCoverage({ geometry: REGION, resolution: RESOLUTION, subject, reference: subject })

		await writeLayerCoverage(
			db,
			cells.map((cell) => ({ ...cell, completeness: 1, basis: CoverageBasis.SourcePresent }))
		)

		const back = await readLayerCoverage(db, cells[0]!.h3Cell)

		expect(supportsExclusion(back!)).toBe(false)
	})
})
