/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The #1726 centroid pin: the WOF ingest prefers the label centroid over the math centroid, and never mixes the two.
 *
 *   The math centroid is wrong exactly where a point matters most — a multipolygon spanning overseas territories pulls
 *   it off the mainland (France's `geom:` point is 42.19, -2.74, inside Spain; its `lbl:` point is 46.71, 2.46,
 *   metropolitan France). Both fixtures below are shaped from that real record.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { ingestWOF } from "mailwoman/gazetteer-pipeline/admin/ingest-wof"
import { afterAll, describe, expect, it } from "vitest"

const ROOT = mkdtempSync(join(tmpdir(), "mw-ingest-wof-"))
const DATA_DIR = join(ROOT, "whosonfirst-data-admin-xx", "data", "000", "000")

function feature(id: number, props: Record<string, unknown>): string {
	return JSON.stringify({
		type: "Feature",
		properties: {
			"wof:id": id,
			"wof:name": `Place ${id}`,
			"wof:placetype": "country",
			"wof:country": "XX",
			"wof:parent_id": -1,
			"wof:lastmodified": 1,
			...props,
		},
	})
}

mkdirSync(DATA_DIR, { recursive: true })

// France-shaped: both centroids present, 600 km apart. The ingest must store lbl:, whole.
writeFileSync(
	join(DATA_DIR, "1.geojson"),
	feature(1, {
		"geom:latitude": 42.191716,
		"geom:longitude": -2.735141,
		"lbl:latitude": 46.714842,
		"lbl:longitude": 2.464483,
	})
)

// No label centroid: the math centroid remains the fallback.
writeFileSync(join(DATA_DIR, "2.geojson"), feature(2, { "geom:latitude": 10.5, "geom:longitude": 20.25 }))

// A lone lbl:latitude with no longitude must NOT produce a mixed point — geom: wins as a pair.
writeFileSync(
	join(DATA_DIR, "3.geojson"),
	feature(3, { "geom:latitude": 30, "geom:longitude": 40, "lbl:latitude": 55 })
)

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true })
})

describe("ingestWOF centroids (#1726)", () => {
	it("stores the label centroid when present, the math centroid otherwise, and never a mix", async () => {
		await using db = new DatabaseClient<WOFDatabase>(":memory:")

		await createUnifiedSchema(db)
		await ingestWOF(db, { dataDir: ROOT })

		const rows = db.prepare("SELECT id, latitude, longitude FROM spr ORDER BY id").all() as Array<{
			id: number
			latitude: number
			longitude: number
		}>

		expect(rows).toEqual([
			{ id: 1, latitude: 46.714842, longitude: 2.464483 },
			{ id: 2, latitude: 10.5, longitude: 20.25 },
			{ id: 3, latitude: 30, longitude: 40 },
		])
	})
})

describe("ingestWOF label-point adjudication (#1905)", () => {
	it("a Washington-shaped record stores the geometric point when the anchor overrides, and reports the count", async () => {
		const root = mkdtempSync(join(tmpdir(), "mw-ingest-anchor-"))
		const dataDir = join(root, "whosonfirst-data-admin-us", "data", "000", "000")

		mkdirSync(dataDir, { recursive: true })

		writeFileSync(
			join(dataDir, "9.geojson"),
			feature(9, {
				"wof:placetype": "locality",
				"wof:country": "US",
				"wof:concordances": { "gn:id": 4_140_963 },
				"geom:latitude": 38.904831,
				"geom:longitude": -77.016216,
				"lbl:latitude": 38.82652,
				"lbl:longitude": -77.01712,
			})
		)

		const db = new DatabaseClient<WOFDatabase>(":memory:")

		await createUnifiedSchema(db)

		const result = await ingestWOF(db, {
			dataDir: root,
			anchorLookup: (country, gnID) =>
				country === "US" && String(gnID) === "4140963" ? { latitude: 38.89511, longitude: -77.03637 } : undefined,
		})

		const row = db.prepare("SELECT latitude, longitude FROM spr WHERE id = 9").get() as {
			latitude: number
			longitude: number
		}

		expect(row).toEqual({ latitude: 38.904831, longitude: -77.016216 })
		expect(result.labelPointOverrides).toBe(1)

		await db.destroy()
		rmSync(root, { recursive: true, force: true })
	})

	it("without a lookup the label preference is unchanged and the override count is a measured zero", async () => {
		await using db = new DatabaseClient<WOFDatabase>(":memory:")

		await createUnifiedSchema(db)

		const result = await ingestWOF(db, { dataDir: ROOT })

		expect(result.labelPointOverrides).toBe(0)
	})
})

describe("ingestWOF adjudication scope (#1905)", () => {
	it("a REGION with an anchor near its geometric centroid keeps the label point — the Texas shape", async () => {
		const root = mkdtempSync(join(tmpdir(), "mw-ingest-region-"))
		const dataDir = join(root, "whosonfirst-data-admin-us", "data", "000", "000")

		mkdirSync(dataDir, { recursive: true })

		// Modeled on wof:85688753 (Texas): lbl at the label placement, geom at the polygon centroid,
		// and the GeoNames admin1 record sitting near the CENTROID — the anchor premise inverted.
		writeFileSync(
			join(dataDir, "8.geojson"),
			feature(8, {
				"wof:placetype": "region",
				"wof:country": "US",
				"wof:concordances": { "gn:id": 4_736_286 },
				"geom:latitude": 31.447215,
				"geom:longitude": -99.317137,
				"lbl:latitude": 31.030974,
				"lbl:longitude": -98.326329,
			})
		)

		const db = new DatabaseClient<WOFDatabase>(":memory:")

		await createUnifiedSchema(db)

		const result = await ingestWOF(db, {
			dataDir: root,
			anchorLookup: () => ({ latitude: 31.25, longitude: -99.25 }),
		})

		const row = db.prepare("SELECT latitude, longitude FROM spr WHERE id = 8").get() as {
			latitude: number
			longitude: number
		}

		expect(row).toEqual({ latitude: 31.030974, longitude: -98.326329 })
		expect(result.labelPointOverrides).toBe(0)

		await db.destroy()
		rmSync(root, { recursive: true, force: true })
	})
})
