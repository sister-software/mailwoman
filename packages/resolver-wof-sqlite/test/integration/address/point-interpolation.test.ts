/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Tests for address-point interpolation, Method 2 of the resolution ladder.
 */

import {
	AddressPointInterpolator,
	type AddressPointDatabase,
	createAddressPointTable,
} from "@mailwoman/resolver-wof-sqlite/address"
import { StreetInterpolator } from "@mailwoman/resolver-wof-sqlite/interpolation"
import type { StreetSegmentDatabase } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

interface SeedPoint {
	street_key: string
	number: string
	postcode: string
	lat: number
	lon: number
}

async function seedPoints(db: DatabaseClient<AddressPointDatabase>, points: SeedPoint[]): Promise<void> {
	// The shared table builder is the one `mailwoman situs address-points` uses,
	// so this fixture cannot drift from the production shape.
	// The test owns `db`'s lifecycle and does not destroy `kdb` here.
	const kdb = db
	await createAddressPointTable(kdb)

	const ins = db.prepare(
		`INSERT INTO address_point (street_norm, street_key, number, unit, postcode, locality_norm, street_raw, lat, lon, source, release)
		 VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, 'overture:test', '2026-05-20.0')`
	)

	for (const p of points) {
		ins.run(p.street_key, p.street_key, p.number, p.postcode, p.street_key, p.lat, p.lon)
	}
}

// All fixtures live on straight east-west streets near the equator so longitude
// is a direct proxy for position (0.001 deg ≈ 111 m).
let db: DatabaseClient<AddressPointDatabase>
let interpolator: AddressPointInterpolator

beforeAll(async () => {
	db = DatabaseClient.temp<AddressPointDatabase>()

	await seedPoints(db, [
		{ street_key: "main street", number: "100", postcode: "05601", lat: 0, lon: 0 },
		{ street_key: "main street", number: "200", postcode: "05601", lat: 0, lon: 0.001 },
		// Self-exclusion fixture on its own street.
		// A point sits at the queryable number 150, deliberately far off the street line,
		// so querying 150 must interpolate the 100/200 bracket and never answer from this row.
		{ street_key: "elm street", number: "100", postcode: "05601", lat: 0, lon: 0 },
		{ street_key: "elm street", number: "150", postcode: "05601", lat: 0.5, lon: 0.5 },
		{ street_key: "elm street", number: "200", postcode: "05601", lat: 0, lon: 0.001 },
		{ street_key: "main street", number: "300", postcode: "05601", lat: 0, lon: 0.0029 },
		{ street_key: "main street", number: "300", postcode: "05601", lat: 0, lon: 0.0031 },
		// Single-sided fixture, so queries above 20 extrapolate east.
		{ street_key: "hill road", number: "10", postcode: "05601", lat: 1, lon: 0 },
		{ street_key: "hill road", number: "20", postcode: "05601", lat: 1, lon: 0.001 },
		// One lone point, never enough to bracket or extrapolate.
		{ street_key: "lone lane", number: "7", postcode: "05601", lat: 2, lon: 0 },
		// Route-fold fixture, stored under the canonical key.
		{ street_key: "state route 100", number: "1000", postcode: "05601", lat: 3, lon: 0 },
		{ street_key: "state route 100", number: "1100", postcode: "05601", lat: 3, lon: 0.001 },
	])

	interpolator = new AddressPointInterpolator({ database: db })
})

afterAll(() => {
	interpolator[Symbol.dispose]()
	db.destroy()
})

describe("AddressPointInterpolator", () => {
	it("interpolates a both-sided bracket linearly in house-number space", () => {
		const hit = interpolator.find({ street: "Main St", number: "125", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.interpolated).toBe(true)
		expect(hit!.method).toBe("address_point")
		expect(hit!.bracket).toBe("both")
		expect(hit!.lat).toBeCloseTo(0, 9)
		expect(hit!.lon).toBeCloseTo(0.00025, 9)
		expect(hit!.uncertaintyM).toBeGreaterThan(40)
		expect(hit!.uncertaintyM).toBeLessThan(70)
		expect(hit!.source).toBe("overture:test")
		expect(hit!.release).toBe("2026-05-20.0")
	})

	it("never answers from a point at the queried number itself (non-circular by construction)", () => {
		// A row for 150 exists off the street line at lat 0.5, so the answer must come from the 100/200 bracket.
		// In production the exact tier owns on-file numbers.
		const hit = interpolator.find({ street: "Elm St", number: "150", postcode: "05601" })
		expect(hit!.bracket).toBe("both")
		expect(hit!.lat).toBeCloseTo(0, 9)
		expect(hit!.lon).toBeCloseTo(0.0005, 9)
	})

	it("collapses unit siblings to the number's centroid before bracketing", () => {
		const hit = interpolator.find({ street: "Main St", number: "250", postcode: "05601" })
		expect(hit!.bracket).toBe("both")
		expect(hit!.lon).toBeCloseTo(0.002, 9)
	})

	it("extrapolates a single-sided bracket with an explicitly larger uncertainty", () => {
		const hit = interpolator.find({ street: "Hill Rd", number: "25", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.method).toBe("address_point")
		expect(hit!.bracket).toBe("single")
		expect(hit!.lat).toBeCloseTo(1, 9)
		expect(hit!.lon).toBeCloseTo(0.0015, 9)
		expect(hit!.uncertaintyM).toBeGreaterThan(140)
	})

	it("caps extrapolation at one pair-span beyond the nearest point", () => {
		const atCap = interpolator.find({ street: "Hill Rd", number: "30", postcode: "05601" })
		expect(atCap!.bracket).toBe("single")
		expect(atCap!.lon).toBeCloseTo(0.002, 9)
		expect(interpolator.find({ street: "Hill Rd", number: "31", postcode: "05601" })).toBeNull()
	})

	it("matches the route-folded street key from either route spelling", () => {
		const hit = interpolator.find({ street: "VT ROUTE 100", number: "1050", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.lat).toBeCloseTo(3, 9)
		expect(hit!.lon).toBeCloseTo(0.0005, 9)
	})

	it("returns null with no bracket and no fallback (lone point, unknown street, wrong ZIP, non-numeric)", () => {
		expect(interpolator.find({ street: "Lone Ln", number: "9", postcode: "05601" })).toBeNull()
		expect(interpolator.find({ street: "Nowhere St", number: "5", postcode: "05601" })).toBeNull()
		expect(interpolator.find({ street: "Main St", number: "125", postcode: "99999" })).toBeNull()
		expect(interpolator.find({ street: "Main St", number: "12-34", postcode: "05601" })).toBeNull()
	})

	it("falls through to the TIGER segment fallback when bracketing cannot answer", () => {
		using segDB = DatabaseClient.temp<StreetSegmentDatabase>()

		segDB.exec(`
			CREATE TABLE street_segment (
				street_norm  TEXT NOT NULL,
				side         TEXT NOT NULL,
				from_hn      INTEGER NOT NULL,
				to_hn        INTEGER NOT NULL,
				min_hn       INTEGER NOT NULL,
				max_hn       INTEGER NOT NULL,
				parity       TEXT NOT NULL,
				postcode     TEXT,
				county_fips  TEXT NOT NULL,
				street_raw   TEXT NOT NULL,
				geometry     TEXT NOT NULL,
				source       TEXT NOT NULL,
				release      TEXT NOT NULL
			)
		`)

		segDB
			.prepare(
				`INSERT INTO street_segment VALUES
				 ('lone lane', 'L', 1, 99, 1, 99, 'odd', '05601', '50023', 'Lone Ln', '[[0,2],[0.001,2]]', 'tiger:edges', 'TIGER2023')`
			)
			.run()

		const tiger = new StreetInterpolator({ database: segDB })
		const ladder = new AddressPointInterpolator({ database: db, fallback: tiger })

		const hit = ladder.find({ street: "Lone Ln", number: "51", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.method).toBe("tiger_range")
		expect(hit!.parityMatched).toBe(true)
		expect(hit!.lat).toBeCloseTo(2, 9)

		const bracketed = ladder.find({ street: "Main St", number: "125", postcode: "05601" })
		expect(bracketed!.method).toBe("address_point")

		const noScope = ladder.find({ street: "Lone Ln", number: "51" })
		expect(noScope!.method).toBe("tiger_range")

		ladder[Symbol.dispose]()
		tiger[Symbol.dispose]()
	})
})
