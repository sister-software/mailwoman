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
 *   Fixture: 3 known blocks (SF, NY, and a THIRD block — "DIVERGENT" — chosen because its directly
 *   -indexed res-6 cell disagrees with its res-9 cell's H3 hierarchy parent, see fix round 1 below) × 2
 *   providers each at SF/NY, distinct techs/speeds landing in 3 different speed buckets, plus one geoid
 *   that is NEVER fed to the builder at all (Gate 2's "absent from the fixture" block). Gates 1–4 below
 *   query only `[GEOID_SF, GEOID_NY]` (or subsets), so adding DIVERGENT doesn't perturb their hand-counts
 *   — it's exercised only by the fix-round-1 tests that need it.
 *
 *   Fix round 1 (post-hoc review) additions, each addressing one reviewer finding against the original
 *   Task 9 submission:
 *
 *   - CRITICAL 1: the builder and reader used to derive a block's res-6 coverage cell two DIFFERENT ways
 *     (builder: `latLngToCell(centroid, 6)` directly; reader: `cellToParent(res9Cell, 6)`). H3's cell
 *     hierarchy is not geometrically exact — these disagree for ~6% of real points — so a genuinely
 *     surveyed block could read back as `unknown_block_count` while its own rows still populated
 *     `filings`, a self-contradiction (reproduced end-to-end against a brute-force-found divergent point
 *     before the fix). `build-bdc.ts` now derives both `h3_cell` and the coverage cell from the SAME full
 *     res-9 index; see that file's docstring. The "builder/reader coverage-cell unification" describe
 *     block below proves this holds even for the DIVERGENT block — chosen specifically because the OLD
 *     two-derivation approach would have disagreed for it (verified inline: the test asserts the two
 *     derivations DO differ for this point, before asserting the reader agrees with what the builder
 *     actually wrote).
 *   - CRITICAL 2: the original Gate 2 test was vacuous — it only ever exercised the "zero rows at all"
 *     shortcut (no candidate cell derivable), never the `readLayerCoverage` branch itself; deleting that
 *     branch entirely left every original test green. "Gate 2 (extended)" below adds a geoid that HAS
 *     rows but whose `layer_coverage` row is deliberately deleted post-build (a genuine coverage-check
 *     exercise), plus an `h3Cells`-form query against a cell that was never surveyed at all (that branch
 *     is the ONLY path for an `h3Cells` query — there's no "zero rows" shortcut available to it).
 *   - IMPORTANT: `speedBucketForDownloadSpeed` had zero direct assertions and the "100-1000" bucket was
 *     never exercised. "speed bucket boundaries" below adds a table test over the exact boundary values
 *     and a dedicated SQL-vs-JS agreement test so the SQL `CASE` and the JS mirror can't silently drift.
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
	res9ShortCellToRes6Parent,
	speedBucketForDownloadSpeed,
} from "./filing-landscape.ts"
import type { BDCAvailabilityRow } from "./parsing.ts"

const ASOF_DATE = "2026-07-15"

const GEOID_SF = "060750001001001"
const GEOID_NY = "360610001001001"
// A rural-Virginia point found by brute-force search over a CONUS bounding box specifically because its
// directly-indexed res-6 cell (`latLngToCell(_, 6)`) disagrees with its res-9 cell's H3 hierarchy parent
// (`cellToParent(latLngToCell(_, 9), 6)`) — the exact divergence class fix round 1's CRITICAL 1 fixes.
const GEOID_DIVERGENT = "510090101001001"
// Deliberately NEVER passed to `buildBDCDatabase` at all — Gate 2's "absent from the fixture" block.
const GEOID_UNKNOWN = "999999999999999"

const CENTROID_SF = { lat: 37.7749, lon: -122.4194 }
const CENTROID_NY = { lat: 40.7128, lon: -74.006 }
const CENTROID_DIVERGENT = { lat: 37.119, lon: -79.6658 }
// Never registered in `blockCentroids` — purely a coordinate the TEST uses to prove that area's res-6
// cell carries no coverage row at all (an independent check on the fixture's honesty, not something
// `filingLandscape` ever looks up for an unrouted geoid — it has no cell to look up in the first place).
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
 * 5 rows, one location each (`includeLocationIDs` stays default-off; ONE row per (geoid, provider, technology) triple
 * keeps the block-grain collapse a no-op, so `result.rows` and the hand-computed census in Gate 3 agree without any
 * surprise collapsing):
 *
 * - SF: provider A / tech 50 / 1000 Mbps (gigabit), provider B / tech 40 / 80 Mbps (25-100)
 * - NY: provider A / tech 50 / 1000 Mbps (gigabit — SAME bucket/tech/provider as SF, block_count sums to 2), provider B /
 *   tech 10 / 10 Mbps (under-25)
 * - DIVERGENT: provider A / tech 30 / 500 Mbps (100-1000) — not queried by Gates 1–4, only by the fix-round-1 tests.
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

describe("filingLandscape — Gate 2 (extended, fix round 1): coverage-check is load-bearing, not a rows-shortcut proxy", () => {
	// CRITICAL 2 (review): the ORIGINAL Gate 2 above never exercised `readLayerCoverage` at all — GEOID_UNKNOWN has
	// zero rows, so it's classified unknown by the "no candidate cell" shortcut alone. Deleting the coverage-check
	// branch entirely left every original test green. These two tests target the coverage-check branch directly:
	// (a) a geoid WITH rows whose coverage row is deliberately deleted, and (b) an `h3Cells` query — which has NO
	// rows-based shortcut available at all — against a cell that was never surveyed.
	let corruptScratch: string
	let corruptOut: string

	afterAll(async () => {
		if (corruptScratch) {
			await rm(corruptScratch, { recursive: true, force: true })
		}
	})

	it("(a) a geoid with real rows but a deleted coverage row is unknown, and its rows do not leak into filings", async () => {
		corruptScratch = await mkdtemp(join(tmpdir(), "bdc-filing-landscape-coverage-corrupt-"))
		corruptOut = join(corruptScratch, "bdc.db")

		await buildBDCDatabase({
			rows: fixtureRows(),
			out: corruptOut,
			asOfDate: ASOF_DATE,
			buildSHA: "deadbeef",
			blockCentroids,
		})

		chmodSync(corruptOut, 0o644)

		using writable = new DatabaseClient<BDCDatabase>({ database: openBuiltDatabase(corruptOut, { write: true }) })

		const sfRow = await writable
			.selectFrom("bdc_availability")
			.select("h3_cell")
			.where("geoid", "=", GEOID_SF)
			.executeTakeFirstOrThrow()

		const sfCoverageCell = res9ShortCellToRes6Parent(sfRow.h3_cell)

		const contractDB = writable as unknown as Kysely<LayerContractDatabase>
		// Sanity: the builder DID write this coverage row (fix round 1 unifies the two derivations) — deleting it
		// below is a deliberate corruption, not a pre-existing gap.
		expect(await readLayerCoverage(contractDB, sfCoverageCell)).toBeDefined()

		await contractDB.deleteFrom("layer_coverage").where("h3_cell", "=", sfCoverageCell).execute()
		expect(await readLayerCoverage(contractDB, sfCoverageCell)).toBeUndefined()

		const result = await filingLandscape(writable, { geoids: [GEOID_SF, GEOID_NY] })

		expect(result.unknown_block_count).toBe(1)
		expect(result.surveyed_block_count).toBe(1)

		// SF's rows must NOT leak into filings now that SF is unknown: the SF-only (PROVIDER_B/tech40/25-100)
		// entry must be absent entirely, and the gigabit entry PROVIDER_A/tech50 shares with NY must drop from
		// block_count 2 to 1 (NY only) — never silently kept at 2 as if SF still counted as surveyed.
		expect(result.filings).toEqual([
			{ provider_id: PROVIDER_A, technology_code: 50, speed_bucket: BDC_SPEED_BUCKET_GIGABIT, block_count: 1 },
			{ provider_id: PROVIDER_B, technology_code: 10, speed_bucket: BDC_SPEED_BUCKET_UNDER_25, block_count: 1 },
		])
	})

	it("(b) an h3Cells query against a never-surveyed cell is unknown, never a zero-filing claim", async () => {
		using db = openFixture()

		// h3Cells mode has NO "zero rows" shortcut — the cell is supplied directly, so this is the ONLY code path
		// that can classify it, proving the coverage-check branch itself (not a rows-existence proxy) is what runs.
		const neverSurveyedRes9Cell = shortCellToInt(
			latLngToCell(CENTROID_NEVER_SURVEYED.lat, CENTROID_NEVER_SURVEYED.lon, 9) as H3Cell
		)

		const result = await filingLandscape(db, { h3Cells: [neverSurveyedRes9Cell] })

		expect(result.unknown_block_count).toBe(1)
		expect(result.surveyed_block_count).toBe(0)
		expect(result.filings).toEqual([])
	})
})

describe("filingLandscape — fix round 1 (CRITICAL 1): builder/reader coverage-cell unification", () => {
	it("agrees with the builder's coverage cell even at a point where the two derivations used to disagree", async () => {
		using db = openFixture()
		const contractDB = db as unknown as Kysely<LayerContractDatabase>

		const row = await db
			.selectFrom("bdc_availability")
			.select("h3_cell")
			.where("geoid", "=", GEOID_DIVERGENT)
			.executeTakeFirstOrThrow()

		// Prove this is a genuinely divergent point BEFORE trusting the rest of the test: the old (buggy) builder
		// derivation — `latLngToCell(centroid, 6)` independent of the stored res-9 cell — disagrees with the
		// reader's hierarchy-parent derivation for this exact point. If this assertion ever stops holding (e.g. an
		// h3-js upgrade changes cell boundaries), the point needs re-selecting via a fresh brute-force search.
		const oldBuggyDerivation = shortCellToInt(latLngToCell(CENTROID_DIVERGENT.lat, CENTROID_DIVERGENT.lon, 6) as H3Cell)
		const unifiedDerivation = res9ShortCellToRes6Parent(row.h3_cell)
		expect(unifiedDerivation).not.toBe(oldBuggyDerivation)

		// The builder (fixed) must have written coverage under the UNIFIED derivation, not the old buggy one.
		expect(await readLayerCoverage(contractDB, unifiedDerivation)).toBeDefined()
		expect(await readLayerCoverage(contractDB, oldBuggyDerivation)).toBeUndefined()

		// End-to-end: this block must read back as surveyed, with its own filing intact — the exact
		// self-contradiction (unknown_block_count claiming "never surveyed" while filings shows a real entry for
		// it) the review reproduced against the pre-fix code is what this proves absent.
		const result = await filingLandscape(db, { geoids: [GEOID_DIVERGENT] })
		expect(result.surveyed_block_count).toBe(1)
		expect(result.unknown_block_count).toBe(0)

		expect(result.filings).toEqual([
			{ provider_id: PROVIDER_A, technology_code: 30, speed_bucket: BDC_SPEED_BUCKET_100_1000, block_count: 1 },
		])
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

	it("rejects an empty geoids/h3Cells array rather than silently answering a vacuous all-zero landscape", async () => {
		// `[]` is truthy in JS, so it passes the "exactly one of geoids/h3Cells" XOR check undetected — without an
		// explicit length guard this would otherwise return `{ surveyed_block_count: 0, unknown_block_count: 0,
		// filings: [] }`, indistinguishable from a real (if uninteresting) result instead of the malformed-query
		// error an empty query actually is. Reachable from the MCP tool layer (`mcp/tools.ts`), which is why both
		// layers carry this guard.
		using db = openFixture()

		await expect(filingLandscape(db, { geoids: [] })).rejects.toThrow(/empty/)
		await expect(filingLandscape(db, { h3Cells: [] })).rejects.toThrow(/empty/)
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

describe("speed bucket boundaries (fix round 1)", () => {
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
		// One geoid per boundary value, all at the SAME centroid (the geoid string, not location, is what
		// `filingLandscape` groups on) — same provider/tech throughout, so the ONLY thing that can split the
		// resulting groups is the SQL CASE's bucketing of `max_advertised_download_speed`.
		const BOUNDARY_PROVIDER = 999_001
		const BOUNDARY_TECH = 99
		const BOUNDARY_SPEEDS = [0, 24, 25, 99, 100, 999, 1000] as const
		const boundaryGeoid = (speed: number) => `boundary-${speed}`

		let boundaryScratch: string
		let boundaryOut: string

		beforeAll(async () => {
			boundaryScratch = await mkdtemp(join(tmpdir(), "bdc-filing-landscape-buckets-"))
			boundaryOut = join(boundaryScratch, "bdc.db")

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

		afterAll(async () => {
			await rm(boundaryScratch, { recursive: true, force: true })
		})

		it("groups the 7 boundary speeds into exactly the 4 buckets the JS mirror predicts", async () => {
			using db = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(boundaryOut, { readOnly: true }) })

			const result = await filingLandscape(db, { geoids: BOUNDARY_SPEEDS.map(boundaryGeoid) })

			expect(result.surveyed_block_count).toBe(BOUNDARY_SPEEDS.length)
			expect(result.unknown_block_count).toBe(0)

			// Hand-grouped via the JS mirror itself: {0,24} -> under-25 (2), {25,99} -> 25-100 (2),
			// {100,999} -> 100-1000 (2), {1000} -> gigabit (1) — proving the SQL CASE's exclusive `<` comparisons
			// land exactly where speedBucketForDownloadSpeed says they should, for every boundary value at once.
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
