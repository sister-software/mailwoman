/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the house-number interpolation tier (#483). Seeds an in-memory `street_segment` fixture
 *   (the schema `scripts/build-interpolation-shard.ts` builds), then asserts parity-aware matching,
 *   boundary/descending-range interpolation, postcode scoping + the no-scope abstention, and the
 *   no-match fall-through.
 */

import { DatabaseSync } from "node:sqlite"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { StreetInterpolator } from "./interpolation.js"

interface SeedSegment {
	street_norm: string
	side: "L" | "R"
	from_hn: number
	to_hn: number
	parity: "odd" | "even" | "mixed"
	postcode: string | null
	geometry: [number, number][]
}

function seed(db: DatabaseSync, segments: SeedSegment[]): void {
	db.exec(`
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
	const ins = db.prepare(
		`INSERT INTO street_segment
		 (street_norm, side, from_hn, to_hn, min_hn, max_hn, parity, postcode, county_fips, street_raw, geometry, source, release)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, '50023', ?, ?, 'tiger:edges', 'TIGER2023')`
	)

	for (const s of segments) {
		ins.run(
			s.street_norm,
			s.side,
			s.from_hn,
			s.to_hn,
			Math.min(s.from_hn, s.to_hn),
			Math.max(s.from_hn, s.to_hn),
			s.parity,
			s.postcode,
			s.street_norm,
			JSON.stringify(s.geometry)
		)
	}
}

// A straight 0.001-degree east-west street on the equator (~111 m): even 100–198 on the
// right, odd 101–199 on the left, both in ZIP 05601.
const MAIN_EVEN: SeedSegment = {
	street_norm: "main street",
	side: "R",
	from_hn: 100,
	to_hn: 198,
	parity: "even",
	postcode: "05601",
	geometry: [
		[0, 0],
		[0.001, 0],
	],
}
const MAIN_ODD: SeedSegment = { ...MAIN_EVEN, side: "L", from_hn: 101, to_hn: 199, parity: "odd" }

let db: DatabaseSync
let interpolator: StreetInterpolator

beforeAll(() => {
	db = new DatabaseSync(":memory:")
	seed(db, [
		MAIN_EVEN,
		MAIN_ODD,
		// Same street name, different town/ZIP — the postcode-scoping + abstention fixture.
		{
			...MAIN_EVEN,
			postcode: "05602",
			geometry: [
				[1, 1],
				[1.001, 1],
			],
		},
		// Descending range: numbers DECREASE walking from-node → to-node.
		{
			street_norm: "river road",
			side: "R",
			from_hn: 500,
			to_hn: 400,
			parity: "even",
			postcode: "05601",
			geometry: [
				[0, 1],
				[0.001, 1],
			],
		},
		// Single-number "range" — answer is the segment midpoint.
		{
			street_norm: "depot square",
			side: "L",
			from_hn: 7,
			to_hn: 7,
			parity: "odd",
			postcode: "05601",
			geometry: [
				[0, 2],
				[0.001, 2],
			],
		},
		// Odd number on a street with ONLY an even side on record — the parity fallback.
		{
			street_norm: "mill street",
			side: "R",
			from_hn: 2,
			to_hn: 98,
			parity: "even",
			postcode: "05601",
			geometry: [
				[0, 3],
				[0.001, 3],
			],
		},
		// Mixed-parity side matches either parity without the fallback flag.
		{
			street_norm: "bridge street",
			side: "L",
			from_hn: 1,
			to_hn: 50,
			parity: "mixed",
			postcode: "05601",
			geometry: [
				[0, 4],
				[0.001, 4],
			],
		},
		// Stored under the CANONICAL route key (as the builder writes it from TIGER's
		// "State Rte 100") — the query side must fold "VT ROUTE 100" to the same key.
		{
			street_norm: "state route 100",
			side: "L",
			from_hn: 1001,
			to_hn: 1099,
			parity: "odd",
			postcode: "05601",
			geometry: [
				[0, 5],
				[0.001, 5],
			],
		},
	])
	interpolator = new StreetInterpolator({ database: db })
})

afterAll(() => {
	interpolator.close()
	db.close()
})

describe("StreetInterpolator", () => {
	it("interpolates linearly along the segment, parity-matched to the even side", () => {
		const hit = interpolator.find({ street: "Main St", number: "150", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.interpolated).toBe(true)
		expect(hit!.parityMatched).toBe(true)
		// t = (150 − 100) / 98 along a straight segment → lon = 0.001 × t.
		expect(hit!.lon).toBeCloseTo(0.001 * (50 / 98), 9)
		expect(hit!.lat).toBeCloseTo(0, 9)
		expect(hit!.source).toBe("tiger:edges")
		expect(hit!.release).toBe("TIGER2023")
	})

	it("routes an odd number to the odd side of the same street", () => {
		const hit = interpolator.find({ street: "Main Street", number: "151", postcode: "05601" })
		expect(hit!.parityMatched).toBe(true)
		expect(hit!.lon).toBeCloseTo(0.001 * (50 / 98), 9)
	})

	it("answers the exact from/to boundaries with the segment endpoints", () => {
		const atFrom = interpolator.find({ street: "Main St", number: "100", postcode: "05601" })
		expect(atFrom!.lon).toBeCloseTo(0, 9)
		const atTo = interpolator.find({ street: "Main St", number: "198", postcode: "05601" })
		expect(atTo!.lon).toBeCloseTo(0.001, 9)
	})

	it("handles a descending range (from > to) by walking the geometry in range direction", () => {
		// 450 is 50% of the way from 500 → 400, so 50% along the polyline from the from-node.
		const hit = interpolator.find({ street: "River Rd", number: "450", postcode: "05601" })
		expect(hit!.lon).toBeCloseTo(0.0005, 9)
		expect(hit!.lat).toBeCloseTo(1, 9)
		// And the from-boundary sits at the polyline START even though it's the range MAX.
		const atFrom = interpolator.find({ street: "River Rd", number: "500", postcode: "05601" })
		expect(atFrom!.lon).toBeCloseTo(0, 9)
	})

	it("answers a single-number range with the segment midpoint", () => {
		const hit = interpolator.find({ street: "Depot Sq", number: "7", postcode: "05601" })
		expect(hit!.lon).toBeCloseTo(0.0005, 9)
		expect(hit!.lat).toBeCloseTo(2, 9)
	})

	it("falls back to the opposite-parity side, flagged parityMatched: false", () => {
		const hit = interpolator.find({ street: "Mill St", number: "51", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.parityMatched).toBe(false)
		expect(hit!.lat).toBeCloseTo(3, 9)
	})

	it("treats a mixed-parity side as parity-matched for either parity", () => {
		const odd = interpolator.find({ street: "Bridge St", number: "25", postcode: "05601" })
		const even = interpolator.find({ street: "Bridge St", number: "26", postcode: "05601" })
		expect(odd!.parityMatched).toBe(true)
		expect(even!.parityMatched).toBe(true)
	})

	it("reports half the segment length as the uncertainty radius", () => {
		const hit = interpolator.find({ street: "Main St", number: "150", postcode: "05601" })
		// 0.001 degrees of equatorial longitude ≈ 111.2 m → half ≈ 56 m.
		expect(hit!.uncertaintyM).toBeGreaterThan(40)
		expect(hit!.uncertaintyM).toBeLessThan(70)
	})

	it("scopes by postcode — the same street name in another ZIP answers from ITS segment", () => {
		const hit = interpolator.find({ street: "Main St", number: "150", postcode: "05602" })
		expect(hit!.lat).toBeCloseTo(1, 9)
	})

	it("abstains without a postcode when the name spans multiple ZIPs", () => {
		expect(interpolator.find({ street: "Main St", number: "150" })).toBeNull()
	})

	it("answers without a postcode when the statewide match is unambiguous", () => {
		const hit = interpolator.find({ street: "River Rd", number: "450" })
		expect(hit).not.toBeNull()
		expect(hit!.lat).toBeCloseTo(1, 9)
	})

	it("matches a TIGER-spelled route key from the E911/Overture route spelling", () => {
		// TIGER says "State Rte 100"; E911/Overture say "VT ROUTE 100" — both fold to the same
		// canonical key (build side stores it folded, query side folds before matching).
		const hit = interpolator.find({ street: "VT ROUTE 100", number: "1043", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.lat).toBeCloseTo(5, 9)
	})

	it("falls through on no matching street, out-of-range number, wrong ZIP, or non-numeric input", () => {
		expect(interpolator.find({ street: "Nowhere Ln", number: "5", postcode: "05601" })).toBeNull()
		expect(interpolator.find({ street: "Main St", number: "999", postcode: "05601" })).toBeNull()
		expect(interpolator.find({ street: "Main St", number: "150", postcode: "99999" })).toBeNull()
		expect(interpolator.find({ street: "Main St", number: "12-34", postcode: "05601" })).toBeNull()
		expect(interpolator.find({ street: "Main St", number: "", postcode: "05601" })).toBeNull()
	})
})
