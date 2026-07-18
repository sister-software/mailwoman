/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildPOIDatabase} — the load/materialize/seal phase of `poi.db` (spec §3.4).
 *   Feeds the loader a synthetic row source directly (an injected `Iterable<POISourceRow>`), so the
 *   suite exercises the whole build WITHOUT touching DuckDB/network — `ingestPlaces` (the Overture
 *   S3 parquet phase) is covered separately, and its schema-probe logic is exercised as a pure
 *   function over `DESCRIBE` rows in `overture-places-schema.test.ts`.
 *
 *   Fixture: 30 rows across 2 countries (US, FR) × 3 categories (cafe, restaurant, museum), 5 rows
 *   per (country, category) pair at ~3m lat jitter (well inside a res-9 cell, so a group clusters
 *   into the SAME `h3_cell`) with 5 distinct confidence values — plus 2 rows with non-finite
 *   coordinates the loader must skip (and count) rather than insert.
 */

import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerCoverage, readLayerManifest } from "@mailwoman/core/layers"
import { POILookup } from "@mailwoman/resolver-wof-sqlite/poi-lookup"
import type { POICategoryCodeTable, POIDatabase } from "@mailwoman/resolver-wof-sqlite/poi-schema"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { buildPOIDatabase, type POISourceRow } from "./build-poi.ts"

const SPRINGFIELD = { latitude: 39.7817, longitude: -89.6501, country: "US" as const }
const PARIS = { latitude: 48.8566, longitude: 2.3522, country: "FR" as const }
const CATEGORIES = ["cafe", "restaurant", "museum"] as const
/** ~3m lat steps — well under a res-9 hex's ~174m edge, so a (country, category) group clusters into one cell. */
const JITTER_DEG = 0.00003

function* fixtureRows(): Iterable<POISourceRow> {
	let gersCounter = 0

	for (const loc of [SPRINGFIELD, PARIS]) {
		for (const category of CATEGORIES) {
			for (let n = 0; n < 5; n++) {
				gersCounter++
				yield {
					name: `${loc.country} ${category} #${n}`,
					category,
					brandWikidata: n === 0 ? "Q00000" : null,
					latitude: loc.latitude + n * JITTER_DEG,
					longitude: loc.longitude,
					country: loc.country,
					confidence: 0.85 + n * 0.03,
					gersID: `gers-${gersCounter}`,
				}
			}
		}
	}

	// Non-finite coordinates — the loader must SKIP + count these, never insert garbage.
	yield {
		name: "Bad NaN",
		category: "cafe",
		brandWikidata: null,
		latitude: Number.NaN,
		longitude: -89,
		country: "US",
		confidence: 0.9,
		gersID: "bad-nan",
	}
	yield {
		name: "Bad Infinity",
		category: "cafe",
		brandWikidata: null,
		latitude: 39,
		longitude: Number.POSITIVE_INFINITY,
		country: "US",
		confidence: 0.9,
		gersID: "bad-inf",
	}
}

let scratch: string
let out: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "poi-build-"))
	out = join(scratch, "poi.db")
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

describe("buildPOIDatabase", () => {
	it("loads, clusters, dictionary-encodes, seals, and is end-to-end queryable via POILookup", async () => {
		const result = await buildPOIDatabase({
			rows: fixtureRows(),
			out,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-18T00:00:00Z",
		})

		expect(result.rows).toBe(30)
		expect(result.skipped).toBe(2)
		expect(result.categories).toBe(3)
		// Per-country counts: 15 rows kept for each of US/FR (3 categories × 5 rows) — the 2 skipped
		// non-finite-coordinate rows (both nominally "US") are NOT counted, per the Map's contract.
		expect(Object.fromEntries(result.countries)).toEqual({ US: 15, FR: 15 })

		// --- sealed: no write bits ---
		expect(statSync(out).mode & 0o222).toBe(0)

		// `kdb`'s dispose closes the underlying connection — don't ALSO `using` `raw`, or both dispose
		// paths race to close() the same DatabaseSync and one throws "database is not open".
		const raw = new DatabaseSync(out, { readOnly: true })
		using kdb = new DatabaseClient<POIDatabase>({ database: raw })

		// --- dictionary round-trip: insert-on-first-sight, 0 reserved for uncategorized ---
		const codes = (await kdb.selectFrom("poi_category_codes").selectAll().execute()) as POICategoryCodeTable[]
		expect(codes.map((c) => c.category).sort()).toEqual(["cafe", "museum", "restaurant"])
		expect(codes.every((c) => c.id > 0)).toBe(true)
		const cafeID = codes.find((c) => c.category === "cafe")!.id

		// --- clustered order on disk: the (h3_cell, category_id) group's FIRST physical row (no
		// ORDER BY — relying on the WITHOUT ROWID clustered-key order) is the best-confidence one. ---
		const group = await kdb
			.selectFrom("poi")
			.select(["h3_cell", "confidence"])
			.where("category_id", "=", cafeID)
			.where("country", "=", "US")
			.execute()
		expect(group.length).toBe(5)
		const clusterCell = group[0]!.h3_cell
		expect(group.every((r) => r.h3_cell === clusterCell)).toBe(true) // all 5 jittered into one res-9 cell

		const firstPhysicalRow = await kdb
			.selectFrom("poi")
			.select(["confidence"])
			.where("h3_cell", "=", clusterCell)
			.where("category_id", "=", cafeID)
			.executeTakeFirstOrThrow()
		const maxConfidence = Math.max(...group.map((r) => r.confidence))
		expect(firstPhysicalRow.confidence).toBeCloseTo(maxConfidence, 10)

		// --- manifest reads back valid ---
		const manifest = await readLayerManifest(kdb)
		expect(manifest).toMatchObject({
			name: "poi",
			tier: "shipped",
			license: "CDLA-Permissive-2.0",
			attribution: "Overture Maps Foundation",
			source: "overture-places",
			sourceVintage: "2026-05-20.0",
			buildCmd: "mailwoman gazetteer build poi",
			buildSHA: "deadbeef",
			freshnessPolicy: "sealed",
			spineKeys: { h3: { column: "h3_cell", resolution: 9 } },
			createdAt: "2026-07-18T00:00:00Z",
		})

		// --- coverage rows exist at res 6 ---
		expect(result.coverageCells).toBeGreaterThan(0)
		const coverageRows = await kdb.selectFrom("layer_coverage").selectAll().execute()
		expect(coverageRows.length).toBe(result.coverageCells)
		expect(coverageRows.every((c) => c.observed_rows > 0 && c.completeness === 1)).toBe(true)
		const totalObserved = coverageRows.reduce((sum, c) => sum + c.observed_rows, 0)
		expect(totalObserved).toBe(30)
		// Meaning-of-zero: an unsurveyed cell is UNKNOWN, never present with completeness 0.
		expect(await readLayerCoverage(kdb, 999_999_999)).toBeUndefined()

		// --- end-to-end via Task 2's POILookup reader ---
		using lookup = new POILookup({ databasePath: out })
		const cafeHits = lookup.search({ categoryID: "cafe", center: SPRINGFIELD, limit: 5 })
		expect(cafeHits.length).toBeGreaterThan(0)
		expect(cafeHits.every((h) => h.name?.startsWith("US cafe"))).toBe(true)
		// Nearest (n=0) row carries the highest confidence in the fixture too.
		expect(cafeHits[0]!.confidence).toBeCloseTo(0.85, 10)

		const brandHits = lookup.search({ brandWikidata: "Q00000", center: SPRINGFIELD, limit: 10 })
		expect(brandHits.some((h) => h.brandWikidata === "Q00000")).toBe(true)

		const nameHits = lookup.search({ name: "restaurant" })
		expect(nameHits.some((h) => h.name?.includes("restaurant"))).toBe(true)
	})

	it("bootstraps missing intermediate output directories", async () => {
		const nestedOut = join(scratch, "nested", "deeper", "poi.db")

		const result = await buildPOIDatabase({
			rows: fixtureRows(),
			out: nestedOut,
			release: "2026-05-20.0",
			buildSHA: "deadbeef",
			createdAt: "2026-07-18T00:00:00Z",
		})

		expect(result.rows).toBe(30)
		expect(statSync(nestedOut).isFile()).toBe(true)
	})
})
