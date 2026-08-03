/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildBDCDatabase} — the stage/materialize/seal build of `bdc.db`.
 *   Feeds the loader a synthetic row source directly (an injected `Iterable<BDCAvailabilityRow>`), so
 *   the suite exercises the whole build WITHOUT touching the filesystem CSV path or a real TIGER
 *   database — matches `build-poi.test.ts`'s injected-row convention.
 *
 *   Fixture: 5 raw rows over 3 known geoids (San Francisco, Los Angeles, New York — far enough apart
 *   to land in distinct res-9 AND res-6 H3 cells) plus 1 unknown geoid absent from the
 *   `blockCentroids` fixture map. Row 2 is an EXACT duplicate of row 1 on the natural key
 *   `(geoid, provider_id, technology_code, location_id)`.
 */

import { existsSync, statSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { LayerContractDatabase } from "@mailwoman/core/layers"
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
import { toFRN, type ProviderListRow } from "@mailwoman/filer/sdk"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BDCDatabase } from "../schema.ts"
import { buildBDCDatabase, geometryCentroid, peekProviderID, type BuildBDCResult } from "./build-bdc.ts"
import type { ProviderID } from "./common.ts"
import type { BDCAvailabilityRow } from "./parsing.ts"

const GEOID_SF = "060750001001001"
const GEOID_LA = "060374601001001"
const GEOID_NY = "360610001001001"
const GEOID_UNKNOWN = "999999999999999"

const CENTROIDS: Record<string, { lat: number; lon: number }> = {
	[GEOID_SF]: { lat: 37.7749, lon: -122.4194 },
	[GEOID_LA]: { lat: 34.0522, lon: -118.2437 },
	[GEOID_NY]: { lat: 40.7128, lon: -74.006 },
}

function blockCentroids(geoid: string): { lat: number; lon: number } | undefined {
	return CENTROIDS[geoid]
}

/**
 * 5 raw rows: row 1 + its exact duplicate (row 2) share the natural key `(geoid, provider_id, technology_code,
 * location_id)`; row 5's geoid is deliberately absent from {@link CENTROIDS}.
 */
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
			// Exact duplicate of the row above — must be deduped by the staging pass.
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
			// Unknown geoid — must be skipped and counted, never guessed at a cell.
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

let scratch: string
let out: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "bdc-build-"))
	out = join(scratch, "bdc.db")
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

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

	it("(a) builds a sealed file at `out`", () => {
		expect(existsSync(out)).toBe(true)
		expect(statSync(out).mode & 0o222).toBe(0)
		// The `.building` temp path and any aside copy must not survive the swap.
		expect(existsSync(`${out}.building`)).toBe(false)
		expect(existsSync(`${out}.prev`)).toBe(false)
	})

	it("(b) dedupes an exact-duplicate row on the natural key", () => {
		expect(result.deduped).toBe(1)
	})

	it("(c) skips + counts the unknown geoid without ever guessing a cell", async () => {
		expect(result.unknownGeoids).toBe(1)
		// 5 raw rows - 1 deduped - 1 unknown-geoid skip = 3 materialized.
		expect(result.rows).toBe(3)
		expect(result.providers).toBe(2)
		expect(result.coverageCells).toBe(3)

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })

		const badRow = await kdb
			.selectFrom("bdc_availability")
			.selectAll()
			.where("geoid", "=", GEOID_UNKNOWN)
			.executeTakeFirst()

		expect(badRow).toBeUndefined()
	})

	it("(d) leaves location_id NULL by default", async () => {
		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })

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
		const includeOut = join(scratch, "bdc-with-location-ids.db")

		await buildBDCDatabase({
			rows: fixtureRows(),
			out: includeOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			includeLocationIDs: true,
			blockCentroids,
		})

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(includeOut, { readOnly: true }) })

		const row = await kdb
			.selectFrom("bdc_availability")
			.selectAll()
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		expect(row.location_id).toBe("1000000001")
	})

	it("(e) writes a manifest whose sourceVintage equals asOfDate", async () => {
		using kdb = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })
		const manifest = await readLayerManifest(kdb as unknown as Kysely<LayerContractDatabase>)

		expect(manifest).toMatchObject({
			name: "bdc",
			tier: "shipped",
			license: "public-domain",
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
		using kdb = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()

		expect(coverageRows).toHaveLength(result.coverageCells)
		expect(coverageRows.every((c) => c.observed_rows > 0 && c.completeness === 1)).toBe(true)
		const totalObserved = coverageRows.reduce((sum, c) => sum + c.observed_rows, 0)
		expect(totalObserved).toBe(result.rows)
		// Meaning-of-zero: an unsurveyed cell is UNKNOWN, never present with completeness 0.
		expect(await readLayerCoverage(kdb as unknown as Kysely<LayerContractDatabase>, 999_999_999)).toBeUndefined()
	})

	it("(f) leaves bdc_provider empty and providersPopulated at 0 when `providers` is omitted — the default path is unaffected by Task 8 (3a decision 6)", async () => {
		expect(result.providersPopulated).toBe(0)

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })
		const providerRows = await kdb.selectFrom("bdc_provider").selectAll().execute()

		expect(providerRows).toHaveLength(0)
	})

	it("(g) omitting `providers` is deterministic — repeated builds of the same fixture, same clock, produce byte-identical files (the new option changes nothing on the default path)", async () => {
		const frozenNow = new Date("2026-06-30T00:00:00.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(frozenNow)

		try {
			const firstOut = join(scratch, "bdc-determinism-a.db")
			const secondOut = join(scratch, "bdc-determinism-b.db")

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

			expect(await readFile(firstOut)).toEqual(await readFile(secondOut))
		} finally {
			vi.useRealTimers()
		}
	})

	it("bootstraps missing intermediate output directories", async () => {
		const nestedOut = join(scratch, "nested", "deeper", "bdc.db")

		const nestedResult = await buildBDCDatabase({
			rows: fixtureRows(),
			out: nestedOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
		})

		expect(nestedResult.rows).toBe(3)
		expect(statSync(nestedOut).isFile()).toBe(true)
	})

	it("moves an existing artifact aside before the new build takes its place", async () => {
		// Build once more against the SAME `out` — the file already exists from the outer `beforeEach`.
		const second = await buildBDCDatabase({
			rows: fixtureRows(),
			out,
			asOfDate: "2026-07-01",
			buildSHA: "cafebabe",
			blockCentroids,
		})

		expect(second.rows).toBe(3)
		expect(existsSync(`${out}.prev`)).toBe(false)

		using kdb = new DatabaseClient<LayerContractDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })
		const manifest = await readLayerManifest(kdb as unknown as Kysely<LayerContractDatabase>)
		expect(manifest.sourceVintage).toBe("2026-07-01")
	})
})

describe("buildBDCDatabase — multi-BSL block-grain collapse", () => {
	/**
	 * 3 rows sharing the SAME (geoid, provider_id, technology_code, speeds, low_latency, business_residential_code)
	 * triple — only `location_id` differs, exactly the shape a real FCC per-provider CSV produces for a block carrying
	 * multiple Broadband Serviceable Locations. The staging pass's natural key includes `location_id`, so all 3 survive
	 * staging as distinct rows (this is NOT the exact-duplicate case `fixtureRows` covers) — the materialize step must
	 * then collapse them to exactly 1 row in the default mode, never inflating `result.rows`/
	 * `layer_coverage.observed_rows` by the BSL count, while keeping all 3 distinct when `includeLocationIDs: true`.
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
		const collapsedOut = join(scratch, "bdc-multi-bsl-default.db")

		const result = await buildBDCDatabase({
			rows: multiBSLRows(),
			out: collapsedOut,
			asOfDate: "2026-06-30",
			buildSHA: "deadbeef",
			blockCentroids,
		})

		expect(result.rows).toBe(1)
		// No EXACT duplicates here — all 3 rows differ on location_id, so the staging natural-key dedup
		// (a separate mechanism from this materialize-time collapse) removes none of them.
		expect(result.deduped).toBe(0)
		expect(result.coverageCells).toBe(1)

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(collapsedOut, { readOnly: true }) })

		const rows = await kdb.selectFrom("bdc_availability").selectAll().where("geoid", "=", GEOID_SF).execute()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.location_id).toBeNull()

		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows).toHaveLength(1)
		expect(coverageRows[0]!.observed_rows).toBe(1)
	})

	it("keeps every distinct BSL as its own row when includeLocationIDs is true", async () => {
		const perBSLOut = join(scratch, "bdc-multi-bsl-included.db")

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

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(perBSLOut, { readOnly: true }) })

		const rows = await kdb.selectFrom("bdc_availability").selectAll().where("geoid", "=", GEOID_SF).execute()
		expect(rows).toHaveLength(3)
		expect(rows.map((r) => r.location_id).toSorted()).toEqual(["2000000001", "2000000002", "2000000003"])

		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows).toHaveLength(1)
		expect(coverageRows[0]!.observed_rows).toBe(3)
	})
})

describe("buildBDCDatabase — bdc_provider population (3a Task 8, decision 6)", () => {
	const FRN_EARLY = toFRN("0001111111")!
	const FRN_LATE = toFRN("0002222222")!
	const FRN_SOLO = toFRN("0003333333")!

	function openFilerMemory(): DatabaseClient<FilerDatabase> {
		return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(":memory:") })
	}

	/**
	 * `provider_id` 700001 carries TWO FRN edges — the decision 6 cardinality `bdc_provider` cannot express. FRN_LATE's
	 * own most recent form-499 filing (2026-05-20) postdates FRN_EARLY's (2026-01-15), so FRN_LATE must win the
	 * primary-FRN pick. `provider_id` 700002 carries exactly one FRN (FRN_SOLO) — no filer.db query is needed to resolve
	 * its primary FRN. Also seeds `provider_id` 700001's TWO conflicting `holding_company_name` edges (review fix round
	 *
	 * 1. — the same cardinality problem `frn` has, proving both discarded values stay recoverable from filer.db even though
	 *    `bdc_provider.holding_company` can only hold one (here: neither, since they conflict).
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
				// 2, not 1 — filerLookup refuses a manifest reporting a
				// schema_version that predates filer_family, which this fixture now also creates above.
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
				// The provider_id carries TWO FRN edges — decision 6's cardinality `bdc_provider` cannot express.
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
				// AND two conflicting holding_company_name edges — the identical cardinality problem, unresolved by
				// decision 6, so bdc_provider.holding_company stays NULL and both stay recoverable here.
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
				// Each FRN's own most recent form-499 filing — FRN_LATE's is the LATER filing date.
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
			// Two rows, SAME frn AND SAME holding_company — proves the single-distinct-value shortcut looks at the
			// DISTINCT set across every row, not just "there happened to be one row" (700002's trivial case above).
			{ providerID: 700_004, frn: FRN_SOLO, holdingCompany: "Repeat Holdco" },
			{ providerID: 700_004, frn: FRN_SOLO, holdingCompany: "Repeat Holdco" },
		]
	}

	it("picks the LATER-filed FRN as the lossy bdc_provider.frn pick (decision 6), while filer.db still holds BOTH edges", async () => {
		using filerDB = openFilerMemory()
		await seedTwoFRNFixture(filerDB)

		const providerOut = join(scratch, "bdc-providers.db")

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

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(providerOut, { readOnly: true }) })

		const multiFRNProvider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_001)
			.executeTakeFirstOrThrow()

		// The LOSSY pick: bdc_provider can only hold one FRN, and decision 6 says the later-filed one wins. Its two
		// holding_company values genuinely CONFLICT ("Alpha Holdco" vs "Alpha Holdco Renamed") — no rule resolves that
		//, so it stays NULL, same as brand_name.
		expect(multiFRNProvider.frn).toBe(FRN_LATE)
		expect(multiFRNProvider.brand_name).toBeNull()
		expect(multiFRNProvider.holding_company).toBeNull()

		const singleFRNProvider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_002)
			.executeTakeFirstOrThrow()

		// No filer.db query was needed for this one — its lone FRN is primary by construction, and its single
		// unambiguous holding_company populates directly (IMPORTANT-3's "no conflict ⇒ no rule needed" shortcut).
		expect(singleFRNProvider.frn).toBe(FRN_SOLO)
		expect(singleFRNProvider.brand_name).toBeNull()
		expect(singleFRNProvider.holding_company).toBe("Solo Broadband")

		const repeatValueProvider = await kdb
			.selectFrom("bdc_provider")
			.selectAll()
			.where("provider_id", "=", 700_004)
			.executeTakeFirstOrThrow()

		// TWO rows, but the SAME holding_company on both — one DISTINCT value, not two rows worth of ambiguity —
		// still populates. Proves the shortcut compares the distinct SET, not just "was there only one row".
		expect(repeatValueProvider.frn).toBe(FRN_SOLO)
		expect(repeatValueProvider.holding_company).toBe("Repeat Holdco")

		// The DISCARDED FRN (FRN_EARLY) is NOT lost — decision 6's whole premise is that filer.db, untouched by this
		// build, still retains every edge. Recover it back out through the public reader, `filerLookup`. Same for the
		// two CONFLICTING holding_company values `bdc_provider` couldn't keep either.
		const crosswalk = await filerLookup(filerDB, { bdcProviderID: 700_001, asOf: "2026-12-31" })

		const frnValues = crosswalk.identifiers
			.filter((identifier) => identifier.type === FilerIdentifierType.FRN)
			.map((identifier) => identifier.value)
			.toSorted()

		expect(frnValues).toEqual([FRN_EARLY, FRN_LATE].toSorted())
		expect(crosswalk.primary_frn?.frn).toBe(FRN_LATE)

		// filerLookup's `identifiers` is relationship: same_entity ONLY now — a
		// HoldingCompanyName edge never surfaces there regardless of retention, so "not lost" is proven directly
		// against filer_edge instead (this fixture predates filer_family and never populates it, so `families` isn't
		// the right recovery channel here either).
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
		const providerOut = join(scratch, "bdc-providers-no-filerdb.db")

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

		// Loud, not partial: no sealed artifact from a build that couldn't resolve a required primary FRN.
		expect(existsSync(providerOut)).toBe(false)
	})

	it("inserts frn: NULL when a multi-FRN provider's FRNs carry no 499 filing to rank by, rather than guessing", async () => {
		using filerDB = openFilerMemory()
		await createFilerNodeTable(filerDB)
		await createFilerEdgeTable(filerDB)
		await createFilerAttributeTable(filerDB)
		await createFilerClusterTable(filerDB)
		await createFilerFamilyTable(filerDB)
		await createFilerManifestTable(filerDB)
		// No filer_edge rows at all — neither FRN has a form-499 filing edge to rank by.

		const providerOut = join(scratch, "bdc-providers-no-candidates.db")

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

		using kdb = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(providerOut, { readOnly: true }) })

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
	// CRITICAL (review): `peekProviderID`'s old `Number.parseInt(...) as ProviderID` had no finiteness guard. A
	// non-numeric provider_id field parses to NaN, which binds to `bdc_stage.provider_id` (INTEGER NOT NULL) as
	// SQLite NULL — `INSERT OR IGNORE` then silently drops EVERY row of the file, miscounted as ordinary `deduped`
	// rows rather than surfaced as the malformed-file error it actually is. This test goes through `csvPaths` (the
	// real filesystem-reading production path `readAvailabilityRowsFromCSVPaths` uses), not the `rows:` test seam,
	// so it proves the guard is wired all the way from disk.
	it("rejects the whole build, naming the malformed CSV, instead of silently absorbing its rows as deduped", async () => {
		const malformedCSVPath = join(import.meta.dirname, "..", "test-fixtures", "availability-malformed-provider.csv")

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

		// The rejection must be loud, not partial: no sealed artifact from a file whose rows were all rejected,
		// never silently materialized/counted as "deduped".
		expect(existsSync(out)).toBe(false)
	})
})

describe("geometryCentroid", () => {
	it("averages a Polygon's exterior ring vertices", () => {
		const polygon = JSON.stringify({
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
		const multiPolygon = JSON.stringify({
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
		// Vertex-average, not area-weighted: the ring's repeated closing vertex ([0,0], counted twice out of
		// 5 points) pulls the average toward that corner rather than the square's true (1, 1) geometric center —
		// exactly the documented naive-centroid tradeoff, not a bug.
		expect(centroid!.lon).toBeCloseTo(0.8, 5)
		expect(centroid!.lat).toBeCloseTo(0.8, 5)
	})

	it("returns undefined for null or unparseable geometry", () => {
		expect(geometryCentroid(null)).toBeUndefined()
		expect(geometryCentroid("not json")).toBeUndefined()
		expect(geometryCentroid(JSON.stringify({ type: "Point", coordinates: [0, 0] }))).toBeUndefined()
	})
})
