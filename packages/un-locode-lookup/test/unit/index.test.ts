/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { foldName, makeUnLocodeAnnotator, parseUnLocodeCoords, UnLocodeLookup } from "@mailwoman/un-locode-lookup"
import type { UNLocodeDatabase } from "@mailwoman/un-locode-lookup/schema"
import { expect, test } from "vitest"

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

async function fixtureDB(): Promise<DatabaseClient<UNLocodeDatabase>> {
	const db = DatabaseClient.temp<UNLocodeDatabase>()
	db.exec("CREATE TABLE un_locode (country TEXT, location TEXT, name TEXT, nameNorm TEXT, lat REAL, lon REAL)")
	const ins = db.prepare("INSERT INTO un_locode VALUES (?,?,?,?,?,?)")
	ins.run("NL", "RTM", "Rotterdam", "rotterdam", 51.92, 4.48)
	ins.run("US", "NYC", "New York", "new york", 40.7, -74)

	return db
}

test("UnLocodeLookup.byName: country + folded name → code", async () => {
	using db = await fixtureDB()
	using lookup = new UnLocodeLookup({ database: db })
	expect(lookup.byName("NL", "Rotterdam")).toBe("NL RTM")
	expect(lookup.byName("us", "new york")).toBe("US NYC")
	expect(lookup.byName("NL", "Nowhere")).toBeNull()
})

test("UnLocodeLookup.nearest: closest coordinate within range", async () => {
	using db = await fixtureDB()
	using lookup = new UnLocodeLookup({ database: db })
	expect(lookup.nearest(40.71, -74.01)).toBe("US NYC")
	expect(lookup.nearest(0, 0, 25)).toBeNull()
})

test("makeUnLocodeAnnotator: byName when available, else nearest", async () => {
	using db = await fixtureDB()
	using lookup = new UnLocodeLookup({ database: db })
	const annotate = makeUnLocodeAnnotator(lookup)

	expect(annotate({ lat: 40.71, lon: -74.01, countryCode: "US", placeName: "New York" })).toEqual({
		unLocode: "US NYC",
	})

	expect(annotate({ lat: 51.92, lon: 4.48 })).toEqual({ unLocode: "NL RTM" })
})
