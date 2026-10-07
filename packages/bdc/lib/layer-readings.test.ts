/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Two fixture builds stand for two vintages of one state's files. Each build loads cable and fiber to
 *   the premises: the filed block holds cable rows, and a neighbor block in the same res-6 cell holds a
 *   fiber row. Three more blocks reach no build: one a resolver places in the covered cell, one it
 *   places in an uncovered cell, and one it cannot place.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode } from "@mailwoman/core/fs/writers"
import { readLayerCoverage } from "@mailwoman/core/layers"
import { buildDossier, classifyReading, type DossierRecords, type LayerReading } from "@mailwoman/dossier"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { blockCentroidCells, geoidCellResolver } from "#filing/landscape"
import { bdcLayerReadings, bdcTechnologyLayer } from "#layer-readings"
import type { BDCDatabase } from "#schema"
import { buildBDCDatabase } from "#sdk/build-bdc"
import type { BDCAvailabilityRow } from "#sdk/parsing"

const BUILDING = "building:example-tower"
const CABLE = 40
const FTTP = 50

const GEOID_FILED = "360610001001001"
const GEOID_NEIGHBOR = "360610001001002"
const GEOID_EMPTY = "360610001009999"
const GEOID_FAR = "170310001001001"
const GEOID_UNPLACED = "360610001008888"

const CENTROIDS: Record<string, { lat: number; lon: number }> = {
	[GEOID_FILED]: { lat: 40.7128, lon: -74.006 },
	[GEOID_NEIGHBOR]: { lat: 40.7178, lon: -74.006 },
	[GEOID_EMPTY]: { lat: 40.7153, lon: -74.006 },
	[GEOID_FAR]: { lat: 41.8781, lon: -87.6298 },
}

/**
 * The centroid source both builds and the resolver read, as a TIGER lookup would serve them.
 */
function blockCentroids(geoid: string): { lat: number; lon: number } | null {
	return CENTROIDS[geoid] ?? null
}

const resolveGeoidCell = geoidCellResolver(blockCentroids)

function availabilityRow(
	geoid: string,
	providerID: number,
	technologyCode: number,
	download: number,
	upload: number
): BDCAvailabilityRow {
	return {
		geoid,
		provider_id: providerID,
		technology_code: technologyCode,
		location_id: `${geoid}-${providerID}-${technologyCode}-${download}`,
		max_advertised_download_speed: download,
		max_advertised_upload_speed: upload,
		low_latency: 1,
		business_residential_code: "R",
	}
}

// The filed block's two cable providers fall in two speed buckets, so its cable reading counts two summaries.
const J22_ROWS = [
	availabilityRow(GEOID_FILED, 130_001, CABLE, 1000, 35),
	availabilityRow(GEOID_FILED, 130_002, CABLE, 300, 20),
	availabilityRow(GEOID_NEIGHBOR, 130_003, FTTP, 1000, 1000),
]

const D25_ROWS = [
	availabilityRow(GEOID_FILED, 130_001, CABLE, 1000, 35),
	availabilityRow(GEOID_FILED, 130_003, FTTP, 2300, 2300),
	availabilityRow(GEOID_NEIGHBOR, 130_003, FTTP, 1000, 1000),
]

let scratch: TemporaryDirectory
let j22: PathBuilder
let d25: PathBuilder

beforeAll(async () => {
	scratch = await temporaryDirectory("bdc-layer-readings-")
	j22 = scratch.path("bdc-j22.db")
	d25 = scratch.path("bdc-d25.db")

	await buildBDCDatabase({ rows: J22_ROWS, out: j22, asOfDate: "2022-06-30", buildSHA: "deadbeef", blockCentroids })
	await buildBDCDatabase({ rows: D25_ROWS, out: d25, asOfDate: "2025-12-31", buildSHA: "deadbeef", blockCentroids })
})

afterAll(() => scratch[Symbol.asyncDispose]())

function openBuild(path: PathBuilder): DatabaseClient<BDCDatabase> {
	return new DatabaseClient<BDCDatabase>(path, { readOnly: true })
}

function recordsWith(readings: LayerReading[]): DossierRecords {
	return {
		sources: [
			{
				id: "fcc-bdc-j22",
				publisher: "Federal Communications Commission",
				title: "BDC fixed broadband availability as of 2022-06-30",
				observedAt: "2022-06-30",
				availableAt: "2022-11-18",
				url: null,
				retrievedAt: null,
			},
			{
				id: "fcc-bdc-d25",
				publisher: "Federal Communications Commission",
				title: "BDC fixed broadband availability as of 2025-12-31",
				observedAt: "2025-12-31",
				availableAt: "2026-09-29",
				url: null,
				retrievedAt: null,
			},
		],
		entities: [{ id: BUILDING, kind: "building", externalIDs: [], label: "Example Tower" }],
		aliases: [],
		containment: [],
		claims: [],
		counts: [],
		events: [],
		relations: [],
		windows: [],
		availability: [],
		readings,
		filings: [],
	}
}

describe("bdcTechnologyLayer", () => {
	it("names the cable and fiber-to-the-premises layers and refuses a code without a layer name", () => {
		expect(bdcTechnologyLayer(CABLE)).toBe("fcc-bdc-cable")
		expect(bdcTechnologyLayer(FTTP)).toBe("fcc-bdc-fttp")
		expect(() => bdcTechnologyLayer(60)).toThrow(/no dossier layer name/)
	})
})

describe("bdcLayerReadings", () => {
	it("reads a block with rows as one reading per technology, counting that technology's filing summaries", async () => {
		using db = openBuild(j22)

		const readings = await bdcLayerReadings(db, {
			subject: BUILDING,
			geoid: GEOID_FILED,
			technologyCodes: [CABLE, FTTP],
			source: "fcc-bdc-j22",
			resolveGeoidCell,
		})

		expect(readings).toEqual([
			{
				layer: "fcc-bdc-cable",
				extent: `census-block:${GEOID_FILED}`,
				subject: BUILDING,
				basis: "source_present",
				surveyedAt: "2022-06-30",
				records: 2,
				evidence: { source: "fcc-bdc-j22", observedAt: null, validFrom: null, validTo: null },
			},
			{
				layer: "fcc-bdc-fttp",
				extent: `census-block:${GEOID_FILED}`,
				subject: BUILDING,
				basis: "source_present",
				surveyedAt: "2022-06-30",
				records: 0,
				evidence: { source: "fcc-bdc-j22", observedAt: null, validFrom: null, validTo: null },
			},
		])

		expect(readings.map(classifyReading)).toEqual(["records", "source_present_empty"])
	})

	it("reads a covered block with no rows as surveyed with zero records", async () => {
		expect(blockCentroidCells(CENTROIDS[GEOID_EMPTY]!).coverageCell).toBe(
			blockCentroidCells(CENTROIDS[GEOID_FILED]!).coverageCell
		)

		using db = openBuild(j22)

		const readings = await bdcLayerReadings(db, {
			subject: BUILDING,
			geoid: GEOID_EMPTY,
			technologyCodes: [CABLE, FTTP],
			source: "fcc-bdc-j22",
			resolveGeoidCell,
		})

		expect(readings.map((reading) => [reading.layer, reading.basis, reading.records])).toEqual([
			["fcc-bdc-cable", "source_present", 0],
			["fcc-bdc-fttp", "source_present", 0],
		])

		expect(readings.map(classifyReading)).toEqual(["source_present_empty", "source_present_empty"])
	})

	it("reads the same covered block as unknown when the caller passes no resolver", async () => {
		using db = openBuild(j22)

		const readings = await bdcLayerReadings(db, {
			subject: BUILDING,
			geoid: GEOID_EMPTY,
			technologyCodes: [CABLE],
			source: "fcc-bdc-j22",
		})

		expect(readings.map((reading) => [reading.basis, reading.records])).toEqual([[null, null]])
		expect(readings.map(classifyReading)).toEqual(["unknown"])
	})

	it("reads a block the resolver cannot place as unknown", async () => {
		using db = openBuild(j22)

		const readings = await bdcLayerReadings(db, {
			subject: BUILDING,
			geoid: GEOID_UNPLACED,
			technologyCodes: [CABLE, FTTP],
			source: "fcc-bdc-j22",
			resolveGeoidCell,
		})

		expect(readings.map((reading) => [reading.layer, reading.basis, reading.records])).toEqual([
			["fcc-bdc-cable", null, null],
			["fcc-bdc-fttp", null, null],
		])
	})

	it("reads a block whose res-6 cell has no coverage row as unknown", async () => {
		using db = openBuild(j22)

		expect(await readLayerCoverage(db, blockCentroidCells(CENTROIDS[GEOID_FAR]!).coverageCell)).toBeNull()

		const readings = await bdcLayerReadings(db, {
			subject: BUILDING,
			geoid: GEOID_FAR,
			technologyCodes: [CABLE],
			source: "fcc-bdc-j22",
			resolveGeoidCell,
		})

		expect(readings).toEqual([
			{
				layer: "fcc-bdc-cable",
				extent: `census-block:${GEOID_FAR}`,
				subject: BUILDING,
				basis: null,
				surveyedAt: "2022-06-30",
				records: null,
				evidence: { source: "fcc-bdc-j22", observedAt: null, validFrom: null, validTo: null },
			},
		])
	})

	it("stamps each build's vintage, and the dossier keeps two vintages of one layer and block apart", async () => {
		using j22DB = openBuild(j22)
		using d25DB = openBuild(d25)

		const query = { subject: BUILDING, geoid: GEOID_FILED, technologyCodes: [FTTP], resolveGeoidCell }

		const readings = [
			...(await bdcLayerReadings(j22DB, { ...query, source: "fcc-bdc-j22" })),
			...(await bdcLayerReadings(d25DB, { ...query, source: "fcc-bdc-d25" })),
		]

		expect(readings.map((reading) => [reading.surveyedAt, reading.records])).toEqual([
			["2022-06-30", 0],
			["2025-12-31", 1],
		])

		const [section] = buildDossier(recordsWith(readings), { asOf: "2026-10-05" }).buildings

		expect(section!.readings).toEqual([
			{
				layer: "fcc-bdc-fttp",
				extent: `census-block:${GEOID_FILED}`,
				surveyedAt: "2022-06-30",
				class: "source_present_empty",
				sources: ["fcc-bdc-j22"],
			},
			{
				layer: "fcc-bdc-fttp",
				extent: `census-block:${GEOID_FILED}`,
				surveyedAt: "2025-12-31",
				class: "records",
				sources: ["fcc-bdc-d25"],
			},
		])
	})

	it("throws when the database has no manifest rather than returning a reading", async () => {
		await using corruptScratch = await temporaryDirectory("bdc-layer-readings-corrupt-")
		const corruptOut = corruptScratch.path("bdc.db")

		await buildBDCDatabase({
			rows: J22_ROWS,
			out: corruptOut,
			asOfDate: "2022-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
		})

		await changeMode(corruptOut, 0o644)

		using writable = await openBuiltClient<BDCDatabase>(corruptOut, { write: true })

		await writable.deleteFrom("layer_manifest").execute()

		await expect(
			bdcLayerReadings(writable, {
				subject: BUILDING,
				geoid: GEOID_FILED,
				technologyCodes: [CABLE],
				source: "fcc-bdc-j22",
				resolveGeoidCell,
			})
		).rejects.toThrow(/manifest/)
	})

	it("refuses an empty technology list, a code without a layer name and a GEOID that is not a block", async () => {
		using db = openBuild(j22)

		const query = { subject: BUILDING, geoid: GEOID_FILED, source: "fcc-bdc-j22" }

		await expect(bdcLayerReadings(db, { ...query, technologyCodes: [] })).rejects.toThrow(/at least one/)
		await expect(bdcLayerReadings(db, { ...query, technologyCodes: [CABLE, 60] })).rejects.toThrow(/60/)

		await expect(bdcLayerReadings(db, { ...query, geoid: "36061000100", technologyCodes: [CABLE] })).rejects.toThrow(
			/15 digits/
		)
	})
})
