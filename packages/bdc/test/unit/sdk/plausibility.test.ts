import type { BDCDatabase } from "@mailwoman/bdc/schema"
import { buildBDCDatabase } from "@mailwoman/bdc/sdk/build-bdc"
import { res9ShortCellToRes6Parent } from "@mailwoman/bdc/sdk/filing-landscape"
import type { BDCAvailabilityRow } from "@mailwoman/bdc/sdk/parsing"
import {
	PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES,
	physicalCategoriesForTechnology,
	plausibilityCheck,
	type GeocodeLike,
	type PlausibilityAbstainReason,
	type PlausibilityBundle,
	type PlausibilityCoverageAxisState,
	type PlausibilityDeps,
	type PlausibilityEvidence,
} from "@mailwoman/bdc/sdk/plausibility"
import { BroadbandTechnologyCode } from "@mailwoman/bdc/sdk/technologies"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	writeLayerCoverage,
	writeLayerManifest,
	type layerschemadatabase,
} from "@mailwoman/core/layers"
import {
	POILookup,
	createPOIBrandIndex,
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street"
import { shortCellToInt, type H3Cell, type PointLiteral } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToChildren, cellToLatLng, cellToParent, latLngToCell } from "h3-js"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

const ASOF_DATE = "2026-07-30"

const SPRINGFIELD = { latitude: 39.7817, longitude: -89.6501 }

const SPRINGFIELD_POINT: PointLiteral = {
	type: "Point",
	coordinates: [SPRINGFIELD.longitude, SPRINGFIELD.latitude],
}

const SPRINGFIELD_RES9_FULL = latLngToCell(SPRINGFIELD.latitude, SPRINGFIELD.longitude, 9) as H3Cell
const SPRINGFIELD_RES9_SHORT = shortCellToInt(SPRINGFIELD_RES9_FULL)
const SPRINGFIELD_RES6_PARENT_FULL = cellToParent(SPRINGFIELD_RES9_FULL, 6) as H3Cell
const SPRINGFIELD_RES6_PARENT_SHORT = res9ShortCellToRes6Parent(SPRINGFIELD_RES9_SHORT)

const SPRINGFIELD_SIBLING_RES9_FULL = cellToChildren(SPRINGFIELD_RES6_PARENT_FULL, 9).find(
	(cell) => cell !== SPRINGFIELD_RES9_FULL
) as H3Cell

const [SIBLING_LAT, SIBLING_LON] = cellToLatLng(SPRINGFIELD_SIBLING_RES9_FULL)
const SIBLING_POINT: PointLiteral = { type: "Point", coordinates: [SIBLING_LON, SIBLING_LAT] }

const GEOID_SPRINGFIELD = "170010001001001"
const PROVIDER_FIBER = 130_001
const PROVIDER_DSL = 130_002

const SPRINGFIELD_CENTROID = { lat: SPRINGFIELD.latitude, lon: SPRINGFIELD.longitude }

function blockCentroids(geoid: string): { lat: number; lon: number } | undefined {
	return geoid === GEOID_SPRINGFIELD ? SPRINGFIELD_CENTROID : undefined
}

function fixtureRows(): BDCAvailabilityRow[] {
	return [
		{
			geoid: GEOID_SPRINGFIELD,
			provider_id: PROVIDER_FIBER,
			technology_code: BroadbandTechnologyCode.OpticalCarrierFiber,
			location_id: "SPR-FIBER",
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 1,
			business_residential_code: "R",
		},
		{
			geoid: GEOID_SPRINGFIELD,
			provider_id: PROVIDER_DSL,
			technology_code: BroadbandTechnologyCode.AsymmetricXDSL,
			location_id: "SPR-DSL",
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 0,
			business_residential_code: "R",
		},
	]
}

type BDCFixture = TemporaryDirectory & { db: DatabaseClient<BDCDatabase> }

async function buildBDCFixture(): Promise<BDCFixture> {
	await using fixture = await temporaryDirectory("bdc-plausibility-bdc-")
	const out = fixture.path("bdc.db")

	await buildBDCDatabase({
		rows: fixtureRows(),
		out,
		asOfDate: ASOF_DATE,
		buildSHA: "deadbeef",
		blockCentroids,
	})

	return fixture.moveWith({ db: fixture.use(new DatabaseClient<BDCDatabase>(out, { readOnly: true })) })
}

interface POIFixtureRow {
	name: string
	category: string
	latitude: number
	longitude: number
	confidence?: number
}

const TELECOM_EXCHANGE_NEAR: POIFixtureRow = {
	name: "Central Office 12",
	category: "telecom_exchange",
	latitude: 39.782,
	longitude: -89.6501,
	confidence: 0.92,
}

const CATEGORY_IDS: Record<string, number> = { telecom_exchange: 1, tower_comms: 2, data_center: 3, cafe: 4 }

function cellFor(latitude: number, longitude: number): number {
	return shortCellToInt(latLngToCell(latitude, longitude, 9) as H3Cell)
}

type POIFixture = TemporaryDirectory & { databasePath: PathBuilder }

async function buildPOILookupFixture(rows: readonly POIFixtureRow[]): Promise<POIFixture> {
	await using scratch = await temporaryDirectory("bdc-plausibility-poi-")
	const databasePath = scratch.path("poi.db")

	using kdb = new DatabaseClient<POIDatabase>(databasePath)

	await createPOITable(kdb)
	await createPOIStagingTables(kdb)
	createPOISearchFTS(kdb)

	for (const [category, id] of Object.entries(CATEGORY_IDS)) {
		await kdb.insertInto("poi_category_codes").values({ id, category }).execute()
	}

	let rowidKey = 1

	for (const row of rows) {
		const confidence = row.confidence ?? 0.9

		await kdb
			.insertInto("poi")
			.values({
				h3_cell: cellFor(row.latitude, row.longitude),
				category_id: CATEGORY_IDS[row.category] ?? 0,
				neg_rank: 1 - confidence,
				rowid_key: rowidKey++,
				name: row.name,
				name_key: normalizeLocalityForKey(row.name),
				brand_wikidata: null,
				latitude: row.latitude,
				longitude: row.longitude,
				country: "US",
				confidence,
				gers_id: null,
			})
			.execute()
	}

	await createPOINameKeyIndex(kdb)
	await createPOIBrandIndex(kdb)

	return scratch.moveWith({ databasePath })
}

async function openpoischemadb(resolutionOverride = 9): Promise<DatabaseClient<layerschemadatabase>> {
	const kdb = DatabaseClient.temp<layerschemadatabase>()

	await createLayerManifestTable(kdb)
	await createLayerCoverageTable(kdb)

	await writeLayerManifest(kdb, {
		name: "test-poi-layer",
		version: "0.0.0-test",
		schemaVersion: 1,
		tier: "build-local",
		license: "ODbL-1.0",
		source: "test-fixture",
		sourceVintage: ASOF_DATE,
		buildCmd: "test",
		buildSHA: "deadbeef",
		freshnessPolicy: "sealed",
		spineKeys: { h3: { column: "h3_cell", resolution: resolutionOverride } },
		createdAt: `${ASOF_DATE}T00:00:00Z`,
	})

	return kdb
}

async function openBoth(): Promise<AsyncDisposableStack & { deps: PlausibilityDeps }> {
	const stack = new AsyncDisposableStack()
	const bdc = stack.use(await buildBDCFixture())
	const poi = stack.use(await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR]))
	const poischemadb = stack.use(await openpoischemadb())
	const poiLookup = stack.use(new POILookup({ databasePath: poi.databasePath }))

	await writeLayerCoverage(poischemadb, [{ h3Cell: SPRINGFIELD_RES6_PARENT_SHORT, completeness: 1, observedRows: 1 }])

	return Object.assign(stack, {
		deps: { bdcDB: bdc.db, poi: { lookup: poiLookup, schemadb: poischemadb } },
	})
}

describe("physicalCategoriesForTechnology / PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES", () => {
	it("maps fiber to the three infra categories", () => {
		expect(physicalCategoriesForTechnology(BroadbandTechnologyCode.OpticalCarrierFiber)).toEqual([
			"telecom_exchange",
			"telecom_cabinet",
			"data_center",
		])
	})

	it.each([
		["Unlicensed", BroadbandTechnologyCode.UnlicensedTerrestrialFixedWireless],
		["Licensed", BroadbandTechnologyCode.LicensedTerrestrialFixedWireless],
		["LicensedByRule", BroadbandTechnologyCode.LicensedByRuleTerrestrialFixedWireless],
	])("maps the %s fixed-wireless code to tower_comms", (_label, code) => {
		expect(physicalCategoriesForTechnology(code)).toEqual(["tower_comms"])
	})

	it("maps every other tech code to [] — no physical falsifier claimed", () => {
		expect(physicalCategoriesForTechnology(BroadbandTechnologyCode.AsymmetricXDSL)).toEqual([])
		expect(physicalCategoriesForTechnology(BroadbandTechnologyCode.CableModemDOCSIS3)).toEqual([])
		expect(physicalCategoriesForTechnology(BroadbandTechnologyCode.GeostationarySatellite)).toEqual([])
		expect(physicalCategoriesForTechnology(BroadbandTechnologyCode.ElectricPowerLine)).toEqual([])
		expect(physicalCategoriesForTechnology(999)).toEqual([])
	})

	it("the exported table has exactly the four mapped codes", () => {
		expect(
			Object.keys(PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES)
				.map(Number)
				.toSorted((a, b) => a - b)
		).toEqual([50, 70, 71, 72])
	})
})

describe("plausibilityCheck — claim resolution", () => {
	it("throws when the claim has none of geoid/point/address", async () => {
		await expect(
			plausibilityCheck({ technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 100 }, {})
		).rejects.toThrow(/geoid.*point.*address/i)
	})

	it("throws when claim.address is given without deps.geocode", async () => {
		await expect(
			plausibilityCheck(
				{
					address: "123 Main St, Springfield, IL",
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 100,
				},
				{}
			)
		).rejects.toThrow(/deps\.geocode/)
	})

	it("throws when geocode resolves no coordinate for the address", async () => {
		const geocode = async (): Promise<GeocodeLike> => ({ lat: null, lon: null })

		await expect(
			plausibilityCheck(
				{
					address: "nowhere",
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 100,
				},
				{ geocode }
			)
		).rejects.toThrow(/could not resolve a coordinate/)
	})

	it("block_resolution is 'geoid' for a geoid claim and 'h3_cell_approximation' for a point claim", async () => {
		const byGeoid = await plausibilityCheck(
			{ geoid: GEOID_SPRINGFIELD, technologyCode: BroadbandTechnologyCode.AsymmetricXDSL, claimedDownloadMbps: 10 },
			{}
		)

		expect(byGeoid.block_resolution).toBe("geoid")

		const byPoint = await plausibilityCheck(
			{
				point: SPRINGFIELD_POINT,
				technologyCode: BroadbandTechnologyCode.AsymmetricXDSL,
				claimedDownloadMbps: 10,
			},
			{}
		)

		expect(byPoint.block_resolution).toBe("h3_cell_approximation")
	})

	it("geocodes an address claim and resolves it through the point path", async () => {
		const geocode = async (address: string): Promise<GeocodeLike> => {
			expect(address).toBe("123 Main St, Springfield, IL")

			return { lat: SPRINGFIELD.latitude, lon: SPRINGFIELD.longitude }
		}

		const bundle = await plausibilityCheck(
			{
				address: "123 Main St, Springfield, IL",
				technologyCode: BroadbandTechnologyCode.AsymmetricXDSL,
				claimedDownloadMbps: 10,
			},
			{ geocode }
		)

		expect(bundle.block_resolution).toBe("h3_cell_approximation")
	})
})

describe("plausibilityCheck — bdc layer absent/insufficient (decision 6)", () => {
	it("abstains requires_bdc_layer and leaves vintage null when deps.bdcDB is absent", async () => {
		const bundle = await plausibilityCheck(
			{
				point: SPRINGFIELD_POINT,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 100,
			},
			{}
		)

		expect(bundle.vintage).toBeNull()
		expect(bundle.evidence_found).toContainEqual({ type: "abstain", reason: "requires_bdc_layer", layer: "bdc" })
		expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(false)

		expect(bundle.coverage_detail.filing).toBe("layer_missing")
	})

	it("abstains insufficient_survey_data (not requires_bdc_layer) when bdc.db is open but this exact cell was never surveyed, and vintage IS populated", async () => {
		await using bdc = await buildBDCFixture()

		const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }

		const bundle = await plausibilityCheck(
			{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 100 },
			{ bdcDB: bdc.db }
		)

		expect(bundle.vintage).toBe(ASOF_DATE)

		expect(bundle.evidence_found).toContainEqual({
			type: "abstain",
			reason: "insufficient_survey_data",
			layer: "bdc",
		})

		expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(false)

		expect(bundle.coverage_detail.filing).toBe("cell_unsurveyed")
	})
})

describe("plausibilityCheck — filing evidence + corroboration", () => {
	it("emits one filing entry per provider row, corroborates true for a matching tech/speed and false for a different tech", async () => {
		await using bdc = await buildBDCFixture()

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			{ bdcDB: bdc.db }
		)

		const filingEntries = bundle.evidence_found.filter((e) => e.type === "filing")
		expect(filingEntries).toHaveLength(2)

		const fiberEntry = filingEntries.find((e) => e.filing.provider_id === PROVIDER_FIBER)!
		expect(fiberEntry.corroborates).toBe(true)
		expect(fiberEntry.vintage).toBe(ASOF_DATE)

		const dslEntry = filingEntries.find((e) => e.filing.provider_id === PROVIDER_DSL)!
		expect(dslEntry.corroborates).toBe(false)

		expect(filingEntries.every((e) => e.type === "filing")).toBe(true)
	})

	it("corroborates false for a same-tech but LESSER speed filing", async () => {
		await using scratch = await temporaryDirectory("bdc-plausibility-lesser-")
		const out = scratch.path("bdc.db")

		await buildBDCDatabase({
			rows: [
				{
					geoid: GEOID_SPRINGFIELD,
					provider_id: PROVIDER_FIBER,
					technology_code: BroadbandTechnologyCode.OpticalCarrierFiber,
					location_id: "SPR-FIBER-SLOW",
					max_advertised_download_speed: 50,
					max_advertised_upload_speed: 50,
					low_latency: 1,
					business_residential_code: "R",
				},
			],
			out,
			asOfDate: ASOF_DATE,
			buildSHA: "deadbeef",
			blockCentroids,
		})

		const inlineDB = scratch.use(new DatabaseClient<BDCDatabase>(out, { readOnly: true }))

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			{ bdcDB: inlineDB }
		)

		const filingEntries = bundle.evidence_found.filter((e) => e.type === "filing")
		expect(filingEntries).toHaveLength(1)
		expect(filingEntries[0]!.corroborates).toBe(false)
	})

	it("positive absence: a covered res-6 parent with zero filings in the queried res-9 cell emits no filing evidence, and still counts as covered", async () => {
		await using bdc = await buildBDCFixture()

		expect(SPRINGFIELD_SIBLING_RES9_FULL).not.toBe(SPRINGFIELD_RES9_FULL)
		expect(res9ShortCellToRes6Parent(shortCellToInt(SPRINGFIELD_SIBLING_RES9_FULL))).toBe(SPRINGFIELD_RES6_PARENT_SHORT)

		const bundle = await plausibilityCheck(
			{ point: SIBLING_POINT, technologyCode: BroadbandTechnologyCode.AsymmetricXDSL, claimedDownloadMbps: 10 },
			{ bdcDB: bdc.db }
		)

		expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(false)
		expect(bundle.evidence_found.some((e) => e.type === "abstain")).toBe(false)

		expect(bundle.coverage_confidence).toBe("low")

		expect(bundle.coverage_detail).toEqual({ filing: "covered", physical: "not_applicable" })
	})
})

describe("plausibilityCheck — physical evidence + poi layer absence (decision 6)", () => {
	it("abstains requires_build_local_layer when the tech implies a physical category but deps.poi is absent", async () => {
		const bundle = await plausibilityCheck(
			{
				point: SPRINGFIELD_POINT,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 100,
			},
			{}
		)

		expect(bundle.evidence_found).toContainEqual({
			type: "abstain",
			reason: "requires_build_local_layer",
			layer: "poi",
		})

		expect(bundle.coverage_detail.physical).toBe("layer_missing")
	})

	it("never abstains on poi for a tech with no physical falsifier, even when deps.poi is absent", async () => {
		const bundle = await plausibilityCheck(
			{ point: SPRINGFIELD_POINT, technologyCode: BroadbandTechnologyCode.AsymmetricXDSL, claimedDownloadMbps: 10 },
			{}
		)

		expect(bundle.evidence_found.some((e) => e.type === "abstain" && e.reason === "requires_build_local_layer")).toBe(
			false
		)

		expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(false)

		expect(bundle.coverage_detail.physical).toBe("not_applicable")
	})

	it("A geoid-only claim (no point/address) skips physical evidence entirely — neither abstain nor entry — even with deps.poi present", async () => {
		await using poi = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		using poischemadb = await openpoischemadb()
		using poiLookup = new POILookup({ databasePath: poi.databasePath })

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 100,
			},
			{ poi: { lookup: poiLookup, schemadb: poischemadb } }
		)

		expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(false)

		expect(bundle.evidence_found.some((e) => e.type === "abstain" && e.reason === "requires_build_local_layer")).toBe(
			false
		)

		expect(bundle.coverage_detail.physical).toBe("no_coordinate")
	})
})

describe("plausibilityCheck — full composition (both layers present)", () => {
	it("co-presence: matching filing + nearby plant, both covered -> high confidence, both evidence kinds present", async () => {
		await using both = await openBoth()
		const { deps } = both

		const bundle = await plausibilityCheck(
			{
				point: SPRINGFIELD_POINT,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			deps
		)

		expect(bundle.coverage_confidence).toBe("high")
		expect(bundle.coverage_detail).toEqual({ filing: "covered", physical: "covered" })
		expect(bundle.evidence_found.some((e) => e.type === "filing" && e.corroborates)).toBe(true)
		expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(true)
		expect(bundle.evidence_found.some((e) => e.type === "abstain")).toBe(false)
	})

	it("both axes unknown (remote, unsurveyed-by-either point) -> insufficient_survey_data", async () => {
		await using both = await openBoth()
		const { deps } = both

		const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }

		const bundle = await plausibilityCheck(
			{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 1000 },
			deps
		)

		expect(bundle.coverage_confidence).toBe("insufficient_survey_data")
		expect(bundle.coverage_detail).toEqual({ filing: "cell_unsurveyed", physical: "cell_unsurveyed" })
		expect(bundle.evidence_found).toContainEqual({ type: "abstain", reason: "insufficient_survey_data", layer: "bdc" })
	})

	it("MIXED: filing covered, physical layer entirely missing (no poi dep) -> low", async () => {
		await using bdc = await buildBDCFixture()

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			{ bdcDB: bdc.db }
		)

		expect(bundle.coverage_confidence).toBe("low")
		expect(bundle.coverage_detail).toEqual({ filing: "covered", physical: "layer_missing" })
		expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(true)

		expect(bundle.evidence_found).toContainEqual({
			type: "abstain",
			reason: "requires_build_local_layer",
			layer: "poi",
		})
	})

	it("MIXED: physical covered, filing layer unsurveyed (bdc.db never surveyed this point) -> low", async () => {
		await using bdc = await buildBDCFixture()
		await using poi = await buildPOILookupFixture([])
		using poischemadb = await openpoischemadb()
		using poiLookup = new POILookup({ databasePath: poi.databasePath })

		const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }
		const remoteCell = cellFor(41.8781, -87.6298)

		await writeLayerCoverage(poischemadb, [
			{ h3Cell: res9ShortCellToRes6Parent(remoteCell), completeness: 1, observedRows: 0 },
		])

		const bundle = await plausibilityCheck(
			{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 1000 },
			{ bdcDB: bdc.db, poi: { lookup: poiLookup, schemadb: poischemadb } }
		)

		expect(bundle.coverage_confidence).toBe("low")
		expect(bundle.coverage_detail).toEqual({ filing: "cell_unsurveyed", physical: "covered" })
		expect(bundle.evidence_found).toContainEqual({ type: "abstain", reason: "insufficient_survey_data", layer: "bdc" })
		expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(false)
	})
})

describe("PlausibilityCheck — per-layer coverage-spine resolution assertion", () => {
	it("throws when poi.db's recorded resolution disagrees with BDC_H3_RESOLUTION, with both layers wired", async () => {
		await using bdc = await buildBDCFixture()
		await using poi = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])

		using poischemadb = await openpoischemadb(6)
		using poiLookup = new POILookup({ databasePath: poi.databasePath })

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ bdcDB: bdc.db, poi: { lookup: poiLookup, schemadb: poischemadb } }
			)
		).rejects.toThrow(/poi\.db's recorded h3 spine resolution \(6\) does not match BDC_H3_RESOLUTION \(9\)/)
	})

	it("throws when poi.db's recorded resolution disagrees with BDC_H3_RESOLUTION, with poi wired ALONE (no bdcDB)", async () => {
		await using poi = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])

		using poischemadb = await openpoischemadb(6)
		using poiLookup = new POILookup({ databasePath: poi.databasePath })

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ poi: { lookup: poiLookup, schemadb: poischemadb } }
			)
		).rejects.toThrow(/poi\.db's recorded h3 spine resolution \(6\) does not match BDC_H3_RESOLUTION \(9\)/)
	})

	it("does not throw when only bdcDB is wired and its own recorded resolution matches BDC_H3_RESOLUTION", async () => {
		await using bdc = await buildBDCFixture()

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ bdcDB: bdc.db }
			)
		).resolves.not.toThrow()
	})

	it("does not throw when only poi is wired and its own recorded resolution matches BDC_H3_RESOLUTION", async () => {
		await using poi = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		using poischemadb = await openpoischemadb()
		using poiLookup = new POILookup({ databasePath: poi.databasePath })

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ poi: { lookup: poiLookup, schemadb: poischemadb } }
			)
		).resolves.not.toThrow()
	})
})

describe("§7-2b criteria", () => {
	describe("Criterion 1 — positive-evidence-only invariant (required)", () => {
		it("Well-covered area, neither filing nor nearby plant -> zero evidence entries, and confidence that reflects the REAL coverage (never insufficient_survey_data)", async () => {
			await using bdc = await buildBDCFixture()
			await using poi = await buildPOILookupFixture([])
			using poischemadb = await openpoischemadb()
			using poiLookup = new POILookup({ databasePath: poi.databasePath })

			await writeLayerCoverage(poischemadb, [
				{ h3Cell: SPRINGFIELD_RES6_PARENT_SHORT, completeness: 1, observedRows: 0 },
			])

			const bundle = await plausibilityCheck(
				{
					point: SIBLING_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 100,
				},
				{ bdcDB: bdc.db, poi: { lookup: poiLookup, schemadb: poischemadb } }
			)

			expect(bundle.evidence_found).toEqual([])
			expect(bundle.coverage_detail).toEqual({ filing: "covered", physical: "covered" })

			expect(bundle.coverage_confidence).toBe("high")
		})

		it("contrast: absence in a SPARSE, never-surveyed cell yields insufficient_survey_data — never the informative-absence form proved above (fuller proof: 'both axes unknown' test in the 'full composition' suite above)", async () => {
			await using both = await openBoth()
			const { deps } = both

			const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }

			const bundle = await plausibilityCheck(
				{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 1000 },
				deps
			)

			expect(bundle.coverage_detail).toEqual({ filing: "cell_unsurveyed", physical: "cell_unsurveyed" })
			expect(bundle.coverage_confidence).toBe("insufficient_survey_data")

			expect(bundle.evidence_found).toContainEqual({
				type: "abstain",
				reason: "insufficient_survey_data",
				layer: "bdc",
			})
		})

		const PLAUSIBILITY_BUNDLE_KEYS = {
			claim: true,
			evidence_found: true,
			coverage_confidence: true,
			coverage_detail: true,
			block_resolution: true,
			vintage: true,
		} satisfies Record<keyof PlausibilityBundle, true>

		const EVIDENCE_TYPE_TAGS = {
			filing: true,
			physical_plant: true,
			abstain: true,
		} satisfies Record<PlausibilityEvidence["type"], true>

		const ABSTAIN_REASONS = {
			requires_build_local_layer: true,
			requires_bdc_layer: true,
			insufficient_survey_data: true,
		} satisfies Record<PlausibilityAbstainReason, true>

		const COVERAGE_CONFIDENCE_VALUES = {
			high: true,
			low: true,
			insufficient_survey_data: true,
		} satisfies Record<PlausibilityBundle["coverage_confidence"], true>

		const COVERAGE_AXIS_STATES = {
			covered: true,
			layer_missing: true,
			cell_unsurveyed: true,
			no_coordinate: true,
			not_applicable: true,
		} satisfies Record<PlausibilityCoverageAxisState, true>

		const BLOCK_RESOLUTION_VALUES = {
			geoid: true,
			h3_cell_approximation: true,
		} satisfies Record<PlausibilityBundle["block_resolution"], true>

		const VERDICT_LIKE_PATTERN =
			/implaus|disprov|contradic|invalid|false|deny|reject|negat|unsupport|unverif|not_?found|no_service|unavailable/i

		it("no value in the bundle's public type surface (evidence types, abstain reasons, confidence, coverage-axis states, block_resolution) is verdict-shaped", () => {
			const allValues = [
				...Object.keys(EVIDENCE_TYPE_TAGS),
				...Object.keys(ABSTAIN_REASONS),
				...Object.keys(COVERAGE_CONFIDENCE_VALUES),
				...Object.keys(COVERAGE_AXIS_STATES),
				...Object.keys(BLOCK_RESOLUTION_VALUES),
			]

			expect(allValues).toHaveLength(16)

			for (const value of allValues) {
				expect(value).not.toMatch(VERDICT_LIKE_PATTERN)
			}
		})

		it("PLAUSIBILITY_BUNDLE_KEYS (the key-set pin) is non-empty — a hollowed-out pin object would make the compile-time condition above vacuous", () => {
			expect(Object.keys(PLAUSIBILITY_BUNDLE_KEYS)).toHaveLength(6)
		})
	})

	describe("Criterion 2 — co-presence (fuller proof: 'full composition' suite above)", () => {
		it("matching filing + nearby plant, both covered -> corroborating filing evidence + a physical hit + coverage_confidence: high, coverage_detail fully covered, and no abstain", async () => {
			await using both = await openBoth()
			const { deps } = both

			const bundle = await plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				deps
			)

			expect(bundle.coverage_confidence).toBe("high")

			expect(bundle.coverage_detail).toEqual({ filing: "covered", physical: "covered" })
			expect(bundle.evidence_found.some((e) => e.type === "filing" && e.corroborates)).toBe(true)
			expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(true)
			expect(bundle.evidence_found.some((e) => e.type === "abstain")).toBe(false)
		})
	})

	describe("Criterion 3 — layer absent: abstain without fabricated evidence (fuller proof: 'bdc layer absent/insufficient' and 'physical evidence + poi layer absence' suites above)", () => {
		it("poi layer absent -> abstain requires_build_local_layer, and no physical_plant (the only distance-related evidence shape) is fabricated", async () => {
			const bundle = await plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 100,
				},
				{}
			)

			expect(bundle.evidence_found).toContainEqual({
				type: "abstain",
				reason: "requires_build_local_layer",
				layer: "poi",
			})

			expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(false)
		})

		it("bdc layer absent -> abstain requires_bdc_layer, vintage: null, and no filing evidence is fabricated", async () => {
			const bundle = await plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 100,
				},
				{}
			)

			expect(bundle.vintage).toBeNull()
			expect(bundle.evidence_found).toContainEqual({ type: "abstain", reason: "requires_bdc_layer", layer: "bdc" })
			expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(false)
		})
	})

	describe("Criterion 4 — block-grain flag (fuller proof: 'claim resolution' suite above)", () => {
		it("address- and point-resolved claims carry block_resolution: h3_cell_approximation; a geoid-given claim carries geoid", async () => {
			const byPoint = await plausibilityCheck(
				{ point: SPRINGFIELD_POINT, technologyCode: BroadbandTechnologyCode.AsymmetricXDSL, claimedDownloadMbps: 10 },
				{}
			)

			expect(byPoint.block_resolution).toBe("h3_cell_approximation")

			const geocode = async (): Promise<GeocodeLike> => ({ lat: SPRINGFIELD.latitude, lon: SPRINGFIELD.longitude })

			const byAddress = await plausibilityCheck(
				{
					address: "123 Main St, Springfield, IL",
					technologyCode: BroadbandTechnologyCode.AsymmetricXDSL,
					claimedDownloadMbps: 10,
				},
				{ geocode }
			)

			expect(byAddress.block_resolution).toBe("h3_cell_approximation")

			const byGeoid = await plausibilityCheck(
				{ geoid: GEOID_SPRINGFIELD, technologyCode: BroadbandTechnologyCode.AsymmetricXDSL, claimedDownloadMbps: 10 },
				{}
			)

			expect(byGeoid.block_resolution).toBe("geoid")
		})
	})
})
