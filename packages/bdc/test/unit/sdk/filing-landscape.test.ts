/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The four pre-registered 2a acceptance criteria for `filingLandscape`. Each builds (or reuses) a
 *   fixture `bdc.db` via `buildBDCDatabase`'s `rows:` injection point, one location per (geoid,
 *   provider, technology) triple so the criterion 3 census is hand-verifiable without any
 *   BSL/location_id collapsing to reason about.
 *
 *   Fixture: 3 known blocks (SF, NY, and a "divergent" block whose directly-indexed res-6 cell
 *   disagrees with its res-9 cell's H3 hierarchy parent) × 2 providers each at SF/NY with distinct
 *   techs/speeds across 3 speed buckets, plus one geoid never fed to the builder. Criteria 1–4 query
 *   only `[GEOID_SF, GEOID_NY]` (or subsets), so the divergent block does not perturb their
 *   hand-counts — it is exercised only by the coverage-cell unification tests.
 *
 *   Three properties the four criteria do not pin on their own, each with its own describe block below:
 *
 *   - Builder and reader must derive a block's res-6 coverage cell the same way. H3's cell hierarchy is
 *     not geometrically exact: `latLngToCell(centroid, 6)` and `cellToParent(latLngToCell(centroid, 9),
 *     6)` disagree for some real points, and deriving the two sides independently would make a surveyed
 *     block read back as unknown while its own rows still populate `filings`.
 *   - Criterion 2 must exercise `readLayerCoverage`, not the zero-rows shortcut: a geoid absent from the
 *     fixture derives no candidate cell, so it is classified unknown before the coverage check is
 *     reached. The extended block adds a geoid with rows but a deleted coverage row, plus an `h3Cells`
 *     query against a cell that was never surveyed.
 *   - The SQL `case` and the JS `speedBucketForDownloadSpeed` mirror must not drift; the boundary table
 *     and the SQL-vs-JS agreement test pin them, and the "100-1000" bucket is otherwise never exercised
 *     by the criteria.
 */

import { BDC_H3_RESOLUTION, type BDCDatabase } from "@mailwoman/bdc/schema"
import { buildBDCDatabase } from "@mailwoman/bdc/sdk/build-bdc"
import {
	BDC_SPEED_BUCKET_100_1000,
	BDC_SPEED_BUCKET_25_100,
	BDC_SPEED_BUCKET_GIGABIT,
	BDC_SPEED_BUCKET_UNDER_25,
	filingLandscape,
	res9ShortCellToRes6Parent,
	speedBucketForDownloadSpeed,
} from "@mailwoman/bdc/sdk/filing-landscape"
import type { BDCAvailabilityRow } from "@mailwoman/bdc/sdk/parsing"
import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode } from "@mailwoman/core/fs/writers"
import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import { shortCellToInt, type H3Cell } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import { latLngToCell } from "h3-js"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const ASOF_DATE = "2026-07-15"

const GEOID_SF = "060750001001001"
const GEOID_NY = "360610001001001"
// A point whose directly-indexed res-6 cell (`latLngToCell(_, 6)`) disagrees with
// its res-9 cell's H3 hierarchy parent (`cellToParent(latLngToCell(_, 9), 6)`) —
// the divergence class builder/reader unification guards.
const GEOID_DIVERGENT = "510090101001001"
// Never passed to `buildBDCDatabase` — criterion 2's "absent from the fixture" block.
const GEOID_UNKNOWN = "999999999999999"

const CENTROID_SF = { lat: 37.7749, lon: -122.4194 }
const CENTROID_NY = { lat: 40.7128, lon: -74.006 }
const CENTROID_DIVERGENT = { lat: 37.119, lon: -79.6658 }
// Never registered in `blockCentroids`: a coordinate the test uses to prove that area's
// res-6 cell carries no coverage row at all, an independent check on the fixture's honesty.
const CENTROID_NEVER_SURVEYED = { lat: 41.8781, lon: -87.6298 }

const CENTROIDS: Record<string, { lat: number; lon: number }> = {
	[GEOID_SF]: CENTROID_SF,
	[GEOID_NY]: CENTROID_NY,
	[GEOID_DIVERGENT]: CENTROID_DIVERGENT,
}

function blockCentroids(geoid: string): { lat: number; lon: number } | undefined {
	return CENTROIDS[geoid]
}

const PROVIDER_A = 130_077
const PROVIDER_B = 130_080

/**
 * 5 rows, one location each, so one row per (geoid, provider, technology) triple keeps the
 * block-grain collapse a no-op and the criterion 3 census agrees without surprise collapsing:
 *
 * - SF: provider A / tech 50 / 1000 Mbps (gigabit), provider B / tech 40 / 80 Mbps (25-100)
 * - NY: provider A / tech 50 / 1000 Mbps (gigabit — same as SF so block_count sums to 2),
 *   provider B / tech 10 / 10 Mbps (under-25)
 * - Divergent: provider A / tech 30 / 500 Mbps (100-1000), queried only by the unification test.
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
		{
			geoid: GEOID_DIVERGENT,
			provider_id: PROVIDER_A,
			technology_code: 30,
			location_id: "DIVERGENT-A",
			max_advertised_download_speed: 500,
			max_advertised_upload_speed: 500,
			low_latency: 1,
			business_residential_code: "R",
		},
	]
}

let scratch: TemporaryDirectory
let out: PathBuilder

beforeAll(async () => {
	scratch = await temporaryDirectory("bdc-filing-landscape-")
	out = scratch.path("bdc.db")

	await buildBDCDatabase({
		rows: fixtureRows(),
		out,
		asOfDate: ASOF_DATE,
		buildSHA: "deadbeef",
		blockCentroids,
	})
})

afterAll(() => scratch[Symbol.asyncDispose]())

function openFixture(): DatabaseClient<BDCDatabase> {
	return new DatabaseClient<BDCDatabase>(out, { readOnly: true })
}

describe("filingLandscape — Check 1: interface conformance", () => {
	it("reads a manifest whose spine is res-9 h3, and stores h3_cell byte-compatible with shortCellToInt(latLngToCell(...))", async () => {
		using db = openFixture()
		const schemadb = db

		const manifest = await readLayerManifest(schemadb)
		expect(manifest.spineKeys.h3?.resolution).toBe(9)
		expect(BDC_H3_RESOLUTION).toBe(9)

		const row = await db
			.selectFrom("bdc_availability")
			.select("h3_cell")
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		const expectedCell = shortCellToInt(latLngToCell(CENTROID_SF.lat, CENTROID_SF.lon, 9) as H3Cell)
		expect(row.h3_cell).toBe(expectedCell)

		const result = await filingLandscape(db, { geoids: [GEOID_SF] })
		expect(result.vintage).toBe(ASOF_DATE)
	})
})

describe("filingLandscape — Check 2: meaning-of-zero", () => {
	it("reports a geoid absent from the fixture in unknown_block_count, never as a zero-filing claim", async () => {
		using db = openFixture()
		const schemadb = db

		// Independent honesty check on the fixture: an area never fed to the builder carries no
		// coverage row at all, proving the absence below is real rather than a query artifact.
		const neverSurveyedRes6 = shortCellToInt(
			latLngToCell(CENTROID_NEVER_SURVEYED.lat, CENTROID_NEVER_SURVEYED.lon, 6) as H3Cell
		)

		expect(await readLayerCoverage(schemadb, neverSurveyedRes6)).toBeUndefined()

		const knownOnly = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY] })
		const withUnknown = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY, GEOID_UNKNOWN] })

		expect(withUnknown.unknown_block_count).toBe(1)
		// surveyed_block_count is unchanged by the unknown geoid's presence:
		// it is never folded in as a (zero-filing) survey result.
		expect(withUnknown.surveyed_block_count).toBe(knownOnly.surveyed_block_count)
		expect(withUnknown.surveyed_block_count).toBe(2)

		// The unknown geoid must not silently appear as a zero-count entry in filings either;
		// it contributes no entry, so the filings for the two known blocks are identical either way.
		expect(withUnknown.filings).toEqual(knownOnly.filings)
	})
})

describe("filingLandscape — Check 2 (extended): coverage-check is required, not a rows-shortcut proxy", () => {
	// The criterion 2 test above never reaches `readLayerCoverage`: GEOID_UNKNOWN
	// has zero rows, so the "no candidate cell" shortcut alone classifies it,
	// and the coverage-check branch can be deleted without turning it red.
	// These two tests target that branch directly.
	it("(a) a geoid with real rows but a deleted coverage row is unknown, and its rows do not leak into filings", async () => {
		await using coverageScratch = await temporaryDirectory("bdc-filing-landscape-coverage-corrupt-")
		const corruptOut = coverageScratch.path("bdc.db")

		await buildBDCDatabase({
			rows: fixtureRows(),
			out: corruptOut,
			asOfDate: ASOF_DATE,
			buildSHA: "deadbeef",
			blockCentroids,
		})

		await changeMode(corruptOut, 0o644)

		using writable = await openBuiltClient<BDCDatabase>(corruptOut, { write: true })

		const sfRow = await writable
			.selectFrom("bdc_availability")
			.select("h3_cell")
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		const sfCoverageCell = res9ShortCellToRes6Parent(sfRow.h3_cell)

		const schemadb = writable
		// Sanity: the builder did write this coverage row, at the cell the reader derives,
		// so deleting it below is deliberate corruption rather than a pre-existing gap.
		expect(await readLayerCoverage(schemadb, sfCoverageCell)).toBeDefined()

		await schemadb.deleteFrom("layer_coverage").where("h3_cell", "=", sfCoverageCell).execute()
		expect(await readLayerCoverage(schemadb, sfCoverageCell)).toBeUndefined()

		const result = await filingLandscape(writable, { geoids: [GEOID_SF, GEOID_NY] })

		expect(result.unknown_block_count).toBe(1)
		expect(result.surveyed_block_count).toBe(1)

		// SF's rows must not leak into filings now that SF is unknown: the SF-only
		// (PROVIDER_B/tech40/25-100) entry is absent, and the shared PROVIDER_A/tech50 gigabit entry
		// drops from block_count 2 to 1 rather than staying at 2 as if SF still counted as surveyed.
		expect(result.filings).toEqual([
			{ provider_id: PROVIDER_A, technology_code: 50, speed_bucket: BDC_SPEED_BUCKET_GIGABIT, block_count: 1 },
			{ provider_id: PROVIDER_B, technology_code: 10, speed_bucket: BDC_SPEED_BUCKET_UNDER_25, block_count: 1 },
		])
	})

	it("(b) an h3Cells query against a never-surveyed cell is unknown, never a zero-filing claim", async () => {
		using db = openFixture()

		// The cell is supplied directly, so the coverage-check branch itself —
		// not a rows-existence proxy — is the only code path that can classify it.
		const neverSurveyedRes9Cell = shortCellToInt(
			latLngToCell(CENTROID_NEVER_SURVEYED.lat, CENTROID_NEVER_SURVEYED.lon, 9) as H3Cell
		)

		const result = await filingLandscape(db, { h3Cells: [neverSurveyedRes9Cell] })

		expect(result.unknown_block_count).toBe(1)
		expect(result.surveyed_block_count).toBe(0)
		expect(result.filings).toEqual([])
	})
})

describe("filingLandscape — builder/reader coverage-cell unification", () => {
	it("agrees with the builder's coverage cell even at a point where the two derivations used to disagree", async () => {
		using db = openFixture()
		const schemadb = db

		const row = await db
			.selectFrom("bdc_availability")
			.select("h3_cell")
			.where("geoid", "=", GEOID_DIVERGENT)
			.executeTakeFirstOrThrow()

		// Prove this is a genuinely divergent point before trusting the rest of the test:
		// the independent `latLngToCell(centroid, 6)` derivation, taken without reference to
		// the stored res-9 cell, disagrees with the reader's hierarchy-parent derivation here.
		// If this assertion ever stops holding (an h3-js upgrade changing cell boundaries), re-select the point.
		const oldBuggyDerivation = shortCellToInt(latLngToCell(CENTROID_DIVERGENT.lat, CENTROID_DIVERGENT.lon, 6) as H3Cell)
		const unifiedDerivation = res9ShortCellToRes6Parent(row.h3_cell)
		expect(unifiedDerivation).not.toBe(oldBuggyDerivation)

		// The builder must have written coverage under the unified derivation, not the direct res-6 one.
		expect(await readLayerCoverage(schemadb, unifiedDerivation)).toBeDefined()
		expect(await readLayerCoverage(schemadb, oldBuggyDerivation)).toBeUndefined()

		// End-to-end: this block must read back as surveyed with its own filing intact,
		// not unknown while filings still list it.
		const result = await filingLandscape(db, { geoids: [GEOID_DIVERGENT] })
		expect(result.surveyed_block_count).toBe(1)
		expect(result.unknown_block_count).toBe(0)

		expect(result.filings).toEqual([
			{ provider_id: PROVIDER_A, technology_code: 30, speed_bucket: BDC_SPEED_BUCKET_100_1000, block_count: 1 },
		])
	})
})

describe("filingLandscape — Check 3: hand-verified census", () => {
	it("returns the exact ProviderFilingSummary[] for 2 providers over 2 blocks", async () => {
		using db = openFixture()

		const result = await filingLandscape(db, { geoids: [GEOID_SF, GEOID_NY] })

		expect(result.surveyed_block_count).toBe(2)
		expect(result.unknown_block_count).toBe(0)

		// Hand-computed: PROVIDER_A/tech 50/gigabit appears at both blocks (block_count 2);
		// each PROVIDER_B row is distinct per block (25-100 at SF only, under-25 at NY only).
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

	it("rejects an empty geoids/h3Cells array rather than silently answering a vacuous all-zero landscape", async () => {
		// `[]` is truthy in JS, so it passes the "exactly one of geoids/h3Cells" XOR
		// check undetected; without an explicit length guard this would return an
		// all-zero result indistinguishable from a real one.
		// Reachable from the MCP tool layer, which is why both layers carry this guard.
		using db = openFixture()

		await expect(filingLandscape(db, { geoids: [] })).rejects.toThrow(/empty/)
		await expect(filingLandscape(db, { h3Cells: [] })).rejects.toThrow(/empty/)
	})
})

describe("filingLandscape — Check 4: vintage-or-throw", () => {
	it("throws when the manifest row is missing, rather than answering unstamped", async () => {
		await using corruptScratch = await temporaryDirectory("bdc-filing-landscape-corrupt-")
		const corruptOut = corruptScratch.path("bdc.db")

		await buildBDCDatabase({
			rows: fixtureRows(),
			out: corruptOut,
			asOfDate: ASOF_DATE,
			buildSHA: "deadbeef",
			blockCentroids,
		})

		// `buildBDCDatabase` seals (chmod 0444), so unseal before deleting the manifest row:
		// `openBuiltClient`'s `write: true` throws `SealedArtifactError` while still sealed.
		await changeMode(corruptOut, 0o644)
		expect(await pathExists(corruptOut)).toBe(true)

		using writable = await openBuiltClient<BDCDatabase>(corruptOut, { write: true })
		await writable.deleteFrom("layer_manifest").execute()

		await expect(filingLandscape(writable, { geoids: [GEOID_SF] })).rejects.toThrow(/manifest/)
	})
})

describe("speed bucket boundaries", () => {
	it.each([
		[0, BDC_SPEED_BUCKET_UNDER_25],
		[24, BDC_SPEED_BUCKET_UNDER_25],
		[25, BDC_SPEED_BUCKET_25_100],
		[99, BDC_SPEED_BUCKET_25_100],
		[100, BDC_SPEED_BUCKET_100_1000],
		[999, BDC_SPEED_BUCKET_100_1000],
		[1000, BDC_SPEED_BUCKET_GIGABIT],
	])("speedBucketForDownloadSpeed(%i) === %s", (speed, expectedBucket) => {
		expect(speedBucketForDownloadSpeed(speed)).toBe(expectedBucket)
	})

	describe("SQL CASE agrees with the JS mirror at every boundary", () => {
		// One geoid per boundary value, all at the same centroid
		// (the geoid string is what `filingLandscape` groups on), with the same provider/tech throughout,
		// so the SQL case's bucketing is the only thing that can split the resulting groups.
		const BOUNDARY_PROVIDER = 999_001
		const BOUNDARY_TECH = 99
		const BOUNDARY_SPEEDS = [0, 24, 25, 99, 100, 999, 1000] as const
		const boundaryGeoid = (speed: number) => `boundary-${speed}`

		let boundaryOut: PathBuilder

		beforeAll(async () => {
			boundaryOut = fixtures.use(await temporaryDirectory("bdc-filing-landscape-buckets-")).path("bdc.db")

			const rows: BDCAvailabilityRow[] = BOUNDARY_SPEEDS.map((speed) => ({
				geoid: boundaryGeoid(speed),
				provider_id: BOUNDARY_PROVIDER,
				technology_code: BOUNDARY_TECH,
				location_id: `boundary-loc-${speed}`,
				max_advertised_download_speed: speed,
				max_advertised_upload_speed: speed,
				low_latency: 1,
				business_residential_code: "R",
			}))

			await buildBDCDatabase({
				rows,
				out: boundaryOut,
				asOfDate: ASOF_DATE,
				buildSHA: "deadbeef",
				blockCentroids: () => CENTROID_SF,
			})
		})

		it("groups the 7 boundary speeds into exactly the 4 buckets the JS mirror predicts", async () => {
			using db = new DatabaseClient<BDCDatabase>(boundaryOut, { readOnly: true })

			const result = await filingLandscape(db, { geoids: BOUNDARY_SPEEDS.map(boundaryGeoid) })

			expect(result.surveyed_block_count).toBe(BOUNDARY_SPEEDS.length)
			expect(result.unknown_block_count).toBe(0)

			// {0,24} -> under-25 (2), {25,99} -> 25-100 (2), {100,999} -> 100-1000 (2), {1000} ->
			// gigabit (1): the SQL case's exclusive `<` comparisons land where
			// speedBucketForDownloadSpeed says they should, for every boundary value at once.
			const expectedGroups = new Map<string, number>()

			for (const speed of BOUNDARY_SPEEDS) {
				const bucket = speedBucketForDownloadSpeed(speed)
				expectedGroups.set(bucket, (expectedGroups.get(bucket) ?? 0) + 1)
			}

			expect(result.filings).toHaveLength(expectedGroups.size)

			for (const filing of result.filings) {
				expect(filing.provider_id).toBe(BOUNDARY_PROVIDER)
				expect(filing.technology_code).toBe(BOUNDARY_TECH)
				expect(filing.block_count).toBe(expectedGroups.get(filing.speed_bucket))
			}

			expect(new Set(result.filings.map((f) => f.speed_bucket))).toEqual(new Set(expectedGroups.keys()))
		})
	})
})
