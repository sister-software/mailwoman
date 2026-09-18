/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `postcode-triples` — the extraction that feeds the `trailing-region` recipe.
 *
 *   Every test here is about a row that must not be emitted, because each one corresponds to something the recipe would
 *   otherwise teach wrongly: a code counted twice, a sub-locality labelled `locality`, a blank region, or a country
 *   whose postcode placement nothing attests.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	applyCountryBudget,
	applyLocalityQuota,
	localityWrittenForm,
	POSTCODE_CONVENTIONS,
	type PostcodeTriple,
	readPairsFromAdmin,
	readTriplesFromGeonames,
	readTriplesFromParentJoin,
	regionWrittenForms,
} from "@mailwoman/corpus/tools/postcode-triples"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, describe, expect, it } from "vitest"

const TAB = String.fromCharCode(9)
const root = await temporaryDirectory("mw-postcode-triples-")

afterAll(() => root[Symbol.asyncDispose]())

/**
 * Write a GeoNames-shaped export as `[country, postcode, place, admin1, admin2]`.
 *
 * The real file has twelve columns and the reader takes four of them from non-adjacent positions — place is 2, admin1
 * is 3, admin2 is 5. Writing them in argument order and padding the gap keeps the fixture readable while still
 * exercising the real offsets; a fixture that packed them adjacently would pass against a reader with the wrong index.
 */
async function writeExport(
	name: string,
	rows: ReadonlyArray<readonly [string, string, string, string, string]>
): Promise<string> {
	const path = root.resolve(name)

	const line = ([country, postcode, place, admin1, admin2]: readonly string[]): string =>
		[country, postcode, place, admin1, "code", admin2].join(TAB)

	await writeLocalTextFile(
		rows.map((cells) => line(cells)),
		path
	)

	return path
}

/**
 * Check that accepts everything, so a test about deduplication is not also a test about the gazetteer.
 */
const acceptAll = { isKnownLocality: () => true }

describe("readTriplesFromGeonames", () => {
	it("keeps ONE row for a code published both hyphenated and bare", async () => {
		// PT and PL publish every code twice — exactly 2.00× on both. Keeping both doubles the country's weight in the
		// recipe output while adding no fact.
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
		// `Zona Centro` is a colonia and now correctly lands in `dependentLocality`; the check applies to admin2, the
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

	it("reads BR from the default column, where the municipality sits in column 3 and admin2 alike", async () => {
		// `BR 69945-000 Acrelândia Acre 01 Acrelândia 1200013` — the municipality is written twice and the state is
		// admin1, so the US `place` override would be a no-op here and the default is already right. Placement is
		// attested by two `br_*` board rows carrying locality, region and CEP in that order —
		// `Caxias do Sul, RS 95090-020, Brazil` and `Brasília - Federal District, 70390-100, Brazil`.
		const path = await writeExport("br.txt", [["BR", "69945-000", "Acrelândia", "Acre", "Acrelândia"]])

		const [row] = await readTriplesFromGeonames("BR", path, "Brazil", acceptAll)

		expect(row?.locality).toBe("Acrelândia")
		expect(row?.region).toBe("Acre")
		expect(row?.postcodePlacement).toBe("after_region")
		expect(row?.locale).toBe("pt-BR")
	})

	it("takes the CITY from the column that country's export puts it in, which is inverted for the US", async () => {
		// `US 94901 San Rafael California CA Marin` — column 3 is the city and admin2 is the COUNTY, the inverse of
		// PT/MX/IN. The default mapping would emit `Marin` as the locality and train a county as a city, which is the
		// `Mahatma Gandhi Road` defect this reader's header records, from the other direction.
		const path = await writeExport("us.txt", [
			["US", "94901", "San Rafael", "California", "Marin"],
			["US", "60639", "Chicago", "Illinois", "Cook"],
		])

		const triples = await readTriplesFromGeonames("US", path, "United States", acceptAll)

		expect(triples.map((t) => t.locality)).toEqual(["San Rafael", "Chicago"])
		// A US county is not a segment the address line writes, so it is dropped rather than carried as a dependent
		// locality the way a colonia is.
		expect(triples.every((t) => t.dependentLocality === undefined)).toBe(true)
		expect(triples.every((t) => t.postcodePlacement === "after_region" && t.locale === "en-US")).toBe(true)
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
		// IN has 128,152 distinct localities, so even a quota of one leaves it contributing 63,533 rows against 39,790
		// from the other seven combined. Without this the recipe teaches the trailing surface as an Indian fact.
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
		// An unnamed country is one nobody sized. Passing it through is how a source silently dominates a recipe output.
		const triples = [make("FR", "Lyon", "69000"), make("MX", "Puebla", "72000")]

		expect(applyCountryBudget(triples, new Map([["FR", 10]])).map((row) => row.cc)).toEqual(["FR"])
	})

	it("accepts one number as the same cap for every country", () => {
		const triples = [make("FR", "a", "1"), make("FR", "b", "2"), make("MX", "c", "3")]

		expect(applyCountryBudget(triples, 1).map((row) => row.cc)).toEqual(["FR", "MX"])
	})

	it("spends the budget ACROSS regions, because source order is postcode order and a postcode sorts geographically", () => {
		// The defect this replaced, measured on the tuples the tool had already produced: the US took its 16,000 from 23
		// of 56 states, Mexico 7 regions, Portugal 5, India 24 of 36 — one corner of each country.
		const row = (region: string, n: number) => ({ ...make("US", `city-${region}-${n}`, String(n)), region })

		const triples = [
			...Array.from({ length: 10 }, (_, i) => row("Alabama", i)),
			...Array.from({ length: 10 }, (_, i) => row("Wyoming", i)),
		]

		const kept = applyCountryBudget(triples, 4)

		expect(kept.map((r) => r.region)).toEqual(["Alabama", "Wyoming", "Alabama", "Wyoming"])
	})

	it("keeps source order WITHIN a region, so the same budget selects the same rows", () => {
		const row = (region: string, postcode: string) => ({ ...make("US", "city", postcode), region })
		const triples = [row("Alabama", "35203"), row("Alabama", "36104"), row("Wyoming", "82001")]

		expect(applyCountryBudget(triples, 3).map((r) => r.postcode)).toEqual(["35203", "82001", "36104"])
	})

	it("survives rows carrying no region, which is what an admin-pair caller passes", () => {
		const triples = [make("FR", "Lyon", "69000"), make("FR", "Nice", "06000")]

		expect(applyCountryBudget(triples, 1).map((r) => r.locality)).toEqual(["Lyon"])
	})
})

describe("regionWrittenForms", () => {
	it("emits the official-language names, the co-official ones, then the exonym, without repeats", () => {
		const balearic = { official: ["Islas Baleares"], coOfficial: ["Illes Balears"] }
		const surfaces = regionWrittenForms("Balearic Islands", balearic)

		expect(surfaces).toEqual(["Islas Baleares", "Illes Balears", "Balearic Islands"])
		expect(regionWrittenForms("Zamora", { official: ["Zamora"], coOfficial: [] })).toEqual(["Zamora"])

		// The Catalan preferred name keeps the provincial generic; an envelope does not, so it dedupes with the Castilian.
		const barcelona = { official: ["Barcelona"], coOfficial: ["Província de Barcelona"] }
		const corunna = { official: ["La Coruña"], coOfficial: ["Província d'A Coruña", "A Coruña"] }

		expect(regionWrittenForms("Barcelona", barcelona)).toEqual(["Barcelona"])
		expect(regionWrittenForms("Corunna", corunna)).toEqual(["La Coruña", "A Coruña", "Corunna"])
		expect(regionWrittenForms("Highland", { official: [], coOfficial: [] })).toEqual(["Highland"])
	})

	it("splits a bilingual joined name into both halves and leaves an unspaced slash alone", () => {
		const none = { official: [], coOfficial: [] }

		expect(regionWrittenForms("New Brunswick / Nouveau-Brunswick", none)).toEqual([
			"New Brunswick",
			"Nouveau-Brunswick",
		])

		expect(regionWrittenForms("Koper / Capodistria", none)).toEqual(["Koper", "Capodistria"])
		expect(regionWrittenForms("Schwedt/Oder", none)).toEqual(["Schwedt/Oder"])
	})
})

describe("localityWrittenForm", () => {
	it("restores the diacritics of the gazetteer's stripped name and never fans out", () => {
		const palma = { official: ["Palma", "Palma de Mallorca"], coOfficial: [] }

		expect(localityWrittenForm("Cordoba", { official: ["Córdoba"], coOfficial: [] })).toBe("Córdoba")
		expect(localityWrittenForm("Palma de Mallorca", palma)).toBe("Palma de Mallorca")
		expect(localityWrittenForm("Leon", { official: [], coOfficial: [] })).toBe("Leon")
	})
})

/**
 * A fixture pair of gazetteers on the unified schema: a Balearic and a Zamoran postcode whose parents resolve, plus a
 * postcode whose parent has no region. Names carry the WOF shape #1673 measured: `spr.name` is the English exonym or
 * the stripped Castilian, the `spa` preferred form is accented, and the `cat` preferred form of a Castilian province
 * names the whole community.
 */
async function writeFixtureGazetteers(): Promise<{ adminDB: string; postcodeDB: string }> {
	const adminDB = String(root.resolve("admin.db"))
	const postcodeDB = String(root.resolve("postalcode-intl.db"))

	{
		using admin = new DatabaseClient<WOFDatabase>(adminDB)
		await createUnifiedSchema(admin)

		const spr = admin.prepare("INSERT INTO spr (id, parent_id, name, placetype, country) VALUES (?, ?, ?, ?, ?)")
		spr.run(1, -1, "Spain", "country", "ES")
		spr.run(10, 1, "Balearic Islands", "region", "ES")
		spr.run(11, 1, "Zamora", "region", "ES")
		spr.run(100, 10, "Palma de Mallorca", "locality", "ES")
		spr.run(101, 11, "Toro", "locality", "ES")
		spr.run(102, 1, "Adrift", "locality", "ES")

		const ancestors = admin.prepare("INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)")
		ancestors.run(100, 10, "region")
		ancestors.run(100, 1, "country")
		ancestors.run(101, 11, "region")
		ancestors.run(101, 1, "country")
		ancestors.run(102, 1, "country")

		const names = admin.prepare("INSERT INTO names (id, name, language, privateuse, official) VALUES (?, ?, ?, ?, ?)")
		names.run(10, "Islas Baleares", "spa", "preferred", 1)
		names.run(10, "Illes Balears", "cat", "preferred", 0)
		names.run(10, "Balear Uharteak", "eus", "preferred", 0)
		names.run(10, "Balearic Islands", "eng", "preferred", 0)
		names.run(10, "Baleares", "spa", "variant", 0)
		names.run(11, "Zamora", "spa", "preferred", 1)
		names.run(11, "Castella i Lleó", "cat", "preferred", 0)
		names.run(100, "Palma", "spa", "preferred", 1)
		names.run(100, "Palma de Mallorca", "spa", "preferred", 1)
		names.run(100, "Palma", "cat", "preferred", 0)
	}

	{
		using postcodes = new DatabaseClient<WOFDatabase>(postcodeDB)
		await createUnifiedSchema(postcodes)

		const spr = postcodes.prepare("INSERT INTO spr (id, parent_id, name, placetype, country) VALUES (?, ?, ?, ?, ?)")
		spr.run(1000, 100, "07001", "postalcode", "ES")
		spr.run(1001, 101, "49800", "postalcode", "ES")
		spr.run(1002, 102, "99999", "postalcode", "ES")
		spr.run(1003, 0, "00000", "postalcode", "ES")
	}

	return { adminDB, postcodeDB }
}

describe("readTriplesFromParentJoin", () => {
	it("emits one row per region surface in the languages the province is written in, and none for a Castilian-only province's parent community", async () => {
		const { adminDB, postcodeDB } = await writeFixtureGazetteers()
		const triples = await readTriplesFromParentJoin(["ES"], { adminDB, postcodeDB })

		const lines = triples.map((t) => `${t.postcode} ${t.locality}, ${t.region}, ${t.country}`)

		const expected = [
			"07001 Palma de Mallorca, Islas Baleares, Spain",
			"07001 Palma de Mallorca, Illes Balears, Spain",
			"07001 Palma de Mallorca, Balearic Islands, Spain",
			"49800 Toro, Zamora, Spain",
		]

		expect(lines).toEqual(expected)
		expect(triples.every((t) => t.cc === "ES" && t.locale === "es-ES" && t.postcodePlacement === "leading")).toBe(true)
	})
})

describe("readPairsFromAdmin", () => {
	it("answers the pair for a country no postcode source reaches, and splits the bilingual joined region name", async () => {
		const adminDB = String(root.resolve("admin-ca.db"))

		{
			using admin = new DatabaseClient<WOFDatabase>(adminDB)
			await createUnifiedSchema(admin)

			const spr = admin.prepare(
				"INSERT INTO spr (id, parent_id, name, placetype, country, is_current, is_deprecated) VALUES (?, ?, ?, ?, ?, ?, ?)"
			)

			spr.run(1, -1, "Canada", "country", "CA", 1, 0)
			spr.run(10, 1, "Newfoundland and Labrador", "region", "CA", 1, 0)
			spr.run(11, 1, "New Brunswick / Nouveau-Brunswick", "region", "CA", 1, 0)
			spr.run(100, 10, "St. John's", "locality", "CA", 1, 0)
			spr.run(101, 11, "Moncton", "locality", "CA", 1, 0)
			spr.run(102, 10, "Gander", "locality", "CA", 0, 0)

			const ancestors = admin.prepare("INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)")

			for (const [id, region] of [
				[100, 10],
				[101, 11],
				[102, 10],
			] as const) {
				ancestors.run(id, region, "region")
				ancestors.run(id, 1, "country")
			}
		}

		const pairs = await readPairsFromAdmin(["CA"], { adminDB, locale: () => "en-CA" })

		expect(pairs.map((p) => `${p.locality}, ${p.region}, ${p.country}`)).toEqual([
			"St. John's, Newfoundland and Labrador, Canada",
			"Moncton, New Brunswick, Canada",
			"Moncton, Nouveau-Brunswick, Canada",
		])

		expect(pairs.every((p) => p.cc === "CA" && p.locale === "en-CA")).toBe(true)
		// No postcode field at all — a postcode asserts a fact about a place, and this source does not carry one.
		expect(pairs.every((p) => !("postcode" in p))).toBe(true)
	})

	it("stamps `und` when the caller names no locale, rather than guessing one from the country", async () => {
		const pairs = await readPairsFromAdmin(["CA"], { adminDB: String(root.resolve("admin-ca.db")) })

		expect(pairs.every((p) => p.locale === "und")).toBe(true)
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
