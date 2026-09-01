/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `postcode-triples` — the extraction that feeds the `trailing-region` slice.
 *
 *   Every test here is about a row that must NOT be emitted, because each one corresponds to something the slice would
 *   otherwise teach wrongly: a code counted twice, a sub-locality labelled `locality`, a blank region, or a country
 *   whose postcode placement nothing attests.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	applyCountryBudget,
	applyLocalityQuota,
	POSTCODE_CONVENTIONS,
	type PostcodeTriple,
	readTriplesFromGeonames,
} from "@mailwoman/corpus/tools/postcode-triples"
import { afterAll, describe, expect, it } from "vitest"

const TAB = String.fromCharCode(9)
const root = await temporaryDirectory("mw-postcode-triples-")

afterAll(() => root[Symbol.asyncDispose]())

/**
 * Write a GeoNames-shaped export as `[country, postcode, place, admin1, admin2]`.
 *
 * The real file has twelve columns and the reader takes four of them from non-adjacent positions — place is 2, admin1
 * is 3, admin2 is FIVE. Writing them in argument order and padding the gap keeps the fixture readable while still
 * exercising the real offsets; a fixture that packed them adjacently would pass against a reader with the wrong index.
 */
async function writeExport(
	name: string,
	rows: ReadonlyArray<readonly [string, string, string, string, string]>
): Promise<string> {
	const path = root.resolve(name)

	const line = ([country, postcode, place, admin1, admin2]: readonly string[]): string =>
		[country, postcode, place, admin1, "code", admin2].join(TAB)

	await writeLocalTextFile(rows.map((cells) => line(cells)).join("\n") + "\n", path)

	return path
}

/**
 * Gate that accepts everything, so a test about deduplication is not also a test about the gazetteer.
 */
const acceptAll = { isKnownLocality: () => true }

describe("readTriplesFromGeonames", () => {
	it("keeps ONE row for a code published both hyphenated and bare", async () => {
		// PT and PL publish every code twice — exactly 2.00× on both. Keeping both doubles the country's weight in the
		// slice while adding no fact.
		const path = await writeExport("pt.txt", [
			["PT", "3750-000", "Borralha", "Aveiro", "Águeda"],
			["PT", "3750000", "Borralha", "Aveiro", "Águeda"],
			["PT", "3750-011", "Borralha", "Aveiro", "Águeda"],
		])

		const triples = await readTriplesFromGeonames("PT", path, "Portugal", acceptAll)

		expect(triples).toHaveLength(2)
		// The punctuated surface is the one people write, so it is the one that survives.
		expect(triples[0]?.postcode).toBe("3750-000")
		// admin2 is the locality; column 3 becomes the dependent locality.
		expect(triples[0]?.locality).toBe("Águeda")
		expect(triples[0]?.dependentLocality).toBe("Borralha")
	})

	it("drops a row with NO region rather than emitting a blank one", async () => {
		// ZA's export is 100% place and 0% admin1. A blank region would look like data and teach nothing.
		const path = await writeExport("blank.txt", [
			["PT", "1000-001", "Alvalade", "", "Lisboa"],
			["PT", "1000-002", "Alvalade", "Lisboa", "Lisboa"],
		])

		expect(await readTriplesFromGeonames("PT", path, "Portugal", acceptAll)).toHaveLength(1)
	})

	it("drops a place the gazetteer does not know as a locality", async () => {
		// `Zona Centro` is a colonia and now correctly lands in `dependentLocality`; the gate applies to admin2, the
		// locality, so a row whose CITY the gazetteer does not know is the one that drops.
		const path = await writeExport("mx.txt", [
			["MX", "20000", "Zona Centro", "Aguascalientes", "Unknownville"],
			["MX", "20010", "Colonia Norte", "Aguascalientes", "Aguascalientes"],
		])

		const triples = await readTriplesFromGeonames("MX", path, "Mexico", {
			isKnownLocality: (name) => name === "Aguascalientes",
		})

		expect(triples).toHaveLength(1)
		expect(triples[0]?.locality).toBe("Aguascalientes")
	})

	it("stamps the country's attested PLACEMENT onto every row", async () => {
		const path = await writeExport("in.txt", [["IN", "560038", "Mahatma Gandhi Road", "Karnataka", "Bengaluru"]])

		const [row] = await readTriplesFromGeonames("IN", path, "India", acceptAll)

		// `…, Bengaluru, Karnataka 560038, India` — the `in_structured` board row. Column 3 is `Mahatma Gandhi Road`, a
		// STREET, which is exactly why it must not be read as the locality.
		expect(row?.locality).toBe("Bengaluru")
		expect(row?.dependentLocality).toBe("Mahatma Gandhi Road")
		expect(row?.postcodePlacement).toBe("after_region")
		expect(row?.locale).toBe("en-IN")
	})

	it("emits NOTHING for a country whose placement nothing attests", async () => {
		// Not a failure — extracting AU with a guessed placement would teach a convention AU may not use.
		const path = await writeExport("au.txt", [["AU", "2000", "The Rocks", "New South Wales", "Sydney"]])

		expect(await readTriplesFromGeonames("AU", path, "Australia", acceptAll)).toEqual([])
	})
})

describe("applyLocalityQuota", () => {
	const make = (locality: string, postcode: string): PostcodeTriple => ({
		postcode,
		locality,
		region: "Saxony",
		country: "Germany",
		cc: "DE",
		locale: "de-DE",
		postcodePlacement: "leading",
	})

	it("bounds a hub locality WITHOUT deleting it", () => {
		// `Schwedt/Oder` claims 9,222 DE postcodes against a median of 1. A threshold would drop the city entirely, which
		// removes exactly the places a parser most needs to have seen; the quota keeps it and bounds the repetition.
		const triples = Array.from({ length: 100 }, (_, i) => make("Schwedt/Oder", String(i)))

		const kept = applyLocalityQuota(triples, 24)

		expect(kept).toHaveLength(24)
		expect(kept.every((row) => row.locality === "Schwedt/Oder")).toBe(true)
	})

	it("counts per COUNTRY as well as per locality", () => {
		// Two countries can hold the same locality name; pooling them would halve each one's real quota.
		const triples = [make("Barcelona", "1"), { ...make("Barcelona", "2"), cc: "VE" }]

		expect(applyLocalityQuota(triples, 1)).toHaveLength(2)
	})

	it("keeps source order, so the same quota selects the same rows", () => {
		const triples = [make("Leipzig", "04103"), make("Leipzig", "04105"), make("Leipzig", "04107")]

		expect(applyLocalityQuota(triples, 2).map((row) => row.postcode)).toEqual(["04103", "04105"])
	})
})

describe("applyCountryBudget", () => {
	const make = (cc: string, locality: string, postcode: string): PostcodeTriple => ({
		postcode,
		locality,
		region: "R",
		country: "C",
		cc,
		locale: "en",
		postcodePlacement: cc === "IN" ? "after_region" : "leading",
	})

	it("bounds a country a per-locality quota cannot", () => {
		// IN has 128,152 distinct localities, so even a quota of ONE leaves it contributing 63,533 rows against 39,790
		// from the other seven combined. Without this the slice teaches the trailing surface as an Indian fact.
		const triples = [
			...Array.from({ length: 50 }, (_, i) => make("IN", `village-${i}`, String(i))),
			...Array.from({ length: 5 }, (_, i) => make("FR", `commune-${i}`, String(i))),
		]

		const kept = applyCountryBudget(
			triples,
			new Map([
				["IN", 5],
				["FR", 5],
			])
		)

		expect(kept.filter((row) => row.cc === "IN")).toHaveLength(5)
		expect(kept.filter((row) => row.cc === "FR")).toHaveLength(5)
	})

	it("drops a country the budget does not name, rather than letting it through uncapped", () => {
		// An unnamed country is one nobody sized. Passing it through is how a source silently dominates a slice.
		const triples = [make("FR", "Lyon", "69000"), make("MX", "Puebla", "72000")]

		expect(applyCountryBudget(triples, new Map([["FR", 10]])).map((row) => row.cc)).toEqual(["FR"])
	})

	it("accepts one number as the same cap for every country", () => {
		const triples = [make("FR", "a", "1"), make("FR", "b", "2"), make("MX", "c", "3")]

		expect(applyCountryBudget(triples, 1).map((row) => row.cc)).toEqual(["FR", "MX"])
	})
})

describe("POSTCODE_CONVENTIONS", () => {
	it("keeps the two trailing conventions APART", () => {
		// VE writes the code on the locality segment and IN on the region segment. Flattening them into one "trailing"
		// surface would teach each country the other's shape.
		expect(POSTCODE_CONVENTIONS.get("VE")?.placement).toBe("after_locality")
		expect(POSTCODE_CONVENTIONS.get("IN")?.placement).toBe("after_region")
	})

	it("omits countries whose surface no board row attests", () => {
		// The bar is attestation, not plausibility — see the map's docstring for why AU and ZA do not clear it.
		expect(POSTCODE_CONVENTIONS.has("AU")).toBe(false)
		expect(POSTCODE_CONVENTIONS.has("ZA")).toBe(false)
	})
})
