import { stringifyJSON } from "@mailwoman/core/json"
import { StreetInterpolator } from "@mailwoman/resolver-wof-sqlite/interpolation"
import { type StreetSegmentDatabase, writeInterpCalibration } from "@mailwoman/resolver-wof-sqlite/street"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

interface SeedSegment {
	street_norm: string
	side: "L" | "R"
	from_hn: number
	to_hn: number
	parity: "odd" | "even" | "mixed"
	postcode: string | null
	geometry: [number, number][]
}

function seed(db: DatabaseClient<StreetSegmentDatabase>, segments: SeedSegment[]): void {
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
			stringifyJSON(s.geometry)
		)
	}
}

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

let db: DatabaseClient<StreetSegmentDatabase>
let interpolator: StreetInterpolator

beforeAll(() => {
	db = DatabaseClient.temp<StreetSegmentDatabase>()

	seed(db, [
		MAIN_EVEN,
		MAIN_ODD,

		{
			...MAIN_EVEN,
			postcode: "05602",
			geometry: [
				[1, 1],
				[1.001, 1],
			],
		},

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
	interpolator[Symbol.dispose]()
	db.destroy()
})

describe("StreetInterpolator", () => {
	it("interpolates linearly along the segment, parity-matched to the even side", () => {
		const hit = interpolator.find({ street: "Main St", number: "150", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.interpolated).toBe(true)
		expect(hit!.parityMatched).toBe(true)

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
		const hit = interpolator.find({ street: "River Rd", number: "450", postcode: "05601" })
		expect(hit!.lon).toBeCloseTo(0.0005, 9)
		expect(hit!.lat).toBeCloseTo(1, 9)

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

describe("StreetInterpolator — artifact-carried radius calibration", () => {
	it("reads the extract's baked multiplier at open time", async () => {
		await using kdb = DatabaseClient.temp<StreetSegmentDatabase>()
		seed(kdb, [MAIN_EVEN])

		await writeInterpCalibration(kdb, { radius_multiplier: 1.7, method: "split-conformal:2026-06-14", region: "TX" })
		const calibrated = new StreetInterpolator({ database: kdb })

		expect(calibrated.radiusCalibration).toBe(1.7)

		const hit = calibrated.find({ street: "Main St", number: "150", postcode: "05601" })
		expect(hit).not.toBeNull()
		expect(hit!.uncertaintyM).toBeGreaterThan(40)
		expect(hit!.uncertaintyM).toBeLessThan(70)
		calibrated[Symbol.dispose]()
	})

	it("reports undefined for a extract predating the metadata table", () => {
		expect(interpolator.radiusCalibration).toBeUndefined()
	})

	it("reports undefined for an empty or invalid calibration table", () => {
		using emptyDB = DatabaseClient.temp<StreetSegmentDatabase>()
		seed(emptyDB, [MAIN_EVEN])

		emptyDB.exec(
			"CREATE TABLE interp_calibration (radius_multiplier REAL NOT NULL, method TEXT NOT NULL, region TEXT NOT NULL)"
		)

		const emptyCalib = new StreetInterpolator({ database: emptyDB })
		expect(emptyCalib.radiusCalibration).toBeUndefined()
		emptyCalib[Symbol.dispose]()
	})
})

describe("StreetInterpolator — parity-first ambiguity, near tie-break, key variants", () => {
	it("answers without a postcode when PARITY selects a single ZIP (the boundary-road class)", () => {
		const hit = interpolator.find({ street: "Main St", number: "151" })

		expect(hit).not.toBeNull()
		expect(hit!.lat).toBeCloseTo(0, 9)
		expect(hit!.parityMatched).toBe(true)
	})

	it("still abstains without a postcode when the PARITY pool itself spans ZIPs", () => {
		expect(interpolator.find({ street: "Main St", number: "150" })).toBeNull()
	})

	describe("near tie-break geometry", () => {
		let nearDB: DatabaseClient<StreetSegmentDatabase>
		let nearInterp: StreetInterpolator

		beforeAll(() => {
			nearDB = DatabaseClient.temp<StreetSegmentDatabase>()

			seed(nearDB, [
				{
					street_norm: "elm street",
					side: "R",
					from_hn: 2,
					to_hn: 98,
					parity: "even",
					postcode: "11111",
					geometry: [
						[0, 0],
						[0.001, 0],
					],
				},
				{
					street_norm: "elm street",
					side: "R",
					from_hn: 2,
					to_hn: 98,
					parity: "even",
					postcode: "22222",
					geometry: [
						[0, 0.18],
						[0.001, 0.18],
					],
				},

				{
					street_norm: "st pauls place",
					side: "R",
					from_hn: 2,
					to_hn: 16,
					parity: "even",
					postcode: "33333",
					geometry: [
						[0, 0],
						[0.001, 0],
					],
				},
				{
					street_norm: "saint pauls place",
					side: "R",
					from_hn: 2,
					to_hn: 48,
					parity: "even",
					postcode: "44444",
					geometry: [
						[0, 0.3],
						[0.001, 0.3],
					],
				},
				{
					street_norm: "saint pauls place",
					side: "R",
					from_hn: 2,
					to_hn: 30,
					parity: "even",
					postcode: "55555",
					geometry: [
						[0, 0.6],
						[0.001, 0.6],
					],
				},
			])

			nearInterp = new StreetInterpolator({ database: nearDB })
		})

		afterAll(() => {
			nearInterp[Symbol.dispose]()
			nearDB.destroy()
		})

		it("breaks a multi-ZIP tie by dominant proximity to `near`", () => {
			const hit = nearInterp.find({ street: "Elm St", number: "50", near: { lat: 0.01, lon: 0 } })

			expect(hit).not.toBeNull()
			expect(hit!.lat).toBeCloseTo(0, 9)
		})

		it("abstains when `near` sits between the groups (no dominance)", () => {
			expect(nearInterp.find({ street: "Elm St", number: "50", near: { lat: 0.09, lon: 0 } })).toBeNull()
		})

		it("abstains when `near` is out of range of every group", () => {
			expect(nearInterp.find({ street: "Elm St", number: "50", near: { lat: 5, lon: 5 } })).toBeNull()
		})

		it("abstains on the multi-ZIP tie when no `near` was supplied at all", () => {
			expect(nearInterp.find({ street: "Elm St", number: "50" })).toBeNull()
		})

		it("advances the key-variant ladder past a wrong-register variant that covers but cannot answer", () => {
			const hit = nearInterp.find({ street: "Saint Pauls PL St", number: "10", near: { lat: 0.01, lon: 0 } })

			expect(hit).not.toBeNull()
			expect(hit!.lat).toBeCloseTo(0, 9)
		})

		it("reaches the register-split key under an explicit postcode too", () => {
			const hit = nearInterp.find({ street: "Saint Pauls Pl", number: "10", postcode: "33333" })

			expect(hit).not.toBeNull()
			expect(hit!.lat).toBeCloseTo(0, 9)
		})
	})
})
