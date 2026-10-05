/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { buildDossier, classifyReading, type DossierRecords } from "@mailwoman/dossier"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { FloodZoneLookup } from "#index"
import { floodLayerReading } from "#layer-readings"
import { buildFloodDatabase } from "#sdk/build-flood"
import { realizeFloodMapExtent } from "#sdk/extent"
import { fixtureExtentGeometry, fixtureFeatures, fixtureSource, FIXTURE_ORIGIN, FIXTURE_SIDE } from "#sdk/test-kit"
import { EA_COVERAGE_STATEMENT, EA_COVERAGE_STATEMENT_URL, EA_FLOOD_LAYER_NAME } from "#vocabulary"

const COVERAGE_RESOLUTION = 6
const VINTAGE = "2026-05-20"
const SOURCE = "ea-flood-map-2026-05-20"

const ZONE_3 = { latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2, longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE / 2 }
const ZONE_2 = { latitude: FIXTURE_ORIGIN.lat + FIXTURE_SIDE / 2, longitude: FIXTURE_ORIGIN.lon + FIXTURE_SIDE * 1.5 }
const INSIDE_FOOTPRINT = { latitude: FIXTURE_ORIGIN.lat + 0.2, longitude: FIXTURE_ORIGIN.lon + 0.2 }
const OUTSIDE_FOOTPRINT = { latitude: FIXTURE_ORIGIN.lat + 5, longitude: FIXTURE_ORIGIN.lon + 5 }

let scratch: TemporaryDirectory
let lookup: FloodZoneLookup

beforeAll(async () => {
	scratch = await temporaryDirectory("flood-layer-readings-")

	const databasePath = scratch.path("flood.db")

	await buildFloodDatabase({
		source: fixtureSource(fixtureFeatures()),
		out: databasePath,
		sourceVintage: VINTAGE,
		buildCmd: "vitest",
		buildSHA: "fixture",
		createdAt: "2026-08-28T00:00:00.000Z",
		indexResolution: 9,
		coverageResolution: COVERAGE_RESOLUTION,
		extent: realizeFloodMapExtent({
			geometry: fixtureExtentGeometry(),
			coverageResolution: COVERAGE_RESOLUTION,
			authority: "Environment Agency",
			statement: EA_COVERAGE_STATEMENT,
			statementURL: EA_COVERAGE_STATEMENT_URL,
		}),
	})

	lookup = new FloodZoneLookup({ databasePath })
})

afterAll(async () => {
	lookup[Symbol.dispose]()
	await scratch[Symbol.asyncDispose]()
})

describe("floodLayerReading", () => {
	it("reads a designated zone as one record and a designated claim carrying the zone code", () => {
		const { reading, claim } = floodLayerReading(lookup, { subject: "building:riverside", ...ZONE_3, source: SOURCE })

		expect(reading).toEqual({
			layer: EA_FLOOD_LAYER_NAME,
			extent: `point:${ZONE_3.latitude},${ZONE_3.longitude}`,
			subject: "building:riverside",
			basis: "designated",
			surveyedAt: VINTAGE,
			records: 1,
			evidence: { source: SOURCE },
		})

		expect(classifyReading(reading)).toBe("records")

		expect(claim).toEqual({
			id: `${EA_FLOOD_LAYER_NAME}:building:riverside:${VINTAGE}`,
			subject: "building:riverside",
			axis: "premises",
			predicate: "flood_zone",
			value: "FZ3",
			status: "designated",
			evidence: { source: SOURCE },
		})
	})

	it("carries the adjacent square's zone code verbatim", () => {
		const { claim } = floodLayerReading(lookup, { subject: "building:riverside", ...ZONE_2, source: SOURCE })

		expect(claim?.value).toBe("FZ2")
	})

	it("reads a designated absence as zero records on the coverage row's basis, with a Zone 1 claim", () => {
		const { reading, claim } = floodLayerReading(lookup, {
			subject: "building:upland",
			...INSIDE_FOOTPRINT,
			source: SOURCE,
		})

		expect(reading).toMatchObject({ basis: "designated", records: 0, surveyedAt: VINTAGE })
		expect(classifyReading(reading)).toBe("surveyed_empty")
		expect(claim).toMatchObject({ predicate: "flood_zone", value: "FZ1", status: "designated" })
	})

	it("reads a coordinate outside the footprint as unknown, with no claim", () => {
		const { reading, claim } = floodLayerReading(lookup, {
			subject: "building:offshore",
			...OUTSIDE_FOOTPRINT,
			source: SOURCE,
		})

		expect(reading).toMatchObject({ basis: null, records: null, surveyedAt: VINTAGE })
		expect(classifyReading(reading)).toBe("unknown")
		expect(claim).toBeUndefined()
	})

	it("attaches each building's reading and claim to that building in the dossier", () => {
		const riverside = floodLayerReading(lookup, { subject: "building:riverside", ...ZONE_3, source: SOURCE })
		const offshore = floodLayerReading(lookup, { subject: "building:offshore", ...OUTSIDE_FOOTPRINT, source: SOURCE })

		const records: DossierRecords = {
			sources: [
				{
					id: SOURCE,
					publisher: "Environment Agency",
					title: "Flood Map for Planning",
					observedAt: VINTAGE,
					availableAt: VINTAGE,
				},
			],
			entities: [
				{ id: "building:riverside", kind: "building", externalIDs: [], label: "Riverside" },
				{ id: "building:offshore", kind: "building", externalIDs: [], label: "Offshore" },
			],
			aliases: [],
			containment: [],
			claims: [riverside.claim!],
			counts: [],
			events: [],
			relations: [],
			windows: [],
			availability: [],
			readings: [riverside.reading, offshore.reading],
			filings: [],
		}

		const sections = buildDossier(records, { asOf: "2026-10-05" }).buildings

		expect(sections.map((section) => [section.building.id, section.readings.map((reading) => reading.class)])).toEqual([
			["building:riverside", ["records"]],
			["building:offshore", ["unknown"]],
		])

		expect(sections.map((section) => section.claims.map((claim) => claim.value))).toEqual([["FZ3"], []])
	})
})
