/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseSync } from "node:sqlite"

import { expect, test } from "vitest"

import { foldName, makeUnLocodeAnnotator, parseUnLocodeCoords, UnLocodeLookup } from "./index.js"

test("foldName: strips diacritics, lowercases, collapses whitespace", () => {
	expect(foldName("Nagykovácsi")).toBe("nagykovacsi")
	expect(foldName("  New   York ")).toBe("new york")
	expect(foldName("Rotterdam")).toBe("rotterdam")
})

test("parseUnLocodeCoords: DDMM hemisphere → decimal degrees", () => {
	expect(parseUnLocodeCoords("4923N 01522E")).toEqual({ lat: 49 + 23 / 60, lon: 15 + 22 / 60 })
	const sw = parseUnLocodeCoords("3352S 15113W")
	expect(sw!.lat).toBeLessThan(0)
	expect(sw!.lon).toBeLessThan(0)
	expect(parseUnLocodeCoords("")).toBeNull()
	expect(parseUnLocodeCoords("nonsense")).toBeNull()
})

function fixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec("CREATE TABLE un_locode (country TEXT, location TEXT, name TEXT, nameNorm TEXT, lat REAL, lon REAL)")
	const ins = db.prepare("INSERT INTO un_locode VALUES (?,?,?,?,?,?)")
	ins.run("NL", "RTM", "Rotterdam", "rotterdam", 51.92, 4.48)
	ins.run("US", "NYC", "New York", "new york", 40.7, -74.0)

	return db
}

test("UnLocodeLookup.byName: country + folded name → code", () => {
	const lookup = new UnLocodeLookup({ database: fixtureDb() })
	expect(lookup.byName("NL", "Rotterdam")).toBe("NL RTM")
	expect(lookup.byName("us", "new york")).toBe("US NYC")
	expect(lookup.byName("NL", "Nowhere")).toBeNull()
})

test("UnLocodeLookup.nearest: closest coordinate within range", () => {
	const lookup = new UnLocodeLookup({ database: fixtureDb() })
	expect(lookup.nearest(40.71, -74.01)).toBe("US NYC")
	expect(lookup.nearest(0, 0, 25)).toBeNull()
})

test("makeUnLocodeAnnotator: byName when available, else nearest", () => {
	const annotate = makeUnLocodeAnnotator(new UnLocodeLookup({ database: fixtureDb() }))
	expect(annotate({ lat: 40.71, lon: -74.01, countryCode: "US", placeName: "New York" })).toEqual({
		unLocode: "US NYC",
	})
	expect(annotate({ lat: 51.92, lon: 4.48 })).toEqual({ unLocode: "NL RTM" })
})
