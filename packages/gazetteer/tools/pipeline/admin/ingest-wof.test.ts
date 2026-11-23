// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The WOF ingest prefers the label centroid over the math centroid and keeps the two separate.
 *
 *   For a multipolygon spanning overseas territories, the math centroid can land off the mainland.
 *   Those cases are where a useful point matters most.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/schema/unified"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, describe, expect, it } from "vitest"

import { ingestWOF } from "#tools/pipeline/admin/ingest-wof"

const ROOT = await temporaryDirectory("mw-ingest-wof-")
const DATA_DIR = ROOT.path("whosonfirst-data-admin-xx", "data", "000", "000")

function feature(id: number, props: Record<string, unknown>): string {
	return stringifyJSON({
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

await makeDirectories(DATA_DIR)

// France-shaped: both centroids present, 600 km apart.
// The ingest must store lbl:, whole.
await writeLocalFile(
	feature(1, {
		"geom:latitude": 42.191716,
		"geom:longitude": -2.735141,
		"lbl:latitude": 46.714842,
		"lbl:longitude": 2.464483,
	}),
	DATA_DIR("1.geojson")
)

// No label centroid: the math centroid remains the fallback.
await writeLocalFile(feature(2, { "geom:latitude": 10.5, "geom:longitude": 20.25 }), DATA_DIR("2.geojson"))

// A lone lbl:latitude with no longitude mustn't produce a mixed point, so geom: wins as a pair.
await writeLocalFile(
	feature(3, { "geom:latitude": 30, "geom:longitude": 40, "lbl:latitude": 55 }),
	DATA_DIR("3.geojson")
)

afterAll(() => ROOT[Symbol.asyncDispose]())

describe("ingestWOF centroids (#1726)", () => {
	it("stores the label centroid when present, the math centroid otherwise, and never a mix", async () => {
		using db = DatabaseClient.temp<WOFDatabase>()

		await createUnifiedSchema(db)
		await ingestWOF(db, { dataDir: ROOT.path, recordStore: ROOT.path("records.db") })

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

describe("ingestWOF directory symlinks", () => {
	it("reads a checkout through its direct path once when the nested layout is an alias", async () => {
		await using rootDirectory = await temporaryDirectory("mw-ingest-symlink-")
		const root = rootDirectory.path
		const repo = root("whosonfirst-data-admin-us")
		const dataDir = repo("data", "000", "000")

		await makeDirectories(dataDir)
		await writeLocalFile(feature(42, {}), dataDir("42.geojson"))
		await createSymbolicLink(repo, root("whosonfirst-data", "whosonfirst-data-admin-us"))

		using db = DatabaseClient.temp<WOFDatabase>()
		await createUnifiedSchema(db)

		const result = await ingestWOF(db, { dataDir: root, recordStore: root("records.db") })

		expect(result.filesFound).toBe(1)
		expect(result.placesIngested).toBe(1)
	})
})

describe("ingestWOF label-point adjudication (#1905)", () => {
	it("a Washington-shaped record stores the geometric point when the anchor overrides, and reports the count", async () => {
		await using rootDirectory = await temporaryDirectory("mw-ingest-anchor-")
		const root = rootDirectory.path
		const dataDir = root("whosonfirst-data-admin-us", "data", "000", "000")

		await makeDirectories(dataDir)

		await writeLocalFile(
			feature(9, {
				"wof:placetype": "locality",
				"wof:country": "US",
				"wof:concordances": { "gn:id": 4_140_963 },
				"geom:latitude": 38.904831,
				"geom:longitude": -77.016216,
				"lbl:latitude": 38.82652,
				"lbl:longitude": -77.01712,
			}),
			dataDir("9.geojson")
		)

		using db = DatabaseClient.temp<WOFDatabase>()

		await createUnifiedSchema(db)

		const result = await ingestWOF(db, {
			dataDir: root,
			recordStore: root("records.db"),
			anchorLookup: async (country, gnID) =>
				country === "US" && String(gnID) === "4140963" ? { latitude: 38.89511, longitude: -77.03637 } : null,
		})

		const row = db.prepare("SELECT latitude, longitude FROM spr WHERE id = 9").get() as {
			latitude: number
			longitude: number
		}

		expect(row).toEqual({ latitude: 38.904831, longitude: -77.016216 })
		expect(result.labelPointOverrides).toBe(1)
	})

	it("without a lookup the label preference is unchanged and the override count is a measured zero", async () => {
		using db = DatabaseClient.temp<WOFDatabase>()

		await createUnifiedSchema(db)

		const result = await ingestWOF(db, { dataDir: ROOT.path, recordStore: ROOT.path("records.db") })

		expect(result.labelPointOverrides).toBe(0)
	})
})

describe("ingestWOF adjudication scope (#1905)", () => {
	it("a REGION with an anchor near its geometric centroid keeps the label point — the Texas shape", async () => {
		await using rootDirectory = await temporaryDirectory("mw-ingest-region-")
		const root = rootDirectory.path
		const dataDir = root("whosonfirst-data-admin-us", "data", "000", "000")

		await makeDirectories(dataDir)

		// Modeled on wof:85688753 (Texas).
		// `lbl` is at the label placement and `geom` is at the polygon centroid.
		// The GeoNames admin1 record sits near the centroid and reverses the anchor premise.
		await writeLocalFile(
			feature(8, {
				"wof:placetype": "region",
				"wof:country": "US",
				"wof:concordances": { "gn:id": 4_736_286 },
				"geom:latitude": 31.447215,
				"geom:longitude": -99.317137,
				"lbl:latitude": 31.030974,
				"lbl:longitude": -98.326329,
			}),
			dataDir("8.geojson")
		)

		using db = DatabaseClient.temp<WOFDatabase>()

		await createUnifiedSchema(db)

		const result = await ingestWOF(db, {
			dataDir: root,
			recordStore: root("records.db"),
			anchorLookup: async () => ({ latitude: 31.25, longitude: -99.25 }),
		})

		const row = db.prepare("SELECT latitude, longitude FROM spr WHERE id = 8").get() as {
			latitude: number
			longitude: number
		}

		expect(row).toEqual({ latitude: 31.030974, longitude: -98.326329 })
		expect(result.labelPointOverrides).toBe(0)
	})
})

describe("ingestWOF extents (#3164)", () => {
	it("widens each located record's extent to its stored point and leaves an unlocated record unlocated", async () => {
		await using rootDirectory = await temporaryDirectory("mw-ingest-extent-")
		const root = rootDirectory.path
		const dataDir = root("whosonfirst-data-admin-au", "data", "000", "000")

		await makeDirectories(dataDir)

		// Modeled on wof:85768715: a point geometry whose label point lies 1 km away.
		await writeLocalFile(
			feature(11, {
				"wof:placetype": "neighbourhood",
				"geom:bbox": "145.055017,-37.81984,145.055017,-37.81984",
				"geom:latitude": -37.81984,
				"geom:longitude": 145.055017,
				"lbl:latitude": -37.820951,
				"lbl:longitude": 145.044274,
			}),
			dataDir("11.geojson")
		)

		// Modeled on wof:421166765: WOF rounds the geometry point to fewer decimals than its bbox.
		await writeLocalFile(
			feature(12, {
				"wof:placetype": "locality",
				"geom:bbox": "4.2972845,36.5756625,4.2972845,36.5756625",
				"geom:latitude": 36.575662,
				"geom:longitude": 4.297284,
			}),
			dataDir("12.geojson")
		)

		// Modeled on wof:1125269345: no location at all, recorded as zeros.
		await writeLocalFile(
			feature(13, {
				"wof:placetype": "localadmin",
				"geom:bbox": "0.0,0.0,0.0,0.0",
				"geom:latitude": 0,
				"geom:longitude": 0,
				"lbl:latitude": 0,
				"lbl:longitude": 0,
			}),
			dataDir("13.geojson")
		)

		using db = DatabaseClient.temp<WOFDatabase>()

		await createUnifiedSchema(db)
		await ingestWOF(db, { dataDir: root, recordStore: root("records.db") })

		const rows = db
			.prepare(
				"SELECT id, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude FROM spr ORDER BY id"
			)
			.all() as Array<Record<string, number>>

		expect(rows).toEqual([
			{
				id: 11,
				latitude: -37.820951,
				longitude: 145.044274,
				min_latitude: -37.820951,
				min_longitude: 145.044274,
				max_latitude: -37.81984,
				max_longitude: 145.055017,
			},
			{
				id: 12,
				latitude: 36.575662,
				longitude: 4.297284,
				min_latitude: 36.575662,
				min_longitude: 4.297284,
				max_latitude: 36.5756625,
				max_longitude: 4.2972845,
			},
			{
				id: 13,
				latitude: 0,
				longitude: 0,
				min_latitude: 0,
				min_longitude: 0,
				max_latitude: 0,
				max_longitude: 0,
			},
		])
	})
})
