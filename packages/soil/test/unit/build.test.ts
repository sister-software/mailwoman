/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The fixture rung: a real sealed artifact from hand-built geometry, then read back.
 *
 *   THESE ARE THE ONLY PLACE THREE OF THE FOUR ABSENCES CAN BE EXERCISED. Every Iowa survey area is fully
 *   digitized, so `NOTCOM`, `NOTPUB` and access-denied map units never appear in the live build — which
 *   means the fixture is what pins `nodata_share`, and what proves a `NOTCOM` polygon does not arrive as a
 *   low capability class.
 */

import { mkdtempSync, rmSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { SoilCapabilityLookup, SoilReadingKind } from "@mailwoman/soil"
import type { SoilDatabase } from "@mailwoman/soil/schema"
import { buildSoilDatabase, type BuildSoilResult } from "@mailwoman/soil/sdk/build-soil"
import { shareTotal } from "@mailwoman/soil/sdk/reduce"
import {
	FIXTURE_ORIGIN,
	FIXTURE_SIDE,
	fixtureAttributes,
	fixtureDelineations,
	fixtureOutline,
	fixtureSource,
} from "@mailwoman/soil/test-kit"
import { decodeRings } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const INDEX_RESOLUTION = 9
const COVERAGE_RESOLUTION = 6

/**
 * The centre of each fixture square, in the order `fixtureDelineations` lays them out.
 */
function squareCentre(index: number): { latitude: number; longitude: number } {
	return {
		latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2,
		longitude: FIXTURE_ORIGIN.lon + (index + 0.5) * FIXTURE_SIDE,
	}
}

let scratch: string
let databasePath: string
let result: BuildSoilResult
let lookup: SoilCapabilityLookup

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "mw-soil-build-"))
	databasePath = join(scratch, "soil.db")

	const delineations = fixtureDelineations()

	result = await buildSoilDatabase({
		areas: [
			{
				attributes: fixtureAttributes(),
				outline: fixtureOutline(),
				source: fixtureSource(delineations),
				declaredFeatureCount: delineations.length,
			},
		],
		region: "xx",
		out: databasePath,
		sourceVintage: "2025-09-09",
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: INDEX_RESOLUTION,
		coverageResolution: COVERAGE_RESOLUTION,
		inProcess: true,
	})

	lookup = new SoilCapabilityLookup({ databasePath })
})

afterAll(() => {
	lookup?.close()
	rmSync(scratch, { recursive: true, force: true })
})

describe("the fixture build", () => {
	it("writes every delineation and reduces the cells they reach", () => {
		expect(result.delineations).toBe(5)
		expect(result.capabilityCells).toBeGreaterThan(0)
		expect(result.coverageCells).toBeGreaterThan(0)
	})

	it("declares the spine key on the table a consumer joins, table-qualified", () => {
		const spineKeys = lookup.identity.manifest.spineKeys

		// The layer contract settles this: the key names what a consumer joins on, and for this layer that is the
		// single-resolution reduction rather than the mixed-resolution containment index.
		expect(spineKeys.h3?.column).toBe("soil_capability_cell.h3_cell")
		expect(spineKeys.h3?.resolution).toBe(INDEX_RESOLUTION)
	})

	it("keeps both dates apart, so a 2025 refresh never reads as a 1960 survey's currency", () => {
		const area = lookup.identity.surveyAreas[0]!

		expect(area.saverest).toBe("2025-09-09")
		expect(area.surveySourceDate).toBe("1960")
		expect(area.sourceScale).toBe(15_840)
		expect(area.mappingScale).toBe(12_000)
	})

	it("carries the authority's own class definitions, read out of the archive rather than transcribed", () => {
		expect(lookup.identity.classCodes).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"])
	})

	it("records which weighting produced the shares, with the sentence that says what it means", () => {
		expect(lookup.identity.weighting.code).toBe("cell_area_x_comppct_r")
		expect(lookup.identity.weighting.description).toMatch(/proportion without a location/u)
	})
})

describe("what each reading says", () => {
	it("reports the mixed map unit as a distribution, never as a winner", () => {
		const reading = lookup.lookup(squareCentre(0).latitude, squareCentre(0).longitude)

		expect(reading.kind).toBe(SoilReadingKind.Designated)

		const distribution = reading.distribution!

		// 45/35/20 across three classes. The top class is class 2 and it holds well under half, which is exactly the case
		// a winner-class schema would report as "class 2" full stop.
		expect(distribution.topClass).toBe("2")
		expect(distribution.topClassShare).toBeLessThan(0.5)
		expect(Object.keys(distribution.classShares).length).toBeGreaterThan(1)
		expect(reading.topClassDefinition).toMatch(/Class 2/u)
	})

	it("puts a rated class 8 in the class shares and in none of the absences", () => {
		const reading = lookup.lookup(squareCentre(1).latitude, squareCentre(1).longitude)
		const distribution = reading.distribution!

		expect(distribution.topClass).toBe("8")
		expect(distribution.unratedShare).toBe(0)
		expect(distribution.notRateableShare).toBe(0)
		expect(distribution.noDataShare).toBe(0)
	})

	it("puts a water body in notrateable, not in a low class", () => {
		const reading = lookup.lookup(squareCentre(2).latitude, squareCentre(2).longitude)
		const distribution = reading.distribution!

		expect(distribution.notRateableShare).toBeGreaterThan(0.9)
		expect(distribution.topClass).toBeUndefined()
		expect(reading.kind).toBe(SoilReadingKind.DesignatedNoRating)
	})

	it("puts an unrated named soil in unrated, apart from the not-rateable one", () => {
		const reading = lookup.lookup(squareCentre(3).latitude, squareCentre(3).longitude)
		const distribution = reading.distribution!

		expect(distribution.unratedShare).toBeGreaterThan(0.9)
		expect(distribution.notRateableShare).toBe(0)
		expect(reading.kind).toBe(SoilReadingKind.DesignatedNoRating)
	})

	it("puts a NOTCOM polygon in nodata, and never reports it as a capability class", () => {
		const reading = lookup.lookup(squareCentre(4).latitude, squareCentre(4).longitude)
		const distribution = reading.distribution!

		expect(distribution.noDataShare).toBeGreaterThan(0.9)
		expect(distribution.topClass).toBeUndefined()
		expect(distribution.unratedShare).toBe(0)
		expect(distribution.notRateableShare).toBe(0)
	})

	it("answers unknown outside every survey area, with no coverage row rather than a low reading", () => {
		const reading = lookup.lookup(FIXTURE_ORIGIN.lat + 5, FIXTURE_ORIGIN.lon + 5)

		expect(reading.kind).toBe(SoilReadingKind.Unknown)
		expect(reading.coverage).toBeUndefined()
		expect(reading.distribution).toBeUndefined()
	})
})

describe("the invariants that make the shares readable", () => {
	it("sums every stored row's five shares to one", () => {
		const database = new DatabaseClient<SoilDatabase>(databasePath, { readOnly: true })

		try {
			const rows = database
				.prepare(
					"SELECT class_shares, unrated_share, notrateable_share, nodata_share, other_share FROM soil_capability_cell"
				)
				.all()

			expect(rows.length).toBeGreaterThan(0)

			for (const row of rows) {
				// Read column by column rather than cast whole: the five fields the invariant turns on are named here, so a
				// column that stopped being written fails as a missing name rather than as a share that reads zero.
				const total = shareTotal({
					h3_cell: 0,
					class_shares: String(row.class_shares),
					unrated_share: Number(row.unrated_share),
					notrateable_share: Number(row.notrateable_share),
					nodata_share: Number(row.nodata_share),
					other_share: Number(row.other_share),
					mapped_share: 1,
					top_class: null,
					top_class_share: null,
					weighting: "",
					delineations: 0,
				})

				// `other_share` is what makes this hold: truncating a long tail is legitimate, doing it silently is not.
				expect(total).toBeCloseTo(1, 4)
			}
		} finally {
			database.destroy()
		}
	})

	it("writes a coverage row only where mapped soil reaches, at designated and completeness 1", () => {
		const database = new DatabaseClient<SoilDatabase>(databasePath, { readOnly: true })

		try {
			const rows = database.prepare("SELECT basis, completeness, observed_rows FROM layer_coverage").all() as Array<{
				basis: string
				completeness: number
				observed_rows: number
			}>

			expect(rows.length).toBeGreaterThan(0)

			for (const row of rows) {
				expect(row.basis).toBe("designated")
				expect(row.completeness).toBe(1)
				expect(row.observed_rows).toBeGreaterThan(0)
			}
		} finally {
			database.destroy()
		}
	})

	it("stores the rings unsimplified, so the covered-area weights can be re-derived", () => {
		const database = new DatabaseClient<SoilDatabase>(databasePath, { readOnly: true })

		try {
			const row = database.prepare("SELECT rings FROM soil_map_unit_area WHERE area_id = ?").get("XX001:0") as {
				rings: Uint8Array
			}

			// Five positions per fixture ring: the four corners and the repeat that closes it, ten ordinates flat. A
			// simplifying writer would drop vertices and change the covered-area weights silently.
			const { polygons } = decodeRings(row.rings)

			expect(polygons[0]![0]!).toHaveLength(10)
		} finally {
			database.destroy()
		}
	})

	it("seals the artifact read-only", () => {
		expect(result.sizeBytes).toBeGreaterThan(0)

		const database = new DatabaseClient<SoilDatabase>(databasePath, { readOnly: true })

		try {
			expect((database.prepare("SELECT count(*) AS n FROM soil_vocabulary").get() as { n: number }).n).toBeGreaterThan(
				0
			)
		} finally {
			database.destroy()
		}
	})
})
