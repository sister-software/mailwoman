/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four pre-registered 2a acceptance gates for `filingLandscape` (2a Task 9) — this whole phase
 *   is judged by these. Each gate builds (or reuses) a fixture `bdc.db` via Task 8's `buildBDCDatabase`
 *   `rows:` test seam, feeding one location per (geoid, provider, technology) triple so the census in
 *   Gate 3 is hand-verifiable without any BSL/location_id collapsing to reason about.
 *
 *   Fixture: 2 known blocks (SF, NY) × 2 providers each, distinct techs/speeds landing in 3 different
 *   speed buckets, plus one geoid that is NEVER fed to the builder at all (Gate 2's "absent from the
 *   fixture" block).
 */

import { chmodSync, existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { LayerContractDatabase } from "@mailwoman/core/layers"
import { openBuiltDatabase } from "@mailwoman/core/utils"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { latLngToCell } from "h3-js"
import type { Kysely } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BDC_H3_RESOLUTION, type BDCDatabase } from "../schema.ts"
import { buildBDCDatabase } from "./build-bdc.ts"
import {
	BDC_SPEED_BUCKET_100_1000,
	BDC_SPEED_BUCKET_25_100,
	BDC_SPEED_BUCKET_GIGABIT,
	BDC_SPEED_BUCKET_UNDER_25,
	filingLandscape,
} from "./filing-landscape.ts"
import type { BDCAvailabilityRow } from "./parsing.ts"

const ASOF_DATE = "2026-07-15"

const GEOID_SF = "060750001001001"
const GEOID_NY = "360610001001001"
// Deliberately NEVER passed to `buildBDCDatabase` at all — Gate 2's "absent from the fixture" block.
const GEOID_UNKNOWN = "999999999999999"

const CENTROID_SF = { lat: 37.7749, lon: -122.4194 }
const CENTROID_NY = { lat: 40.7128, lon: -74.006 }
// Never registered in `blockCentroids` — purely a coordinate the TEST uses to prove that area's res-6
// cell carries no coverage row at all (an independent check on the fixture's honesty, not something
// `filingLandscape` ever looks up for an unrouted geoid — it has no cell to look up in the first place).
const CENTROID_NEVER_SURVEYED = { lat: 41.8781, lon: -87.6298 }

const CENTROIDS: Record<string, { lat: number; lon: number }> = {
	[GEOID_SF]: CENTROID_SF,
	[GEOID_NY]: CENTROID_NY,
}

function blockCentroids(geoid: string): { lat: number; lon: number } | undefined {
	return CENTROIDS[geoid]
}

const PROVIDER_A = 130_077
const PROVIDER_B = 130_080

/**
 * 4 rows, one location each (`includeLocationIDs` stays default-off; ONE row per (geoid, provider, technology) triple
 * keeps the block-grain collapse a no-op, so `result.rows` and the hand-computed census in Gate 3 agree without any
 * surprise collapsing):
 *
 * - SF: provider A / tech 50 / 1000 Mbps (gigabit), provider B / tech 40 / 80 Mbps (25-100)
 * - NY: provider A / tech 50 / 1000 Mbps (gigabit — SAME bucket/tech/provider as SF, block_count sums to 2), provider B /
 *   tech 10 / 10 Mbps (under-25)
 */
function fixtureRows(): BDCAvailabilityRow[] {
	return [
		{
			geoid: GEOID_SF,
			provider_id: PROVIDER_A,
			technology_code: 50,
			location_id: "SF-A",
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 1,
			business_residential_code: "R",
		},
		{
			geoid: GEOID_SF,
			provider_id: PROVIDER_B,
			technology_code: 40,
			location_id: "SF-B",
			max_advertised_download_speed: 80,
			max_advertised_upload_speed: 20,
			low_latency: 0,
			business_residential_code: "R",
		},
		{
			geoid: GEOID_NY,
			provider_id: PROVIDER_A,
			technology_code: 50,
			location_id: "NY-A",
			max_advertised_download_speed: 1000,
			max_advertised_upload_speed: 1000,
			low_latency: 1,
			business_residential_code: "R",
		},
		{
			geoid: GEOID_NY,
			provider_id: PROVIDER_B,
			technology_code: 10,
			location_id: "NY-B",
			max_advertised_download_speed: 10,
			max_advertised_upload_speed: 5,
			low_latency: 0,
			business_residential_code: "R",
		},
	]
}

let scratch: string
let out: string

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "bdc-filing-landscape-"))
	out = join(scratch, "bdc.db")

	await buildBDCDatabase({
		rows: fixtureRows(),
		out,
		asOfDate: ASOF_DATE,
		buildSHA: "deadbeef",
		blockCentroids,
	})
})

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true })
})

function openFixture(): DatabaseClient<BDCDatabase> {
	return new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(out, { readOnly: true }) })
}

describe("filingLandscape — Gate 1: contract conformance", () => {
	it("reads a manifest whose spine is res-9 h3, and stores h3_cell byte-compatible with shortCellToInt(latLngToCell(...))", async () => {
		using db = openFixture()
		const contractDB = db as unknown as Kysely<LayerContractDatabase>

		const manifest = await readLayerManifest(contractDB)
		expect(manifest.spineKeys.h3?.resolution).toBe(9)
		expect(BDC_H3_RESOLUTION).toBe(9)

		const row = await db
			.selectFrom("bdc_availability")
			.select("h3_cell")
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		const expectedCell = shortCellToInt(latLngToCell(CENTROID_SF.lat, CENTROID_SF.lon, 9) as H3Cell)
		expect(row.h3_cell).toBe(expectedCell)

		// The reader itself must also come back clean against this same fixture.
		const result = await filingLandscape(db, { geoids: [GEOID_SF] })
		expect(result.vintage).toBe(ASOF_DATE)
	})
})

describe("filingLandscape — Gate 2: meaning-of-zero", () => {
	it("reports a geoid absent from the fixture in unknown_block_count, never as a zero-filing claim", async () => {
		using db = openFixture()
		const contractDB = db as unknown as Kysely<LayerContractDatabase>

		// Independent honesty check on the fixture: an area NEVER fed to the builder carries no
		// coverage row at all — proves the "absence" below is real, not an artifact of the query.
		const neverSurveyedRes6 = shortCellToInt(
			latLngToCell(CENTROID_NEVER_SURVEYED.lat, CENTROID_NEVER_SURVEYED.lon, 6) as H3Cell
		)

		expect(await readLayerCoverage(contractDB, neverSurveyedRes6)).toBeUndefined()

		const knownOnly = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY] })
		const withUnknown = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY, GEOID_UNKNOWN] })

		expect(withUnknown.unknown_block_count).toBe(1)
		// surveyed_block_count is UNCHANGED by the unknown geoid's presence in the query — it's never
		// folded in as a (zero-filing) survey result.
		expect(withUnknown.surveyed_block_count).toBe(knownOnly.surveyed_block_count)
		expect(withUnknown.surveyed_block_count).toBe(2)

		// The unknown geoid must not silently appear as a zero-count entry anywhere in filings either —
		// it simply contributes nothing (filings for the two known blocks are identical either way).
		expect(withUnknown.filings).toEqual(knownOnly.filings)
	})
})

describe("filingLandscape — Gate 3: hand-verified census", () => {
	it("returns the exact ProviderFilingSummary[] for 2 providers over 2 blocks", async () => {
		using db = openFixture()

		const result = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY] })

		expect(result.surveyed_block_count).toBe(2)
		expect(result.unknown_block_count).toBe(0)

		// Hand-computed: PROVIDER_A/tech 50/gigabit appears at BOTH blocks (block_count 2); each
		// PROVIDER_B row is distinct per block (25-100 at SF only, under-25 at NY only).
		expect(result.filings).toEqual([
			{ provider_id: PROVIDER_A, technology_code: 50, speed_bucket: BDC_SPEED_BUCKET_GIGABIT, block_count: 2 },
			{ provider_id: PROVIDER_B, technology_code: 10, speed_bucket: BDC_SPEED_BUCKET_UNDER_25, block_count: 1 },
			{ provider_id: PROVIDER_B, technology_code: 40, speed_bucket: BDC_SPEED_BUCKET_25_100, block_count: 1 },
		])
	})

	it("queries equivalently by h3Cells, over the block's own stored cell", async () => {
		using db = openFixture()

		const sfCell = shortCellToInt(latLngToCell(CENTROID_SF.lat, CENTROID_SF.lon, 9) as H3Cell)
		const nyCell = shortCellToInt(latLngToCell(CENTROID_NY.lat, CENTROID_NY.lon, 9) as H3Cell)

		const byGeoid = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY] })
		const byCell = await filingLandscape(db, { h3Cells: [sfCell, nyCell] })

		expect(byCell).toEqual(byGeoid)
	})

	it("rejects a query with neither or both of geoids/h3Cells", async () => {
		using db = openFixture()

		await expect(filingLandscape(db, {})).rejects.toThrow(/exactly one/)
		await expect(filingLandscape(db, { geoids: [GEOID_SF], h3Cells: [1] })).rejects.toThrow(/exactly one/)
	})
})

describe("filingLandscape — Gate 4: vintage-or-throw", () => {
	let corruptScratch: string
	let corruptOut: string

	afterAll(async () => {
		if (corruptScratch) {
			await rm(corruptScratch, { recursive: true, force: true })
		}
	})

	it("throws when the manifest row is missing, rather than answering unstamped", async () => {
		corruptScratch = await mkdtemp(join(tmpdir(), "bdc-filing-landscape-corrupt-"))
		corruptOut = join(corruptScratch, "bdc.db")

		await buildBDCDatabase({
			rows: fixtureRows(),
			out: corruptOut,
			asOfDate: ASOF_DATE,
			buildSHA: "deadbeef",
			blockCentroids,
		})

		// `buildBDCDatabase` seals (chmod 0444). Unseal so the manifest row can be deleted, per
		// `openBuiltDatabase`'s `write: true` mode (throws `SealedArtifactError` while still sealed).
		chmodSync(corruptOut, 0o644)
		expect(existsSync(corruptOut)).toBe(true)

		using writable = new DatabaseClient<BDCDatabase>({ database: openBuiltDatabase(corruptOut, { write: true }) })
		await (writable as unknown as Kysely<LayerContractDatabase>).deleteFrom("layer_manifest").execute()

		await expect(filingLandscape(writable, { geoids: [GEOID_SF] })).rejects.toThrow(/manifest/)
	})
})
