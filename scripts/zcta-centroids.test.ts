/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ZCTA centroid fill (#525) — the three contract cases: a placeholder with a ZCTA is filled and
 *   provenance-stamped; a real WOF coordinate is never overwritten; a placeholder without a ZCTA
 *   stays placeholder with no provenance row.
 */

import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { fillPlaceholderCentroids, parseZctaCentroids, ZCTA_SOURCE } from "./zcta-centroids.ts"

const GAZETTEER_FIXTURE = [
	"GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG",
	// Trailing whitespace mimics the real file's right-padded last column.
	"90210\t26822185\t82087\t10.356\t0.032\t34.100517\t-118.41463   ",
	"00601\t166836392\t798613\t64.416\t0.308\t18.180555\t-66.749961",
	// Degenerate rows the parser must skip: placeholder coords, non-numeric, short code.
	"99999\t0\t0\t0\t0\t0\t0",
	"88888\t0\t0\t0\t0\tnope\t-118.4",
	"123\t0\t0\t0\t0\t34.1\t-118.4",
].join("\n")

function seedDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`CREATE TABLE spr (
		id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL DEFAULT -1, name TEXT NOT NULL DEFAULT '',
		placetype TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
		latitude REAL NOT NULL DEFAULT 0, longitude REAL NOT NULL DEFAULT 0,
		min_latitude REAL NOT NULL DEFAULT 0, min_longitude REAL NOT NULL DEFAULT 0,
		max_latitude REAL NOT NULL DEFAULT 0, max_longitude REAL NOT NULL DEFAULT 0,
		is_current INTEGER NOT NULL DEFAULT 1
	)`)
	const insert = db.prepare(
		`INSERT INTO spr (id, name, placetype, country, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)`
	)
	insert.run(1, "90210", "postalcode", "US", 0, 0) // placeholder, ZCTA exists → filled
	insert.run(2, "10001", "postalcode", "US", 40.750634, -73.997177) // real WOF coord → untouched
	insert.run(3, "21638", "postalcode", "US", 0, 0) // placeholder, no ZCTA → stays
	insert.run(4, "00601", "postalcode", "DE", 0, 0) // non-US → out of scope, stays
	return db
}

describe("parseZctaCentroids", () => {
	it("parses centroids, skipping header and degenerate rows", () => {
		const zcta = parseZctaCentroids(GAZETTEER_FIXTURE)
		expect(zcta.size).toBe(2)
		expect(zcta.get("90210")).toEqual({ lat: 34.100517, lon: -118.41463 })
		expect(zcta.get("00601")).toEqual({ lat: 18.180555, lon: -66.749961 })
		expect(zcta.has("99999")).toBe(false)
	})
})

describe("fillPlaceholderCentroids", () => {
	it("fills placeholders, preserves real coords, leaves ZCTA-less rows placeholder", () => {
		const db = seedDb()
		const filled = fillPlaceholderCentroids(db, parseZctaCentroids(GAZETTEER_FIXTURE))
		expect(filled).toBe(1)

		const byName = (name: string) =>
			db.prepare(`SELECT latitude, longitude FROM spr WHERE name=?`).get(name) as {
				latitude: number
				longitude: number
			}

		// Placeholder + ZCTA → filled and stamped.
		expect(byName("90210")).toEqual({ latitude: 34.100517, longitude: -118.41463 })
		const sources = db.prepare(`SELECT id, source FROM centroid_source ORDER BY id`).all()
		expect(sources).toEqual([{ id: 1, source: ZCTA_SOURCE }])

		// Real WOF coordinate → byte-identical, no provenance row.
		expect(byName("10001")).toEqual({ latitude: 40.750634, longitude: -73.997177 })

		// Placeholder without a ZCTA, and the non-US row → untouched.
		expect(byName("21638")).toEqual({ latitude: 0, longitude: 0 })
		expect(byName("00601")).toEqual({ latitude: 0, longitude: 0 })
	})

	it("is idempotent", () => {
		const db = seedDb()
		const zcta = parseZctaCentroids(GAZETTEER_FIXTURE)
		expect(fillPlaceholderCentroids(db, zcta)).toBe(1)
		expect(fillPlaceholderCentroids(db, zcta)).toBe(0)
	})
})
