/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildBDCDatabase} — the stage/materialize/seal build of `bdc.db` (2a Task 8).
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
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import type { LayerContractDatabase } from "@mailwoman/core/layers"
import type { Kysely } from "kysely"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

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
