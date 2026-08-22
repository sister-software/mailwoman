/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The US arm's four rules, each on a fixture row that would otherwise ship a defect.
 *
 *   Every rule here was earned by a row in `postalcode-us.db`, not by anticipation: six place names sitting in a
 *   postcode table (one with a real New Mexico coordinate), 414 units on null island, 1,662 sharing a coordinate with a
 *   different sectional centre, and 25 prefixes spanning more than one state. The fixture is the smallest shard that
 *   reproduces all four.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { buildPostcodePrefixIndex } from "mailwoman/gazetteer-pipeline/postcode-prefix"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * WOF ids for the fixture. Arbitrary, but distinct and above 2^32 on one of them — a US region id in the real gazetteer
 * is 8 digits, while the NI synthetic postcode ids run to 9.8e12, and the format carries them all as `f64`.
 */
const US_COUNTRY_ID = 85_633_793
const ALPHA_ID = 85_688_001
const BETA_ID = 9_800_000_000_001

/**
 * Two unit squares, side by side. `alpha` spans lon [0,2), `beta` spans lon [2,4), both lat [0,2).
 */
const square = (minLon: number): string =>
	JSON.stringify({
		type: "Polygon",
		coordinates: [
			[
				[minLon, 0],
				[minLon + 2, 0],
				[minLon + 2, 2],
				[minLon, 2],
				[minLon, 0],
			],
		],
	})

let dir: string
let built: ReturnType<typeof buildPostcodePrefixIndex>

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pfx1-us-"))

	const sourcePath = join(dir, "postalcode.db")
	const adminPath = join(dir, "admin.db")
	const polygonPath = join(dir, "polygons.db")

	const source = new DatabaseSync(sourcePath)

	// Deliberately NO `meta` table — the real shard has none, and the coordinate-tier rule must not read a declaration
	// out of its absence.
	source.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, latitude REAL, longitude REAL
		);
		INSERT INTO spr (id, name, placetype, latitude, longitude) VALUES
			-- 100: two units inside alpha. Unanimous, so the prefix asserts the region.
			(1, '10001', 'postalcode', 1.0, 0.5),
			(2, '10002', 'postalcode', 1.0, 1.5),
			-- 200: one unit in each square. A straddle: the prefix asserts the country and nothing finer.
			(3, '20001', 'postalcode', 0.5, 0.5),
			(4, '20002', 'postalcode', 1.0, 2.5),
			-- 300: one real unit, one on null island. The node keeps a coordinate from what survives.
			(5, '30001', 'postalcode', 1.5, 1.0),
			(6, '30002', 'postalcode', 0, 0),
			-- 400 and 500 share a coordinate across DIFFERENT prefixes: a placeholder, so both are excluded.
			(7, '40001', 'postalcode', 1.9, 3.9),
			(8, '50001', 'postalcode', 1.9, 3.9),
			-- 600: wholly inside beta, whose id is past 2^32.
			(9, '60001', 'postalcode', 0.5, 3.0),
			(10, '60002', 'postalcode', 1.5, 3.5),
			-- A place name that reached a postcode table, carrying a real coordinate — and sharing it with a real unit, so
			-- a placeholder pass that voted on non-postcodes would wrongly exclude 10001 too.
			(11, 'Lea County-Zip Franklin Memorial Airport', 'postalcode', 1.0, 0.5);
	`)

	source.close()

	const admin = new DatabaseSync(adminPath)

	admin.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER
		);

		INSERT INTO spr (id, name, placetype, country, is_current) VALUES
			(${US_COUNTRY_ID}, 'United States', 'country', 'US', 1),
			(${ALPHA_ID}, 'Alpha', 'region', 'US', 1),
			(${BETA_ID}, 'Beta', 'region', 'US', 1);
	`)

	admin.close()

	const polygons = new DatabaseSync(polygonPath)

	polygons.exec(`CREATE TABLE polygons (id INTEGER PRIMARY KEY, geom TEXT)`)

	const insert = polygons.prepare(`INSERT INTO polygons (id, geom) VALUES (?, ?)`)

	insert.run(ALPHA_ID, square(0))
	insert.run(BETA_ID, square(2))
	polygons.close()

	built = buildPostcodePrefixIndex({ sourcePath, adminPath, polygonPath, country: "us", level: "3" })
})

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})

const nodeFor = (prefix: string) => built.nodes.find((n) => n.prefix === prefix)

describe("the US arm's exclusions", () => {
	it("refuses a row that is not a postcode, so no prefix is minted from a place name", () => {
		expect(nodeFor("LEA")).toBeUndefined()
		expect(built.excludedUnits["notAPostcode"]).toBe(1)
		// And the real unit it shares a coordinate with survives, because a non-postcode casts no placeholder vote.
		expect(nodeFor("100")?.lat).toBeDefined()
	})

	it("excludes a coordinate shared across DIFFERENT prefixes, and only across different ones", () => {
		expect(built.excludedUnits["placeholderCoordinate"]).toBe(2)
		expect(nodeFor("400")?.lat).toBeUndefined()
		expect(nodeFor("500")?.lat).toBeUndefined()
	})

	it("excludes null island without losing the unit from the count", () => {
		expect(built.excludedUnits["nullIsland"]).toBe(1)
		// The prefix still says the source enumerates two codes — `unitCount` is a claim about the postal system, not
		// about how many coordinates survived our hygiene.
		expect(nodeFor("300")?.unitCount).toBe(2)
		expect(nodeFor("300")?.lat).toBeCloseTo(1.5, 6)
	})

	it("keeps a fully-excluded prefix as a node with no coordinate rather than dropping it", () => {
		const node = nodeFor("400")

		expect(node).toBeDefined()
		expect(node?.unitCount).toBe(1)
		expect(node?.lat).toBeUndefined()
		expect(node?.lon).toBeUndefined()
		expect(node?.radiusP95Km).toBeUndefined()
	})
})

describe("the US arm's ancestry", () => {
	it("asserts the region when every clean unit lands in one", () => {
		expect(nodeFor("100")?.ancestors.map((a) => a.name)).toEqual(["United States", "Alpha"])
	})

	it("asserts the country alone when the prefix spans two regions", () => {
		expect(nodeFor("200")?.ancestors.map((a) => a.name)).toEqual(["United States"])
		expect(built.borderStraddlingPrefixes).toContain("200")
	})

	it("asserts the country alone when no unit lands in any region", () => {
		expect(nodeFor("400")?.ancestors.map((a) => a.name)).toEqual(["United States"])
		// Not a straddle — nothing was seen, which is a different claim from seeing two.
		expect(built.borderStraddlingPrefixes).not.toContain("400")
	})

	// `PostcodePrefixAncestor.wofID` is an `f64` because a WOF id exceeds 2^32 — the NI synthetic postcode ids start at
	// 9.8e12. A `u32` here would silently truncate rather than fail.
	it("carries a region id past 2^32 intact", () => {
		expect(BETA_ID).toBeGreaterThan(2 ** 32)
		expect(nodeFor("600")?.ancestors.map((a) => a.wofID)).toEqual([US_COUNTRY_ID, BETA_ID])
	})
})

describe("the US arm's coverage reporting", () => {
	it("never reads a coverage declaration out of a missing meta table", () => {
		expect(built.meta).toEqual({})
		expect(built.partialSource).toBe(false)
		expect(built.coordinateTier).toBe("centroid")
		expect(built.coordinateTierReason).toContain("carries no meta table")
	})

	it("counts indexed units rather than leaving the caller to re-derive them", () => {
		expect(built.indexedUnits).toBe(built.nodes.reduce((sum, n) => sum + n.unitCount, 0))
		expect(built.indexedUnits).toBe(built.unitRows - built.excludedUnits["notAPostcode"]!)
	})

	it("ships a radiusP95Km beside every coordinate it ships", () => {
		for (const node of built.nodes) {
			expect(node.lat === undefined).toBe(node.radiusP95Km === undefined)
		}
	})
})

describe("the level guard", () => {
	it("refuses a level the US arm does not index", () => {
		expect(() =>
			buildPostcodePrefixIndex({
				sourcePath: join(dir, "postalcode.db"),
				adminPath: join(dir, "admin.db"),
				polygonPath: join(dir, "polygons.db"),
				country: "us",
				level: "outward",
			})
		).toThrow(/sectional centre/)
	})

	it("refuses to substitute a gazetteer join for the polygons", () => {
		expect(() =>
			buildPostcodePrefixIndex({
				sourcePath: join(dir, "postalcode.db"),
				adminPath: join(dir, "admin.db"),
				country: "us",
				level: "3",
			})
		).toThrow(/polygonPath/)
	})
})
