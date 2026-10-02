/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the browser POI category search against a synthetic in-memory `poi` table, read
 *   through a node:sqlite-backed stub of the range-read database handle.
 */

import { type H3Cell, shortCellToInt } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToLatLng, gridDisk, latLngToCell } from "h3-js"
import { describe, expect, test } from "vitest"

import type { RangeDatabase } from "#httpvfs/database"
import { searchPOICategory } from "#httpvfs/poi"
import { registerOpenDatabases, stubRangeDatabase, trackDatabase } from "#test/range-database-stub"

registerOpenDatabases()

const CENTER = { lat: 39.7817, lon: -89.6501 }
const ORIGIN = latLngToCell(CENTER.lat, CENTER.lon, 9) as H3Cell

/**
 * A cell exactly `ring` steps from the origin.
 */
function cellAtRing(ring: number): H3Cell {
	const inner = new Set(ring > 0 ? gridDisk(ORIGIN, ring - 1) : [])

	return gridDisk(ORIGIN, ring).find((cell) => !inner.has(cell)) as H3Cell
}

interface Fixture {
	database: RangeDatabase
	queries: string[]
}

function fixture(rows: Array<{ ring: number; category: number; rank: number; name: string | null }>): Fixture {
	const client = trackDatabase(DatabaseClient.temp<unknown>())

	client.exec(`
		CREATE TABLE poi_category_codes (id INTEGER PRIMARY KEY, category TEXT);
		INSERT INTO poi_category_codes VALUES (1, 'cafe'), (2, 'coffee_shop'), (3, 'bank');
		CREATE TABLE poi (
			h3_cell INTEGER, category_id INTEGER, neg_rank REAL, rowid_key INTEGER,
			name TEXT, latitude REAL, longitude REAL, confidence REAL, country TEXT,
			PRIMARY KEY (h3_cell, category_id, neg_rank, rowid_key)
		) WITHOUT ROWID;
	`)

	const insert = client.prepare("INSERT INTO poi VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")

	rows.forEach((row, index) => {
		const cell = cellAtRing(row.ring)
		const [lat, lon] = cellToLatLng(cell)

		insert.run(shortCellToInt(cell), row.category, row.rank, index, row.name, lat, lon, 0.9, "US")
	})

	const stub = stubRangeDatabase(client)
	const queries: string[] = []

	return {
		queries,
		database: {
			bytesRead: stub.bytesRead,
			query(sql, parameters) {
				if (sql.includes("FROM poi ")) {
					queries.push(sql)
				}

				return stub.query(sql, parameters)
			},
		},
	}
}

describe("searchPOICategory", () => {
	test("issues one query per ring and stops at the ring that fills the limit", async () => {
		const { database, queries } = fixture([
			{ ring: 0, category: 1, rank: -2, name: "Origin Cafe" },
			{ ring: 2, category: 1, rank: -1, name: "Ring Two Cafe" },
			{ ring: 4, category: 1, rank: -1, name: "Ring Four Cafe" },
		])

		const hits = await searchPOICategory(database, { categoryID: "cafe", center: CENTER, limit: 2 })

		expect(hits.map((hit) => hit.name)).toEqual(["Origin Cafe", "Ring Two Cafe"])
		expect(queries).toHaveLength(3)
		expect(hits[0]!.distanceM).toBeLessThan(hits[1]!.distanceM)
	})

	test("reads every ring up to maxRings when the limit is not reached", async () => {
		const { database, queries } = fixture([{ ring: 0, category: 1, rank: -1, name: "Origin Cafe" }])
		const hits = await searchPOICategory(database, { categoryID: "cafe", center: CENTER, maxRings: 4 })

		expect(hits).toHaveLength(1)
		expect(queries).toHaveLength(4)
	})

	test("keeps the top `limit` rows of each cell by rank", async () => {
		const { database } = fixture([
			{ ring: 0, category: 1, rank: -3, name: "First" },
			{ ring: 0, category: 1, rank: -2, name: "Second" },
			{ ring: 0, category: 1, rank: -1, name: "Third" },
		])

		const hits = await searchPOICategory(database, { categoryID: "cafe", center: CENTER, limit: 2, maxRings: 1 })

		expect(hits.map((hit) => hit.name).toSorted()).toEqual(["First", "Second"])
	})

	test("unions the leaf categories and skips unknown ones, other categories and nameless rows", async () => {
		const { database } = fixture([
			{ ring: 0, category: 1, rank: -1, name: "Cafe" },
			{ ring: 1, category: 2, rank: -1, name: "Coffee Shop" },
			{ ring: 1, category: 3, rank: -1, name: "Bank" },
			{ ring: 1, category: 1, rank: -2, name: null },
		])

		const hits = await searchPOICategory(database, {
			categoryID: "cafe",
			categoryIDs: ["cafe", "coffee_shop", "absent_leaf"],
			center: CENTER,
		})

		expect(hits.map((hit) => hit.name)).toEqual(["Cafe", "Coffee Shop"])
	})

	test("returns an empty list for a category the database does not carry", async () => {
		const { database, queries } = fixture([{ ring: 0, category: 1, rank: -1, name: "Cafe" }])

		expect(await searchPOICategory(database, { categoryID: "absent", center: CENTER })).toEqual([])
		expect(queries).toHaveLength(0)
	})
})
