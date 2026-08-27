/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture rung: build a real sealed artifact from hand-built geometry, then read it.
 *
 *   THE TWO DIRECTIONS OF THE MEANING-OF-ZERO RULE ARE THE POINT OF THIS FILE. A point inside the
 *   authority's footprint and outside every polygon must read as the authority's Zone 1 DESIGNATION, and a
 *   point outside the footprint must read `unknown`. Both are the same empty answer from the geometry, and
 *   a layer that could not tell them apart would report every unmapped location as low-hazard.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FloodContainmentPath, FloodReadingKind, FloodZoneLookup } from "@mailwoman/flood"
import { buildFloodDatabase, type BuildFloodResult } from "@mailwoman/flood/sdk/build-flood"
import { realizeFloodMapExtent } from "@mailwoman/flood/sdk/extent"
import {
	fixtureExtentGeometry,
	fixtureFeature,
	fixtureFeatures,
	fixtureSource,
	rectangleRing,
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
} from "@mailwoman/flood/test-kit"
import { EA_COVERAGE_STATEMENT, EA_COVERAGE_STATEMENT_URL, EA_FLOOD_LAYER_NAME } from "@mailwoman/flood/vocabulary"
import { latLngToCell } from "h3-js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const INDEX_RESOLUTION = 9
const COVERAGE_RESOLUTION = 6

let scratch: string
let databasePath: string
let result: BuildFloodResult
let lookup: FloodZoneLookup

/**
 * Build one artifact from a feature list, into its own scratch directory.
 */
async function build(
	features = fixtureFeatures(),
	out = "flood.db"
): Promise<{ path: string; result: BuildFloodResult }> {
	const path = join(scratch, out)

	const built = await buildFloodDatabase({
		source: fixtureSource(features),
		out: path,
		sourceVintage: "2026-05-20",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: INDEX_RESOLUTION,
		coverageResolution: COVERAGE_RESOLUTION,
		extent: realizeFloodMapExtent({
			geometry: fixtureExtentGeometry(),
			coverageResolution: COVERAGE_RESOLUTION,
			authority: "Environment Agency",
			statement: EA_COVERAGE_STATEMENT,
			statementURL: EA_COVERAGE_STATEMENT_URL,
		}),
	})

	return { path, result: built }
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "mw-flood-"))

	const built = await build()

	databasePath = built.path
	result = built.result
	lookup = new FloodZoneLookup({ databasePath })
})

afterAll(() => {
	lookup?.close()
	rmSync(scratch, { recursive: true, force: true })
})

describe("buildFloodDatabase", () => {
	it("writes every feature, seals the artifact read-only, and swaps it into place", () => {
		expect(result.features).toBe(3)
		expect(result.zoneCounts).toEqual({ FZ2: 1, FZ3: 2 })
		// 0o444 — a layer database is a read-only artifact once built.
		expect(statSync(databasePath).mode & 0o777).toBe(0o444)
	})

	it("carries the authority's identity, licence and attribution in the manifest", () => {
		expect(lookup.identity.manifest.name).toBe(EA_FLOOD_LAYER_NAME)
		expect(lookup.identity.manifest.tier).toBe("shipped")
		expect(lookup.identity.manifest.license).toBe("OGL-UK-3.0")
		expect(lookup.identity.manifest.attribution).toMatch(/Environment Agency copyright/u)
		expect(lookup.identity.manifest.sourceVintage).toBe("2026-05-20")

		expect(lookup.identity.manifest.spineKeys.h3).toEqual({
			column: "flood_zone_cell.h3_cell",
			resolution: INDEX_RESOLUTION,
		})
	})

	it("derives the footprint from the coverage statement, not from the polygon union", () => {
		expect(lookup.identity.extent.statement).toBe(EA_COVERAGE_STATEMENT)

		// The polygons occupy a few square kilometres; the statement's footprint is the whole outline, so the coverage
		// cells vastly outnumber the cells any polygon reaches. A footprint taken from the polygons would be the other way
		// round — and every Zone 1 location would read as unmapped.
		expect(result.coverageCells).toBeGreaterThan(result.coverageCellsWithRows * 10)
		expect(result.coverageCellsWithRows).toBeGreaterThan(0)
	})

	it("agrees with the source's own area figure, and reports what a hole-blind read would have claimed", () => {
		expect(result.area.relativeGap).toBeLessThan(0.01)
		expect(result.area.allExteriorKM2).toBeGreaterThan(result.area.nestedKM2)
	})

	it("refuses a zone code outside the authority's declared domain", async () => {
		const rogue = [fixtureFeature("9", "FZ4", [[rectangleRing(1.9, 52.6, 1.91, 52.61)]])]

		await expect(build(rogue, "rogue.db")).rejects.toThrow(/declared domain/u)
	})

	it("refuses a coverage resolution finer than the index resolution", async () => {
		await expect(
			buildFloodDatabase({
				source: fixtureSource(fixtureFeatures()),
				out: join(scratch, "inverted.db"),
				sourceVintage: "2026-05-20",
				buildCmd: "vitest",
				buildSHA: "fixture",
				createdAt: "2026-08-28T00:00:00.000Z",
				indexResolution: 6,
				coverageResolution: 9,
				extent: realizeFloodMapExtent({
					geometry: fixtureExtentGeometry(),
					coverageResolution: 9,
					authority: "Environment Agency",
					statement: EA_COVERAGE_STATEMENT,
					statementURL: EA_COVERAGE_STATEMENT_URL,
				}),
			})
		).rejects.toThrow(/must be coarser/u)
	})

	it("refuses a source whose streamed count disagrees with its own declaration", async () => {
		const features = fixtureFeatures()

		await expect(
			buildFloodDatabase({
				source: { ...fixtureSource(features), declaredFeatureCount: features.length + 1 },
				out: join(scratch, "short.db"),
				sourceVintage: "2026-05-20",
				buildCmd: "vitest",
				buildSHA: "fixture",
				createdAt: "2026-08-28T00:00:00.000Z",
				indexResolution: INDEX_RESOLUTION,
				coverageResolution: COVERAGE_RESOLUTION,
				extent: realizeFloodMapExtent({
					geometry: fixtureExtentGeometry(),
					coverageResolution: COVERAGE_RESOLUTION,
					authority: "Environment Agency",
					statement: EA_COVERAGE_STATEMENT,
					statementURL: EA_COVERAGE_STATEMENT_URL,
				}),
			})
		).rejects.toThrow(/a short read builds a smaller England/u)
	})
})

describe("FloodZoneLookup — the three readings", () => {
	it("answers a wholly-interior point from the index, with no geometry read", () => {
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2, FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2)

		expect(reading.kind).toBe(FloodReadingKind.Designated)
		expect(reading.zoneCode).toBe("FZ3")
		expect(reading.containment).toBe(FloodContainmentPath.WholeCell)
		expect(reading.areaID).toBeUndefined()
	})

	it("answers the adjacent square's interior with the other zone", () => {
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2, FIXTURE_ORIGIN.lon + FIXTURE_SIDE * 1.5)

		expect(reading.kind).toBe(FloodReadingKind.Designated)
		expect(reading.zoneCode).toBe("FZ2")
	})

	it("falls through to the ray cast at a boundary, and names the polygon it matched", () => {
		// A point just inside the FZ3 square's western edge — inside the polygon, inside a cell the edge crosses.
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2, FIXTURE_ORIGIN.lon + 0.00002)

		expect(reading.kind).toBe(FloodReadingKind.Designated)
		expect(reading.zoneCode).toBe("FZ3")
		expect(reading.containment).toBe(FloodContainmentPath.RayCast)
		expect(reading.areaID).toBe("1")
	})

	it("reads a point inside a polygon's HOLE as the designated absence, not as the polygon's zone", () => {
		// Feature 3 is a square with a hole through its middle. The hole is inside the footprint and inside no polygon, so
		// the authority's map assigns Zone 1 there — a hole read as an exterior ring would answer FZ3 instead.
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + FIXTURE_SIDE * 2.5, FIXTURE_ORIGIN.lon + FIXTURE_SIDE * 0.5)

		expect(reading.kind).toBe(FloodReadingKind.DesignatedAbsence)
		expect(reading.definition?.code).toBe("FZ1")
	})

	it("reads a point inside the footprint and outside every polygon as the authority's Zone 1 DESIGNATION", () => {
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + 0.2, FIXTURE_ORIGIN.lon + 0.2)

		expect(reading.kind).toBe(FloodReadingKind.DesignatedAbsence)
		expect(reading.containment).toBe(FloodContainmentPath.NoZoneCell)
		expect(reading.definition?.code).toBe("FZ1")
		expect(reading.definition?.definition).toMatch(/less than 0\.1% annual probability/u)

		// The coverage row is what licenses the reading, and it says the authority designated here and holds nothing.
		expect(reading.coverage?.basis).toBe("designated")
		expect(reading.coverage?.completeness).toBe(1)
		expect(reading.coverage?.observedRows).toBe(0)
	})

	it("reads a point OUTSIDE the footprint as unknown, and never as Zone 1", () => {
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + 5, FIXTURE_ORIGIN.lon + 5)

		expect(reading.kind).toBe(FloodReadingKind.Unknown)
		expect(reading.coverage).toBeUndefined()
		expect(reading.definition).toBeUndefined()
		expect(reading.zoneCode).toBeUndefined()
	})

	it("carries the authority's own exclusions on every reading, including the absence", () => {
		for (const reading of [
			lookup.lookup(FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2, FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2),
			lookup.lookup(FIXTURE_ORIGIN.lat + 0.2, FIXTURE_ORIGIN.lon + 0.2),
			lookup.lookup(FIXTURE_ORIGIN.lat + 5, FIXTURE_ORIGIN.lon + 5),
		]) {
			expect(
				reading.limits.some((limit) => /not suitable for showing whether an individual property/u.test(limit))
			).toBe(true)
		}
	})

	it("keys a row's coverage cell to the PARENT of its index cell", () => {
		const latitude = FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2
		const longitude = FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2
		const reading = lookup.lookup(latitude, longitude)

		expect(reading.coverage?.h3CellIndex).toBe(latLngToCell(latitude, longitude, COVERAGE_RESOLUTION))
		expect(reading.indexCellIndex).toBe(latLngToCell(latitude, longitude, INDEX_RESOLUTION))
	})
})
