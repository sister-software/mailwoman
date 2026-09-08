/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Over the fixture built by the astrogeology package's `buildSearchIndex` from its five Moon fixture features: Marco
 *   Polo P (28 km), Tycho (85 km), Marvin (4.6 km), Buys-Ballot H (24 km, clean name "Buys Ballot H") and Planitia
 *   Descensus (no diameter).
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { loadSearchIndex, type PlanetarySearch } from "@mailwoman/planetary/search"
import { beforeAll, expect, test } from "vitest"

const FIXTURE = resolvePackagePath("@mailwoman/planetary", "test", "fixtures", "moon-search.ancestrie")

let search: PlanetarySearch

beforeAll(async () => {
	search = await loadSearchIndex(FIXTURE, { readBytes: async (url) => new Uint8Array(await readLocalBuffer(url)) })
})

test("prefix search finds Tycho with its position", () => {
	const hits = search.query("tyc")

	expect(hits[0]?.name).toBe("Tycho")
	expect(hits[0]?.centerLat).toBeCloseTo(-43.2958, 3)
	expect(hits[0]?.centerLon).toBeCloseTo(-11.2153, 3)
})

test("at a shared prefix the larger feature ranks first", () => {
	expect(search.query("mar").map((hit) => hit.name)).toEqual(["Marco Polo P", "Marvin"])
})

test("a feature whose name and clean name both match is one hit, and the alias resolves", () => {
	expect(search.query("buys").map((hit) => hit.name)).toEqual(["Buys-Ballot H"])
	expect(search.query("buys ballot")[0]?.name).toBe("Buys-Ballot H")
})

test("byID answers the feature behind a stable id, and null for an unknown or malformed one", () => {
	expect(search.byID("6163")).toMatchObject({ id: "6163", name: "Tycho", featureType: "Crater, craters" })
	expect(search.byID("1")).toBeNull()
	expect(search.byID("tycho")).toBeNull()
})

test("a blank query and a query with no match answer nothing", () => {
	expect(search.query("")).toEqual([])
	expect(search.query("   ")).toEqual([])
	expect(search.query("zzz")).toEqual([])
})

test("the limit caps the answer", () => {
	expect(search.query("m", 1)).toHaveLength(1)
})
