// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import type { LatLonBounds as BrowseBox } from "@mailwoman/spatial/bbox"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, describe, expect, test } from "vitest"

import { WOFPlaceBrowser } from "#browse"

/**
 * The probe limit the browser is built with, small so the fixture stays small.
 */
const EXTENT_PROBE_LIMIT = 500

type BrowseDatabase = NonNullable<ConstructorParameters<typeof WOFPlaceBrowser>[0]["database"]>

type BrowseTables = BrowseDatabase extends DatabaseClient<infer DB> ? DB : never

/**
 * A gazetteer with more R*Tree extents than {@link EXTENT_PROBE_LIMIT}, so a world box takes
 * the primary-key plan and a small box the R*Tree plan, and with the two kinds of place the
 * R*Tree misses: one whose point lies outside its extent, and one with no extent at all.
 */
function buildGazetteer(): BrowseDatabase {
	const db = DatabaseClient.temp<BrowseTables>()

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE VIRTUAL TABLE place_bbox USING rtree(id, min_lat, max_lat, min_lon, max_lon);
	`)

	const place = db.prepare("INSERT INTO spr VALUES (?, ?, 'locality', 'XX', ?, ?, ?, ?, ?, ?, ?, 0)")
	const extent = db.prepare("INSERT INTO place_bbox VALUES (?, ?, ?, ?, ?)")

	db.exec("BEGIN")

	// A grid spread over the world, each place's extent a small box around its point.
	for (let id = 1; id <= EXTENT_PROBE_LIMIT + 500; id++) {
		const lat = ((id * 37) % 170) - 85 + 0.5
		const lon = ((id * 53) % 358) - 179 + 0.5

		place.run(id, `Place ${id}`, lat, lon, lat - 0.1, lat + 0.1, lon - 0.1, lon + 0.1, 1)
		extent.run(id, lat - 0.1, lat + 0.1, lon - 0.1, lon + 0.1)
	}

	const base = EXTENT_PROBE_LIMIT + 1000

	// Inside the test box by its point, while its extent lies far away.
	place.run(base + 1, "Point outside extent", 10.5, 10.5, -60, -59, -60, -59, 1)
	extent.run(base + 1, -60, -59, -60, -59)
	// Inside the test box with no extent, so it has no R*Tree row.
	place.run(base + 2, "No extent", 10.6, 10.6, null, null, null, null, 1)
	// Not current, so never served.
	place.run(base + 3, "Retired", 10.7, 10.7, 10.6, 10.8, 10.6, 10.8, 0)
	extent.run(base + 3, 10.6, 10.8, 10.6, 10.8)
	// Across the antimeridian.
	place.run(base + 4, "Fiji", -17.5, 179.5, -17.6, -17.4, 179.4, 179.6, 1)
	extent.run(base + 4, -17.6, -17.4, 179.4, 179.6)
	place.run(base + 5, "Samoa side", -17.5, -179.5, -17.6, -17.4, -179.6, -179.4, 1)
	extent.run(base + 5, -17.6, -17.4, -179.6, -179.4)

	db.exec("COMMIT")

	return db
}

const db = buildGazetteer()
const browser = new WOFPlaceBrowser({ database: db, extentProbeLimit: EXTENT_PROBE_LIMIT })

afterAll(() => {
	browser[Symbol.dispose]()
	db.destroy()
})

/**
 * Every current place whose point lies in the box, in id order, by a full scan.
 */
function scan(box: BrowseBox): number[] {
	const rows = db.prepare("SELECT id, latitude, longitude FROM spr WHERE is_current != 0 ORDER BY id").all() as Array<{
		id: number
		latitude: number
		longitude: number
	}>

	return rows
		.filter(({ latitude, longitude }) => {
			const inLongitude =
				box.minLon <= box.maxLon
					? longitude >= box.minLon && longitude <= box.maxLon
					: longitude >= box.minLon || longitude <= box.maxLon

			return inLongitude && latitude >= box.minLat && latitude <= box.maxLat
		})
		.map(({ id }) => id)
}

async function pageThrough(box: BrowseBox | null, limit: number): Promise<number[]> {
	const seen: number[] = []
	let after: number | null = null

	for (;;) {
		const page = await browser.page({ box, after, limit })

		seen.push(...page.map(({ id }) => id))

		if (page.length < limit) return seen

		after = page.at(-1)!.id
	}
}

describe("WOFPlaceBrowser", () => {
	test("a small box, read through the R*Tree, returns every place whose point it holds, including those the R*Tree misses", async () => {
		const box = { minLon: 10, minLat: 10, maxLon: 11, maxLat: 11 }
		const paged = await pageThrough(box, 2)

		expect(paged).toEqual(scan(box))
		expect(paged).toEqual(expect.arrayContaining([EXTENT_PROBE_LIMIT + 1001, EXTENT_PROBE_LIMIT + 1002]))
		expect(paged).not.toContain(EXTENT_PROBE_LIMIT + 1003)
	})

	test("a box across the antimeridian holds the places on both sides of it", async () => {
		const box = { minLon: 179, minLat: -18, maxLon: -179, maxLat: -17 }

		expect(await pageThrough(box, 1)).toEqual(scan(box))
		expect(scan(box)).toEqual(expect.arrayContaining([EXTENT_PROBE_LIMIT + 1004, EXTENT_PROBE_LIMIT + 1005]))
	})

	test("a world box, read in primary-key order, pages through every current place once", async () => {
		const world = { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 }

		expect(await pageThrough(world, 50)).toEqual(scan(world))
	})

	test("a place is read by id only while it is current", async () => {
		expect((await browser.place(EXTENT_PROBE_LIMIT + 1002))?.name).toBe("No extent")
		expect(await browser.place(EXTENT_PROBE_LIMIT + 1003)).toBeNull()
	})
})
