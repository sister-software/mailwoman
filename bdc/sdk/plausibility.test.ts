/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link plausibilityCheck} (2b task 5, decisions 4, 6, 8). The four §7-2b acceptance gates
 *   are Task 6's own file; this suite exercises the composition logic itself — claim resolution, the
 *   tech→category mapping, filing/physical evidence assembly, the abstain precedent, and the
 *   `coverage_confidence` combination — so Task 6 can build on a module already known to compose
 *   correctly in isolation.
 *
 *   Fixture idiom: a real `bdc.db` built via `buildBDCDatabase`'s `rows:` seam (same idiom as
 *   `filing-landscape.test.ts`), and a poi-layer pair built the SAME way `nearest-infrastructure.test.ts`
 *   established (`poi-schema.ts` table builders directly — `bdc` cannot depend on the `mailwoman`
 *   workspace). Unlike that test's deliberately-decoupled `contractDB` fixture, several tests here need a
 *   REALISTIC poi `layer_manifest` (a real recorded `spineKeys.h3.resolution`) to exercise
 *   `assertCoverageSpineAgreement`, so `openPOIContractDB` below writes one explicitly with resolution 9
 *   (matching `POI_H3_RESOLUTION`) by default, overridable per test for the mismatch case.
 *
 *   Springfield, IL is the shared center (same coordinates `nearest-infrastructure.test.ts` uses) for
 *   every fixture below, so a single set of derived cells serves both the bdc.db and poi fixtures.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createLayerCoverageTable,
	createLayerManifestTable,
	writeLayerCoverage,
	writeLayerManifest,
	type LayerContractDatabase,
} from "@mailwoman/core/layers"
import { POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import {
	createPOIBrandIndex,
	createPOINameKeyIndex,
	createPOISearchFTS,
	createPOIStagingTables,
	createPOITable,
	type POIDatabase,
} from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { shortCellToInt, type H3Cell, type PointLiteral } from "@mailwoman/spatial"
import { cellToChildren, cellToLatLng, cellToParent, latLngToCell } from "h3-js"
import { afterEach, describe, expect, it } from "vitest"

import type { BDCDatabase } from "../schema.ts"
import { buildBDCDatabase } from "./build-bdc.ts"
import { res9ShortCellToRes6Parent } from "./filing-landscape.ts"
import type { BDCAvailabilityRow } from "./parsing.ts"
import {
	PLAUSIBILITY_TECH_PHYSICAL_CATEGORIES,
	physicalCategoriesForTechnology,
	plausibilityCheck,
	type GeocodeLike,
	type PlausibilityDeps,
} from "./plausibility.ts"
import { BroadbandTechnologyCode } from "./technologies.ts"

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

// A sibling res-9 cell sharing SPRINGFIELD's res-6 parent but carrying no bdc_availability rows of its own — the
// "covered res-6 parent, zero filings in THIS exact cell" positive-absence case (filing-landscape.ts's own
// docstring: the h3Cells query path is the ONLY way to exercise this, since geoid-mode's "no rows ⇒ no candidate
// cell" shortcut can never produce it). Derived from h3-js, never hardcoded.
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

/**
 * One matching-tech/matching-or-better-speed row (corroborates the fiber@1000 claim) and one lesser-tech row (DSL —
 * never corroborates a fiber claim, regardless of speed) at the SAME geoid.
 */
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

async function buildBDCFixture(): Promise<{ scratch: string; db: DatabaseClient<BDCDatabase> }> {
	const scratch = await mkdtemp(join(tmpdir(), "bdc-plausibility-bdc-"))
	const out = join(scratch, "bdc.db")

	await buildBDCDatabase({
		rows: fixtureRows(),
		out,
		asOfDate: ASOF_DATE,
		buildSHA: "deadbeef",
		blockCentroids,
	})

	return { scratch, db: new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(out, { readOnly: true }) }) }
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

function nameKeyFor(name: string): string {
	return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
}

async function buildPOILookupFixture(rows: readonly POIFixtureRow[]): Promise<{ scratch: string; path: string }> {
	const scratch = await mkdtemp(join(tmpdir(), "bdc-plausibility-poi-"))
	const path = join(scratch, "poi.db")

	const raw = new DatabaseSync(path)
	const kdb = new DatabaseClient<POIDatabase>({ database: raw })

	await createPOITable(kdb)
	await createPOIStagingTables(kdb)
	createPOISearchFTS(raw)

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
				name_key: nameKeyFor(row.name),
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
	await kdb.destroy()

	return { scratch, path }
}

/**
 * A `LayerContractDatabase`-only fixture standing in for poi.db's own manifest/coverage — NOT poi.db's actual file
 * (mirrors `nearest-infrastructure.test.ts`'s decoupled `openEmptyContractDB`), but with a REALISTIC recorded
 * `spineKeys.h3.resolution` (9, matching `POI_H3_RESOLUTION`) by default so `assertCoverageSpineAgreement` passes in
 * the happy-path tests. `resolutionOverride` lets the mismatch test set something else.
 */
async function openPOIContractDB(resolutionOverride = 9): Promise<DatabaseClient<LayerContractDatabase>> {
	const kdb = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(":memory:") })

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

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
	while (cleanups.length) {
		await cleanups.pop()!()
	}
})

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
		// finding 1: the filing axis names WHY it's not covered — the layer was never wired — distinct from a
		// wired-but-unsurveyed cell (see the next test).
		expect(bundle.coverage_detail.filing).toBe("layer_missing")
	})

	it("abstains insufficient_survey_data (not requires_bdc_layer) when bdc.db is open but this exact cell was never surveyed, and vintage IS populated", async () => {
		const { scratch, db } = await buildBDCFixture()

		cleanups.push(async () => {
			db[Symbol.dispose]()
			await rm(scratch, { recursive: true, force: true })
		})

		// Far from Springfield — genuinely never surveyed by this fixture.
		const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }

		const bundle = await plausibilityCheck(
			{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 100 },
			{ bdcDB: db }
		)

		expect(bundle.vintage).toBe(ASOF_DATE)

		expect(bundle.evidence_found).toContainEqual({
			type: "abstain",
			reason: "insufficient_survey_data",
			layer: "bdc",
		})

		expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(false)
		// finding 1: distinct from the layer-missing case above — the LAYER is wired, only this cell lacks coverage.
		expect(bundle.coverage_detail.filing).toBe("cell_unsurveyed")
	})
})

describe("plausibilityCheck — filing evidence + corroboration", () => {
	it("emits one filing entry per provider row, corroborates true for a matching tech/speed and false for a different tech", async () => {
		const { scratch, db } = await buildBDCFixture()

		cleanups.push(async () => {
			db[Symbol.dispose]()
			await rm(scratch, { recursive: true, force: true })
		})

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			{ bdcDB: db }
		)

		const filingEntries = bundle.evidence_found.filter((e) => e.type === "filing")
		expect(filingEntries).toHaveLength(2)

		const fiberEntry = filingEntries.find((e) => e.filing.provider_id === PROVIDER_FIBER)!
		expect(fiberEntry.corroborates).toBe(true)
		expect(fiberEntry.vintage).toBe(ASOF_DATE)

		const dslEntry = filingEntries.find((e) => e.filing.provider_id === PROVIDER_DSL)!
		expect(dslEntry.corroborates).toBe(false)

		// Never disproof: a non-corroborating filing is still a `filing` entry, never anything else.
		expect(filingEntries.every((e) => e.type === "filing")).toBe(true)
	})

	it("corroborates false for a same-tech but LESSER speed filing", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "bdc-plausibility-lesser-"))
		const out = join(scratch, "bdc.db")

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

		const db = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })

		cleanups.push(async () => {
			db[Symbol.dispose]()
			await rm(scratch, { recursive: true, force: true })
		})

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			{ bdcDB: db }
		)

		const filingEntries = bundle.evidence_found.filter((e) => e.type === "filing")
		expect(filingEntries).toHaveLength(1)
		expect(filingEntries[0]!.corroborates).toBe(false)
	})

	it("positive absence: a covered res-6 parent with zero filings in the queried res-9 cell emits no filing evidence, and still counts as covered", async () => {
		const { scratch, db } = await buildBDCFixture()

		cleanups.push(async () => {
			db[Symbol.dispose]()
			await rm(scratch, { recursive: true, force: true })
		})

		// Sanity: the sibling cell really does share Springfield's res-6 parent, and really is a DIFFERENT res-9 cell.
		expect(SPRINGFIELD_SIBLING_RES9_FULL).not.toBe(SPRINGFIELD_RES9_FULL)
		expect(res9ShortCellToRes6Parent(shortCellToInt(SPRINGFIELD_SIBLING_RES9_FULL))).toBe(SPRINGFIELD_RES6_PARENT_SHORT)

		const bundle = await plausibilityCheck(
			{ point: SIBLING_POINT, technologyCode: BroadbandTechnologyCode.AsymmetricXDSL, claimedDownloadMbps: 10 },
			{ bdcDB: db }
		)

		expect(bundle.evidence_found.some((e) => e.type === "filing")).toBe(false)
		expect(bundle.evidence_found.some((e) => e.type === "abstain")).toBe(false)
		// DSL has no physical falsifier, so with no poi dep the confidence is filing-axis-only: covered -> "low"
		// (this module's conservative not_applicable extension — see plausibility.ts's module docstring).
		expect(bundle.coverage_confidence).toBe("low")
		// finding 1: the bundle now NAMES why this is "low" — physical is not_applicable (DSL has no physical
		// falsifier at all), NOT a poi survey gap — distinct states that used to be indistinguishable.
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

		// finding 1: physical is layer_missing here — fiber DOES have a falsifier (see the next test's
		// not_applicable contrast for a tech that has none at all).
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
		// finding 1: not_applicable, NOT layer_missing — DSL has no physical falsifier regardless of poi's presence.
		expect(bundle.coverage_detail.physical).toBe("not_applicable")
	})

	it("a geoid-only claim (no point/address) skips physical evidence entirely — no abstain, no entry — even with deps.poi present", async () => {
		const { scratch: poiScratch, path: poiPath } = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		const poiContractDB = await openPOIContractDB()
		const poiLookup = new POILookup({ databasePath: poiPath })

		cleanups.push(async () => {
			poiLookup[Symbol.dispose]()
			poiContractDB[Symbol.dispose]()
			await rm(poiScratch, { recursive: true, force: true })
		})

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 100,
			},
			{ poi: { lookup: poiLookup, contractDB: poiContractDB } }
		)

		expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(false)

		expect(bundle.evidence_found.some((e) => e.type === "abstain" && e.reason === "requires_build_local_layer")).toBe(
			false
		)

		// finding 1: no_coordinate — a real capability gap distinct from layer_missing, since deps.poi IS wired here.
		expect(bundle.coverage_detail.physical).toBe("no_coordinate")
	})
})

describe("plausibilityCheck — full composition (both layers present)", () => {
	async function openBoth(): Promise<{
		deps: PlausibilityDeps
		cleanup: () => Promise<void>
	}> {
		const { scratch: bdcScratch, db: bdcDB } = await buildBDCFixture()
		const { scratch: poiScratch, path: poiPath } = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		const poiContractDB = await openPOIContractDB()
		const poiLookup = new POILookup({ databasePath: poiPath })

		// Coverage for exactly Springfield's own res-6 parent — the query point's cell.
		await writeLayerCoverage(poiContractDB, [
			{ h3Cell: SPRINGFIELD_RES6_PARENT_SHORT, completeness: 1, observedRows: 1 },
		])

		return {
			deps: { bdcDB, poi: { lookup: poiLookup, contractDB: poiContractDB } },
			cleanup: async () => {
				bdcDB[Symbol.dispose]()
				poiLookup[Symbol.dispose]()
				poiContractDB[Symbol.dispose]()
				await rm(bdcScratch, { recursive: true, force: true })
				await rm(poiScratch, { recursive: true, force: true })
			},
		}
	}

	it("co-presence: matching filing + nearby plant, both covered -> high confidence, both evidence kinds present", async () => {
		const { deps, cleanup } = await openBoth()
		cleanups.push(cleanup)

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
		const { deps, cleanup } = await openBoth()
		cleanups.push(cleanup)

		// A remote point: bdc.db never surveyed it, and openBoth()'s poi coverage table only covers Springfield's
		// own res-6 parent, so both axes genuinely come back unknown here — the both-unknown branch, distinct from
		// the ACTUAL mixed branch (one covered, one not) exercised below.
		const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }

		const bundle = await plausibilityCheck(
			{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 1000 },
			deps
		)

		expect(bundle.coverage_confidence).toBe("insufficient_survey_data")
		expect(bundle.coverage_detail).toEqual({ filing: "cell_unsurveyed", physical: "cell_unsurveyed" })
		expect(bundle.evidence_found).toContainEqual({ type: "abstain", reason: "insufficient_survey_data", layer: "bdc" })
	})

	// task 5 fix round 1 (review finding 3): `combineCoverage`'s genuine MIXED branch (one axis covered, the other
	// not) was previously asserted via a test titled for exactly this case but whose body actually hit the
	// both-unknown branch instead (its own comment admitted the mixed case couldn't be constructed). The two tests
	// below construct the real thing, in both directions, rather than leaving the branch's actual coverage claim
	// resting on a misleading title.
	it("MIXED: filing covered, physical layer entirely missing (no poi dep) -> low", async () => {
		const { scratch, db } = await buildBDCFixture()

		cleanups.push(async () => {
			db[Symbol.dispose]()
			await rm(scratch, { recursive: true, force: true })
		})

		const bundle = await plausibilityCheck(
			{
				geoid: GEOID_SPRINGFIELD,
				technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
				claimedDownloadMbps: 1000,
			},
			{ bdcDB: db } // no poi — physical axis is layer_missing, NOT not_applicable (fiber DOES have a falsifier)
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
		const { scratch: bdcScratch, db: bdcDB } = await buildBDCFixture()
		const { scratch: poiScratch, path: poiPath } = await buildPOILookupFixture([])
		const poiContractDB = await openPOIContractDB()
		const poiLookup = new POILookup({ databasePath: poiPath })

		// Deliberately covering the REMOTE point's own res-6 parent (not Springfield's) — decoupled from any real poi
		// row, same idiom `nearest-infrastructure.test.ts`'s `openEmptyContractDB` establishes — so the physical axis
		// reads COVERED at a cell bdc.db never surveyed, genuinely separating the two axes instead of both landing on
		// unknown together.
		const remote: PointLiteral = { type: "Point", coordinates: [-87.6298, 41.8781] }
		const remoteCell = cellFor(41.8781, -87.6298)

		await writeLayerCoverage(poiContractDB, [
			{ h3Cell: res9ShortCellToRes6Parent(remoteCell), completeness: 1, observedRows: 0 },
		])

		cleanups.push(async () => {
			bdcDB[Symbol.dispose]()
			poiLookup[Symbol.dispose]()
			poiContractDB[Symbol.dispose]()
			await rm(bdcScratch, { recursive: true, force: true })
			await rm(poiScratch, { recursive: true, force: true })
		})

		const bundle = await plausibilityCheck(
			{ point: remote, technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber, claimedDownloadMbps: 1000 },
			{ bdcDB, poi: { lookup: poiLookup, contractDB: poiContractDB } }
		)

		expect(bundle.coverage_confidence).toBe("low")
		expect(bundle.coverage_detail).toEqual({ filing: "cell_unsurveyed", physical: "covered" })
		expect(bundle.evidence_found).toContainEqual({ type: "abstain", reason: "insufficient_survey_data", layer: "bdc" })
		expect(bundle.evidence_found.some((e) => e.type === "physical_plant")).toBe(false)
	})
})

describe("plausibilityCheck — per-layer coverage-spine resolution assertion (ledger note, task 4 review; task 5 fix round 1 finding 2)", () => {
	it("throws when poi.db's recorded resolution disagrees with BDC_H3_RESOLUTION, with both layers wired", async () => {
		const { scratch: bdcScratch, db: bdcDB } = await buildBDCFixture()
		const { scratch: poiScratch, path: poiPath } = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		// Deliberately mismatched: bdc.db records resolution 9 (BDC_H3_RESOLUTION); this poi contractDB records 6.
		const poiContractDB = await openPOIContractDB(6)
		const poiLookup = new POILookup({ databasePath: poiPath })

		cleanups.push(async () => {
			bdcDB[Symbol.dispose]()
			poiLookup[Symbol.dispose]()
			poiContractDB[Symbol.dispose]()
			await rm(bdcScratch, { recursive: true, force: true })
			await rm(poiScratch, { recursive: true, force: true })
		})

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ bdcDB, poi: { lookup: poiLookup, contractDB: poiContractDB } }
			)
		).rejects.toThrow(/poi\.db's recorded h3 spine resolution \(6\) does not match BDC_H3_RESOLUTION \(9\)/)
	})

	it("throws when poi.db's recorded resolution disagrees with BDC_H3_RESOLUTION, with poi wired ALONE (no bdcDB) — finding 2", async () => {
		const { scratch: poiScratch, path: poiPath } = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		// Same mismatch as above, but this time bdcDB is never wired at all — previously this ran NO check whatsoever,
		// since the retired assertion only fired when BOTH layers were present. `pointCell` (below) is still derived
		// from BDC_H3_RESOLUTION regardless, so poi's own resolution must be checked here too.
		const poiContractDB = await openPOIContractDB(6)
		const poiLookup = new POILookup({ databasePath: poiPath })

		cleanups.push(async () => {
			poiLookup[Symbol.dispose]()
			poiContractDB[Symbol.dispose]()
			await rm(poiScratch, { recursive: true, force: true })
		})

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ poi: { lookup: poiLookup, contractDB: poiContractDB } }
			)
		).rejects.toThrow(/poi\.db's recorded h3 spine resolution \(6\) does not match BDC_H3_RESOLUTION \(9\)/)
	})

	it("does not throw when only bdcDB is wired and its own recorded resolution matches BDC_H3_RESOLUTION", async () => {
		const { scratch, db } = await buildBDCFixture()

		cleanups.push(async () => {
			db[Symbol.dispose]()
			await rm(scratch, { recursive: true, force: true })
		})

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ bdcDB: db }
			)
		).resolves.not.toThrow()
	})

	it("does not throw when only poi is wired and its own recorded resolution matches BDC_H3_RESOLUTION", async () => {
		const { scratch: poiScratch, path: poiPath } = await buildPOILookupFixture([TELECOM_EXCHANGE_NEAR])
		const poiContractDB = await openPOIContractDB() // default resolution 9, matches BDC_H3_RESOLUTION
		const poiLookup = new POILookup({ databasePath: poiPath })

		cleanups.push(async () => {
			poiLookup[Symbol.dispose]()
			poiContractDB[Symbol.dispose]()
			await rm(poiScratch, { recursive: true, force: true })
		})

		await expect(
			plausibilityCheck(
				{
					point: SPRINGFIELD_POINT,
					technologyCode: BroadbandTechnologyCode.OpticalCarrierFiber,
					claimedDownloadMbps: 1000,
				},
				{ poi: { lookup: poiLookup, contractDB: poiContractDB } }
			)
		).resolves.not.toThrow()
	})
})
