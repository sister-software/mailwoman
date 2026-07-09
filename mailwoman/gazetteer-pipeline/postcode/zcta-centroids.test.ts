/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ZCTA + GeoNames centroid fills (#525) — contract tests for three fills:
 *
 *   - ZCTA: placeholder with ZCTA → filled; real coord → untouched; no-ZCTA → placeholder.
 *   - GeoNames: placeholder covered by GeoNames (but not ZCTA) → filled; real coord → untouched;
 *       no-GeoNames → placeholder; no-overwrite: ZCTA-already-filled row stays ZCTA, not geonames.
 */

import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import {
	fillGeonamesPlaceholders,
	fillPlaceholderCentroids,
	GEONAMES_US_SOURCE,
	parseGeonamesCentroids,
	parseZCTACentroids,
	ZCTA_SOURCE,
} from "./zcta-centroids.ts"

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

// GeoNames fixture (no header; country(0), postcode(1), place(2), ...adm..., lat(9), lon(10), acc(11)).
// 21638 appears here but not in the ZCTA file — covers the PO-box/unique ZIP residual case.
// 90210 appears here too, to verify no-overwrite after ZCTA fill.
// Two rows for 21638 with different place names → averaged centroid.
const GEONAMES_FIXTURE = [
	"US\t21638\tGrasonville\tMaryland\tMD\tQueen Anne's\t\t\t\t38.9573\t-76.1966\t1",
	"US\t21638\tChester\tMaryland\tMD\tQueen Anne's\t\t\t\t38.9713\t-76.0636\t1",
	"US\t90210\tBeverly Hills\tCalifornia\tCA\tLos Angeles\t\t\t\t34.0736\t-118.4004\t1",
	// Degenerate rows the parser must skip.
	"US\t\tBad Row\t\t\t\t\t\t\t34.0\t-118.0\t1", // empty postcode
	"US\t99901\tKetchikan\tAlaska\tAK\t\t\t\t\t0\t0\t1", // zero coords
	"DE\t10115\tBerlin\t\t\t\t\t\t\t52.5200\t13.4050\t1", // non-US → included in map, no US spr match
].join("\n")

function seedDB(): DatabaseSync {
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
	insert.run(1, "90210", "postalcode", "US", 0, 0) // placeholder, ZCTA exists → filled by ZCTA
	insert.run(2, "10001", "postalcode", "US", 40.750634, -73.997177) // real WOF coord → untouched
	insert.run(3, "21638", "postalcode", "US", 0, 0) // placeholder, no ZCTA but GeoNames → filled by GeoNames
	insert.run(4, "00601", "postalcode", "DE", 0, 0)

	// non-US → out of scope, stays
	return db
}

describe("parseZCTACentroids", () => {
	it("parses centroids, skipping header and degenerate rows", () => {
		const zcta = parseZCTACentroids(GAZETTEER_FIXTURE)
		expect(zcta.size).toBe(2)
		expect(zcta.get("90210")).toEqual({ lat: 34.100517, lon: -118.41463 })
		expect(zcta.get("00601")).toEqual({ lat: 18.180555, lon: -66.749961 })
		expect(zcta.has("99999")).toBe(false)
	})
})

describe("fillPlaceholderCentroids", () => {
	it("fills placeholders, preserves real coords, leaves ZCTA-less rows placeholder", () => {
		const db = seedDB()
		const filled = fillPlaceholderCentroids(db, parseZCTACentroids(GAZETTEER_FIXTURE))
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
		const db = seedDB()
		const zcta = parseZCTACentroids(GAZETTEER_FIXTURE)
		expect(fillPlaceholderCentroids(db, zcta)).toBe(1)
		expect(fillPlaceholderCentroids(db, zcta)).toBe(0)
	})
})

describe("parseGeonamesCentroids", () => {
	it("averages multiple rows for the same postcode, skips degenerate rows", () => {
		const geo = parseGeonamesCentroids(GEONAMES_FIXTURE)
		// 21638 has two rows: average of (38.9573, -76.1966) and (38.9713, -76.0636).
		const avg21638 = geo.get("21638")!
		expect(avg21638.lat).toBeCloseTo((38.9573 + 38.9713) / 2, 4)
		expect(avg21638.lon).toBeCloseTo((-76.1966 + -76.0636) / 2, 4)
		// 90210 is present (single row).
		expect(geo.get("90210")).toEqual({ lat: 34.0736, lon: -118.4004 })
		// DE postcode included in map but irrelevant for US fill (key="10115").
		expect(geo.has("10115")).toBe(true)
		// Empty postcode and zero-coord rows skipped.
		expect(geo.has("")).toBe(false)
		expect(geo.has("99901")).toBe(false)
	})
})

describe("fillGeonamesPlaceholders", () => {
	it("fills ZCTA-residual placeholders, does not overwrite ZCTA-filled or real coords", () => {
		const db = seedDB()

		// Run ZCTA fill first (fills 90210 with census coords).
		const zcta = parseZCTACentroids(GAZETTEER_FIXTURE)
		expect(fillPlaceholderCentroids(db, zcta)).toBe(1)

		// Now run GeoNames fill on the residual (21638 is still placeholder; 90210 is already filled).
		const geo = parseGeonamesCentroids(GEONAMES_FIXTURE)
		const filled = fillGeonamesPlaceholders(db, geo)
		expect(filled).toBe(1)

		const byName = (name: string) =>
			db.prepare(`SELECT latitude, longitude FROM spr WHERE name=?`).get(name) as {
				latitude: number
				longitude: number
			}

		// 21638 was filled by GeoNames (averaged centroid).
		const r21638 = byName("21638")
		expect(r21638.latitude).toBeCloseTo((38.9573 + 38.9713) / 2, 4)
		expect(r21638.longitude).toBeCloseTo((-76.1966 + -76.0636) / 2, 4)

		// 90210 keeps the ZCTA coord — NOT overwritten by GeoNames.
		expect(byName("90210")).toEqual({ latitude: 34.100517, longitude: -118.41463 })

		// Real WOF coord (10001) untouched.
		expect(byName("10001")).toEqual({ latitude: 40.750634, longitude: -73.997177 })

		// Non-US row stays placeholder.
		expect(byName("00601")).toEqual({ latitude: 0, longitude: 0 })

		// Provenance: ZCTA source for 90210 (id=1), GeoNames for 21638 (id=3).
		const sources = db.prepare(`SELECT id, source FROM centroid_source ORDER BY id`).all()
		expect(sources).toEqual([
			{ id: 1, source: ZCTA_SOURCE },
			{ id: 3, source: GEONAMES_US_SOURCE },
		])
	})

	it("is idempotent", () => {
		const db = seedDB()
		const geo = parseGeonamesCentroids(GEONAMES_FIXTURE)
		// seedDB has two US placeholders GeoNames can fill: 90210 and 21638.
		const firstRun = fillGeonamesPlaceholders(db, geo)
		expect(firstRun).toBeGreaterThan(0)
		// Second run must fill zero rows (idempotent — UPDATE re-checks latitude=0).
		expect(fillGeonamesPlaceholders(db, geo)).toBe(0)
	})

	it("does not overwrite a row already filled by ZCTA even if GeoNames has a different coord", () => {
		const db = seedDB()

		// Fill 90210 via ZCTA (lat=34.100517).
		fillPlaceholderCentroids(db, parseZCTACentroids(GAZETTEER_FIXTURE))

		// GeoNames has a different coord for 90210 (lat=34.0736). Must NOT overwrite.
		fillGeonamesPlaceholders(db, parseGeonamesCentroids(GEONAMES_FIXTURE))

		const r = db
			.prepare(`SELECT latitude, source FROM spr JOIN centroid_source USING(id) WHERE name='90210'`)
			.get() as {
			latitude: number
			source: string
		}
		expect(r.latitude).toBeCloseTo(34.100517, 4)
		expect(r.source).toBe(ZCTA_SOURCE)
	})
})
