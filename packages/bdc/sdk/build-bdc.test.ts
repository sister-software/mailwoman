/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildBDCDatabase}, the stage, materialize and seal build of `bdc.db`.
 */

import { pathExists, statPath, readLocalBuffer, isFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { layerschemadatabase } from "@mailwoman/core/layers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import {
	createFilerAttributeTable,
	createFilerClusterTable,
	createFilerEdgeTable,
	createFilerFamilyTable,
	createFilerManifestTable,
	createFilerNodeTable,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	filerLookup,
	type FilerDatabase,
} from "@mailwoman/filer"
import { toFRN } from "@mailwoman/filer/frn"
import type { ProviderListRow } from "@mailwoman/filer/sdk/provider-list"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BDCDatabase } from "#schema"
import { buildBDCDatabase, geometryCentroid, peekProviderID, type BuildBDCResult } from "#sdk/build-bdc"
import type { ProviderID } from "#sdk/common"
import type { BDCAvailabilityRow } from "#sdk/parsing"

const GEOID_SF = "060750001001001"
const GEOID_LA = "060374601001001"
const GEOID_NY = "360610001001001"
const GEOID_UNKNOWN = "999999999999999"

const CENTROIDS: Record<string, { lat: number; lon: number }> = {
	[GEOID_SF]: { lat: 37.7749, lon: -122.4194 },
	[GEOID_LA]: { lat: 34.0522, lon: -118.2437 },
	[GEOID_NY]: { lat: 40.7128, lon: -74.006 },
}

function blockCentroids(geoid: string): { lat: number; lon: number } | null {
	return CENTROIDS[geoid] ?? null
}

function fixtureRows(): BDCAvailabilityRow[] {
	return [
		{
			geoid: GEOID_SF,
			provider_id: 130_077,
			technology_code: 50,
			location_id: "1000000001",
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 1,
			business_residential_code: "R",
		},
		{
			geoid: GEOID_SF,
			provider_id: 130_077,
			technology_code: 50,
			location_id: "1000000001",
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 1,
			business_residential_code: "R",
		},
		{
			geoid: GEOID_LA,
			provider_id: 130_077,
			technology_code: 40,
			location_id: "1000000002",
			max_advertised_download_speed: 940,
			max_advertised_upload_speed: 880,
			low_latency: 0,
			business_residential_code: "B",
		},
		{
			geoid: GEOID_NY,
			provider_id: 130_080,
			technology_code: 50,
			location_id: "1000000004",
			max_advertised_download_speed: 500,
			max_advertised_upload_speed: 500,
			low_latency: 1,
			business_residential_code: "X",
		},
		{
			geoid: GEOID_UNKNOWN,
			provider_id: 130_080,
			technology_code: 40,
			location_id: "1000000005",
			max_advertised_download_speed: 100,
			max_advertised_upload_speed: 20,
			low_latency: 0,
			business_residential_code: "R",
		},
	]
}

let scratch: TemporaryDirectory
let out: PathBuilder

beforeEach(async () => {
	scratch = await temporaryDirectory("bdc-build-")
	out = scratch.path("bdc.db")
})

afterEach(() => scratch[Symbol.asyncDispose]())

describe("buildBDCDatabase", () => {
	let result: BuildBDCResult

	beforeEach(async () => {
		result = await buildBDCDatabase({
			rows: fixtureRows(),
			out,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
		})
	})

	it("(a) builds a sealed file at `out`", async () => {
		expect(await pathExists(out)).toBe(true)
		expect((await statPath(out)).mode & 0o222).toBe(0)
		// The swap removes the `.building` temp path and any aside copy.
		expect(await pathExists(`${out}.building`)).toBe(false)
		expect(await pathExists(`${out}.prev`)).toBe(false)
	})

	it("(b) dedupes an exact-duplicate row on the natural key", () => {
		expect(result.deduped).toBe(1)
	})

	it("(c) skips + counts the unknown geoid without ever guessing a cell", async () => {
		expect(result.unknownGeoids).toBe(1)

		expect(result.rows).toBe(3)
		expect(result.providers).toBe(2)
		expect(result.coverageCells).toBe(3)

		using kdb = new DatabaseClient<BDCDatabase>(out, { readOnly: true })

		const badRow = await kdb
			.selectFrom("bdc_availability")
			.selectAll()
			.where("geoid", "=", GEOID_UNKNOWN)
			.executeTakeFirst()

		expect(badRow).toBeUndefined()
	})

	it("(d) leaves location_id NULL by default", async () => {
		using kdb = new DatabaseClient<BDCDatabase>(out, { readOnly: true })

		const row = await kdb
			.selectFrom("bdc_availability")
			.selectAll()
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		expect(row.location_id).toBeNull()
		expect(row.h3_cell).toEqual(expect.any(Number))
		expect(row.wof_id).toBeNull()
	})

	it("(d) populates location_id when includeLocationIDs is true", async () => {
		const includeOut = scratch.path("bdc-with-location-ids.db")

		await buildBDCDatabase({
			rows: fixtureRows(),
			out: includeOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			includeLocationIDs: true,
			blockCentroids,
		})

		using kdb = new DatabaseClient<BDCDatabase>(includeOut, { readOnly: true })

		const row = await kdb
			.selectFrom("bdc_availability")
			.selectAll()
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		expect(row.location_id).toBe("1000000001")
	})

	it("(e) writes a manifest whose sourceVintage equals asOfDate", async () => {
		using kdb = new DatabaseClient<layerschemadatabase>(out, { readOnly: true })
		const manifest = await readLayerManifest(kdb)

		expect(manifest).toMatchObject({
			name: "bdc",
			tier: "shipped",
			license: "LicenseRef-USGov-Public-Domain",
			source: "fcc-bdc",
			sourceVintage: "2026-06-30",
			buildCmd: "mailwoman gazetteer build bdc",
			buildSHA: "deadbeef",
			freshnessPolicy: "versioned-refresh",
			spineKeys: { h3: { column: "h3_cell", resolution: 9 }, wofID: "wof_id" },
		})

		expect(manifest.attribution).toContain("FCC")
		expect(manifest.attribution).toContain("Fabric")
	})

	it("coverage rows carry completeness 1 and a positive observed_rows total", async () => {
		using kdb = new DatabaseClient<layerschemadatabase>(out, { readOnly: true })
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()

		expect(coverageRows).toHaveLength(result.coverageCells)
		expect(coverageRows.every((c) => c.observed_rows > 0 && c.completeness === 1)).toBe(true)
		const totalObserved = coverageRows.reduce((sum, c) => sum + c.observed_rows, 0)
		expect(totalObserved).toBe(result.rows)
		// Meaning-of-zero: an unsurveyed cell is unknown, never present with completeness 0.
		expect(await readLayerCoverage(kdb, 999_999_999)).toBeNull()
	})

	it("(f) leaves bdc_provider empty and providersPopulated at 0 when `providers` is omitted (3a decision 6)", async () => {
		expect(result.providersPopulated).toBe(0)

		using kdb = new DatabaseClient<BDCDatabase>(out, { readOnly: true })
		const providerRows = await kdb.selectFrom("bdc_provider").selectAll().execute()

		expect(providerRows).toHaveLength(0)
	})

	it("(g) omitting `providers` is deterministic — repeated builds of the same fixture, same clock, produce byte-identical files (the new option changes nothing on the default path)", async () => {
		const frozenNow = new Date("2026-06-30T00:00:00.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(frozenNow)

		try {
			const firstOut = scratch.path("bdc-determinism-a.db")
			const secondOut = scratch.path("bdc-determinism-b.db")

			await buildBDCDatabase({
				rows: fixtureRows(),
				out: firstOut,
				asOfDate: "2026-06-30",
				buildSHA: "deadbeef",
				blockCentroids,
			})

			await buildBDCDatabase({
				rows: fixtureRows(),
				out: secondOut,
				asOfDate: "2026-06-30",
				buildSHA: "deadbeef",
				blockCentroids,
			})

			expect(await readLocalBuffer(firstOut)).toEqual(await readLocalBuffer(secondOut))
		} finally {
			vi.useRealTimers()
		}
	})

	it("bootstraps missing intermediate output directories", async () => {
		const nestedOut = scratch.path("nested", "deeper", "bdc.db")

		const nestedResult = await buildBDCDatabase({
			rows: fixtureRows(),
			out: nestedOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
		})

		expect(nestedResult.rows).toBe(3)
		await expect(isFile(nestedOut)).resolves.toBe(true)
	})

	it("moves an existing artifact aside before the new build takes its place", async () => {
		const second = await buildBDCDatabase({
			rows: fixtureRows(),
			out,
			asOfDate: "2026-07-01",
			buildSHA: "cafebabe",
			blockCentroids,
		})

		expect(second.rows).toBe(3)
		expect(await pathExists(`${out}.prev`)).toBe(false)

		using kdb = new DatabaseClient<layerschemadatabase>(out, { readOnly: true })
		const manifest = await readLayerManifest(kdb)
		expect(manifest.sourceVintage).toBe("2026-07-01")
	})
})

describe("buildBDCDatabase — multi-BSL block-grain collapse", () => {
	/**
	 * Three rows share all values except `location_id`.
	 *
	 * This tests materialize collapse.
	 * The collapse keeps one row unless `includeLocationIDs` is true.
	 */
	function multiBSLRows(): BDCAvailabilityRow[] {
		return ["2000000001", "2000000002", "2000000003"].map((locationID) => ({
			geoid: GEOID_SF,
			provider_id: 130_077,
			technology_code: 50,
			location_id: locationID,
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 1,
			business_residential_code: "R",
		}))
	}

	it("collapses multiple BSLs at the same triple to exactly 1 row by default", async () => {
		const collapsedOut = scratch.path("bdc-multi-bsl-default.db")

		const result = await buildBDCDatabase({
			rows: multiBSLRows(),
			out: collapsedOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
		})

		expect(result.rows).toBe(1)
		// The rows differ on `location_id`, so the staging dedup removes none of them.
		expect(result.deduped).toBe(0)
		expect(result.coverageCells).toBe(1)

		using kdb = new DatabaseClient<BDCDatabase>(collapsedOut, { readOnly: true })

		const rows = await kdb.selectFrom("bdc_availability").selectAll().where("geoid", "=", GEOID_SF).execute()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.location_id).toBeNull()

		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows).toHaveLength(1)
		expect(coverageRows[0]!.observed_rows).toBe(1)
	})

	it("keeps every distinct BSL as its own row when includeLocationIDs is true", async () => {
		const perBSLOut = scratch.path("bdc-multi-bsl-included.db")

		const result = await buildBDCDatabase({
			rows: multiBSLRows(),
			out: perBSLOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			includeLocationIDs: true,
			blockCentroids,
		})

		expect(result.rows).toBe(3)
		expect(result.deduped).toBe(0)
		expect(result.coverageCells).toBe(1)

		using kdb = new DatabaseClient<BDCDatabase>(perBSLOut, { readOnly: true })

		const rows = await kdb.selectFrom("bdc_availability").selectAll().where("geoid", "=", GEOID_SF).execute()
		expect(rows).toHaveLength(3)
		expect(rows.map((r) => r.location_id).toSorted()).toEqual(["2000000001", "2000000002", "2000000003"])

		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows).toHaveLength(1)
		expect(coverageRows[0]!.observed_rows).toBe(3)
	})
})

describe("buildBDCDatabase — bdc_provider population (3a decision 6)", () => {
	const FRN_EARLY = toFRN("0001111111")!
	const FRN_LATE = toFRN("0002222222")!
	const FRN_SOLO = toFRN("0003333333")!

	function openFilerMemory(): DatabaseClient<FilerDatabase> {
		return DatabaseClient.temp<FilerDatabase>()
	}

	/**
	 * Seeds `provider_id` 700001 with two FRN edges and two conflicting holding-company edges.
	 * The later filing must win the FRN pick.
	 */
	async function seedTwoFRNFixture(db: DatabaseClient<FilerDatabase>): Promise<void> {
		await createFilerNodeTable(db)
		await createFilerEdgeTable(db)
		await createFilerAttributeTable(db)
		await createFilerClusterTable(db)
		await createFilerFamilyTable(db)
		await createFilerManifestTable(db)

		await db
			.insertInto("filer_manifest")
			.values({
				name: "filer",
				version: "2026-Q2",
				// filerLookup refuses a manifest with a schema_version earlier than filer_family.
				// This fixture creates a manifest with that earlier version.
				schema_version: 2,
				source: "form-499,bdc-provider-list",
				source_vintage: "2026-Q2",
				build_cmd: "mailwoman filer build",
				build_sha: "deadbeef",
				created_at: "2026-01-01T00:00:00Z",
			})
			.execute()

		const PROVIDER_NODE = `${FilerIdentifierType.BDCProviderID}:700001`
		const FRN_EARLY_NODE = `${FilerIdentifierType.FRN}:${FRN_EARLY}`
		const FRN_LATE_NODE = `${FilerIdentifierType.FRN}:${FRN_LATE}`
		const FORM_EARLY = `${FilerIdentifierType.Form499ID}:8001`
		const FORM_LATE = `${FilerIdentifierType.Form499ID}:8002`
		const HC_ALPHA_NODE = `${FilerIdentifierType.HoldingCompanyName}:Alpha Holdco`
		const HC_ALPHA_RENAMED_NODE = `${FilerIdentifierType.HoldingCompanyName}:Alpha Holdco Renamed`

		await db
			.insertInto("filer_node")
			.values([
				{ node_id: PROVIDER_NODE, identifier_type: FilerIdentifierType.BDCProviderID, identifier_value: "700001" },
				{ node_id: FRN_EARLY_NODE, identifier_type: FilerIdentifierType.FRN, identifier_value: FRN_EARLY },
				{ node_id: FRN_LATE_NODE, identifier_type: FilerIdentifierType.FRN, identifier_value: FRN_LATE },
				{ node_id: FORM_EARLY, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "8001" },
				{ node_id: FORM_LATE, identifier_type: FilerIdentifierType.Form499ID, identifier_value: "8002" },
				{
					node_id: HC_ALPHA_NODE,
					identifier_type: FilerIdentifierType.HoldingCompanyName,
					identifier_value: "Alpha Holdco",
				},
				{
					node_id: HC_ALPHA_RENAMED_NODE,
					identifier_type: FilerIdentifierType.HoldingCompanyName,
					identifier_value: "Alpha Holdco Renamed",
				},
			])
			.execute()

		await db
			.insertInto("filer_edge")
			.values([
				// The provider has two FRN edges, more than `bdc_provider` can hold.
				{
					from_node_id: PROVIDER_NODE,
					to_node_id: FRN_EARLY_NODE,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.SameEntity,
					source: "bdc-provider-list",
					source_vintage: "2026-Q2",
					valid_from: "2026-06-30",
					valid_to: null,
					match_score: null,
					evidence: null,
				},
				{
					from_node_id: PROVIDER_NODE,
					to_node_id: FRN_LATE_NODE,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.SameEntity,
					source: "bdc-provider-list",
					source_vintage: "2026-Q2",
					valid_from: "2026-06-30",
					valid_to: null,
					match_score: null,
					evidence: null,
				},
				// Two conflicting holding-company edges leave `bdc_provider.holding_company` NULL
				// while both stay recoverable here.
				{
					from_node_id: PROVIDER_NODE,
					to_node_id: HC_ALPHA_NODE,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "bdc-provider-list",
					source_vintage: "2026-Q2",
					valid_from: "2026-06-30",
					valid_to: null,
					match_score: null,
					evidence: null,
				},
				{
					from_node_id: PROVIDER_NODE,
					to_node_id: HC_ALPHA_RENAMED_NODE,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.HoldingCompany,
					source: "bdc-provider-list",
					source_vintage: "2026-Q2",
					valid_from: "2026-06-30",
					valid_to: null,
					match_score: null,
					evidence: null,
				},
				// Each FRN's most recent form-499 filing, with FRN_LATE's the later date.
				{
					from_node_id: FRN_EARLY_NODE,
					to_node_id: FORM_EARLY,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.SameEntity,
					source: "form-499",
					source_vintage: "2026-01-15",
					valid_from: "2026-01-15",
					valid_to: null,
					match_score: null,
					evidence: null,
				},
				{
					from_node_id: FRN_LATE_NODE,
					to_node_id: FORM_LATE,
					assertion: FilerEdgeAssertion.Authoritative,
					relationship: FilerRelationship.SameEntity,
					source: "form-499",
					source_vintage: "2026-05-20",
					valid_from: "2026-05-20",
					valid_to: null,
					match_score: null,
					evidence: null,
				},
			])
			.execute()
	}

	function providerListFixture(): ProviderListRow[] {
		return [
			{ providerID: 700_001, frn: FRN_EARLY, holdingCompany: "Alpha Holdco" },
			{ providerID: 700_001, frn: FRN_LATE, holdingCompany: "Alpha Holdco Renamed" },
			{ providerID: 700_002, frn: FRN_SOLO, holdingCompany: "Solo Broadband" },
			// Two rows with the same frn and holding company exercise the distinct-set shortcut.
			{ providerID: 700_004, frn: FRN_SOLO, holdingCompany: "Repeat Holdco" },
			{ providerID: 700_004, frn: FRN_SOLO, holdingCompany: "Repeat Holdco" },
		]
	}

	it("picks the LATER-filed FRN as the lossy bdc_provider.frn pick (decision 6), while filer.db still holds BOTH edges", async () => {
		using filerDB = openFilerMemory()
		await seedTwoFRNFixture(filerDB)

		const providerOut = scratch.path("bdc-providers.db")

		const result = await buildBDCDatabase({
			rows: fixtureRows(),
			out: providerOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
			providers: providerListFixture(),
			filerDB,
		})

		expect(result.providersPopulated).toBe(3)

		using kdb = new DatabaseClient<BDCDatabase>(providerOut, { readOnly: true })

		const multiFRNProvider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_001)
			.executeTakeFirstOrThrow()

		// `bdc_provider` holds one FRN.
		// The later-filed FRN wins.
		// Its two holding-company values conflict, so the column stays NULL.
		expect(multiFRNProvider.frn).toBe(FRN_LATE)
		expect(multiFRNProvider.brand_name).toBeNull()
		expect(multiFRNProvider.holding_company).toBeNull()

		const singleFRNProvider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_002)
			.executeTakeFirstOrThrow()

		// Its only FRN is primary.
		// Its only holding-company value populates the column directly.
		expect(singleFRNProvider.frn).toBe(FRN_SOLO)
		expect(singleFRNProvider.brand_name).toBeNull()
		expect(singleFRNProvider.holding_company).toBe("Solo Broadband")

		const repeatValueProvider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_004)
			.executeTakeFirstOrThrow()

		// The same holding-company value on two rows counts as one distinct value and populates.
		expect(repeatValueProvider.frn).toBe(FRN_SOLO)
		expect(repeatValueProvider.holding_company).toBe("Repeat Holdco")

		// The discarded FRN and holding-company values stay in `filer.db`,
		// recoverable through `filerLookup` and `filer_edge`.
		const crosswalk = await filerLookup(filerDB, { bdcProviderID: 700_001, asOf: "2026-12-31" })

		const frnValues = crosswalk.identifiers
			.filter((identifier) => identifier.type === FilerIdentifierType.FRN)
			.map((identifier) => identifier.value)
			.toSorted()

		expect(frnValues).toEqual([FRN_EARLY, FRN_LATE].toSorted())
		expect(crosswalk.primary_frn?.frn).toBe(FRN_LATE)

		// `filerLookup` returns only `same_entity` relationships, so the holding-company
		// retention is checked against `filer_edge`.
		const holdingCompanyValues = (
			await filerDB
				.selectFrom("filer_edge")
				.innerJoin("filer_node", "filer_node.node_id", "filer_edge.to_node_id")
				.select("filer_node.identifier_value")
				.where("filer_edge.from_node_id", "=", `${FilerIdentifierType.BDCProviderID}:700001`)
				.where("filer_edge.relationship", "=", FilerRelationship.HoldingCompany)
				.execute()
		)
			.map((row) => row.identifier_value)
			.toSorted()

		expect(holdingCompanyValues).toEqual(["Alpha Holdco", "Alpha Holdco Renamed"].toSorted())
	})

	it("throws naming the offending provider_id when a multi-FRN provider is given without `filerDB`", async () => {
		const providerOut = scratch.path("bdc-providers-no-filerdb.db")

		await expect(
			buildBDCDatabase({
				rows: fixtureRows(),
				out: providerOut,
				asOfDate: "2026-06-30",
				buildSHA: "deadbeef",
				blockCentroids,
				providers: providerListFixture(),
			})
		).rejects.toThrow(/700001/)

		// A build that cannot resolve a required primary FRN leaves no sealed artifact.
		expect(await pathExists(providerOut)).toBe(false)
	})

	it("inserts frn: NULL when a multi-FRN provider's FRNs carry no 499 filing to rank by, rather than guessing", async () => {
		using filerDB = openFilerMemory()
		await createFilerNodeTable(filerDB)
		await createFilerEdgeTable(filerDB)
		await createFilerAttributeTable(filerDB)
		await createFilerClusterTable(filerDB)
		await createFilerFamilyTable(filerDB)
		await createFilerManifestTable(filerDB)
		// No `filer_edge` rows, so neither FRN has a filing to rank by.

		const providerOut = scratch.path("bdc-providers-no-candidates.db")

		const result = await buildBDCDatabase({
			rows: fixtureRows(),
			out: providerOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
			providers: [
				{ providerID: 700_003, frn: FRN_EARLY, holdingCompany: null },
				{ providerID: 700_003, frn: FRN_LATE, holdingCompany: null },
			],
			filerDB,
		})

		expect(result.providersPopulated).toBe(1)

		using kdb = new DatabaseClient<BDCDatabase>(providerOut, { readOnly: true })

		const provider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_003)
			.executeTakeFirstOrThrow()

		expect(provider.frn).toBeNull()
	})
})

describe("peekProviderID", () => {
	it("reads the constant provider_id column off the first data row", () => {
		const csv = Buffer.from(
			"frn,provider_id,brand_name,location_id\n0004215211,130077,Sonic Broadband,1000000001\n0004215211,130077,Sonic Broadband,1000000002\n"
		)

		expect(peekProviderID(csv)).toBe(130_077 as ProviderID)
	})

	it("throws when the buffer has no newline at all (missing even a header row)", () => {
		expect(() => peekProviderID(Buffer.from("frn,provider_id"))).toThrow(/no newline found/)
	})

	it("throws when the header row has no following data row", () => {
		expect(() => peekProviderID(Buffer.from("frn,provider_id\n"))).toThrow(/could not read provider_id/)
	})

	it("throws (never returns NaN) when the provider_id field isn't numeric", () => {
		const csv = Buffer.from(
			"frn,provider_id,brand_name,location_id\n0004215211,NOT_A_NUMBER,Sonic Broadband,1000000001\n"
		)

		expect(() => peekProviderID(csv)).toThrow(/did not parse to a safe integer/)
	})

	it("names the CSV path in the thrown error when one is supplied", () => {
		const csv = Buffer.from(
			"frn,provider_id,brand_name,location_id\n0004215211,NOT_A_NUMBER,Sonic Broadband,1000000001\n"
		)

		expect(() => peekProviderID(csv, "/some/path/to/file.csv")).toThrow(/\/some\/path\/to\/file\.csv/)
	})
})

describe("buildBDCDatabase — malformed provider_id via csvPaths (the production ingest path)", () => {
	// A non-numeric `provider_id` parses to NaN.
	// SQLite binds NaN as NULL, so `insert or ignore` drops every row
	// while the build counts those rows as deduped.
	it("rejects the whole build, naming the malformed CSV, instead of silently absorbing its rows as deduped", async () => {
		const malformedCSVPath = resolvePackagePath(
			"@mailwoman/bdc",
			"test-fixtures",
			"availability-malformed-provider.csv"
		)

		let caught: unknown

		try {
			await buildBDCDatabase({
				csvPaths: [malformedCSVPath],
				out,
				asOfDate: "2026-06-30",
				buildSHA: "deadbeef",
				blockCentroids,
			})
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toMatch(/provider_id/)
		expect((caught as Error).message).toContain(malformedCSVPath)

		// A file whose rows were all rejected leaves no sealed artifact.
		expect(await pathExists(out)).toBe(false)
	})
})

describe("geometryCentroid", () => {
	it("averages a Polygon's exterior ring vertices", () => {
		const polygon = stringifyJSON({
			type: "Polygon",
			coordinates: [
				[
					[-122.42, 37.77],
					[-122.41, 37.77],
					[-122.41, 37.78],
					[-122.42, 37.78],
					[-122.42, 37.77],
				],
			],
		})

		const centroid = geometryCentroid(polygon)
		expect(centroid).toBeDefined()
		expect(centroid!.lon).toBeCloseTo(-122.416, 2)
		expect(centroid!.lat).toBeCloseTo(37.774, 2)
	})

	it("averages a MultiPolygon's exterior rings across all polygons", () => {
		const multiPolygon = stringifyJSON({
			type: "MultiPolygon",
			coordinates: [
				[
					[
						[0, 0],
						[2, 0],
						[2, 2],
						[0, 2],
						[0, 0],
					],
				],
			],
		})

		const centroid = geometryCentroid(multiPolygon)
		expect(centroid).toBeDefined()
		// The shoelace formula weights the centroid by area.
		// It ignores the repeated closing vertex.
		expect(centroid!.lon).toBeCloseTo(1, 5)
		expect(centroid!.lat).toBeCloseTo(1, 5)
	})

	it("returns null for null or unparseable geometry", () => {
		expect(geometryCentroid(null)).toBeNull()
		expect(geometryCentroid("not json")).toBeNull()
		expect(geometryCentroid(stringifyJSON({ type: "Point", coordinates: [0, 0] }))).toBeNull()
	})
})
