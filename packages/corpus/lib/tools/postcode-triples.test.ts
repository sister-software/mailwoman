/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the postcode-triple extraction that feeds the `trailing-region` recipe.
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
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const TAB = String.fromCharCode(9)
const root = await temporaryDirectory("mw-postcode-triples-")

afterAll(() => root[Symbol.asyncDispose]())

/**
 * Writes a GeoNames-shaped export from `[country, postcode, place, admin1, admin2]` rows.
 *
 * The filler column puts admin2 at index 5, as in the real file, so the fixture
 * exercises the reader's real offsets.
 */
async function writeExport(
	name: string,
	rows: ReadonlyArray<readonly [string, string, string, string, string]>
): Promise<PathBuilder> {
	const path = root.path(name)

	const line = ([country, postcode, place, admin1, admin2]: readonly string[]): string =>
		[country, postcode, place, admin1, "code", admin2].join(TAB)

	await writeLocalTextFile(
		rows.map((cells) => line(cells)),
		path
	)

	return path
}

// This gazetteer check accepts every locality, so tests of other rules do not depend on it.
const acceptAll = { isKnownLocality: () => true }

describe("readTriplesFromGeonames", () => {
	it("keeps ONE row for a code published both hyphenated and bare", async () => {
		// The PT and PL exports list every code in both forms, which would double those countries' weight.
		const path = await writeExport("pt.txt", [
			["PT", "3750-000", "Borralha", "Aveiro", "Águeda"],
			["PT", "3750000", "Borralha", "Aveiro", "Águeda"],
			["PT", "3750-011", "Borralha", "Aveiro", "Águeda"],
		])

		const triples = await readTriplesFromGeonames("PT", path, "Portugal", acceptAll)

		expect(triples).toHaveLength(2)
		// The reader keeps the hyphenated form because people write it that way.
		expect(triples[0]?.postcode).toBe("3750-000")
		// By default, admin2 is the locality and the place column is the dependent locality.
		expect(triples[0]?.locality).toBe("Águeda")
		expect(triples[0]?.dependentLocality).toBe("Borralha")
	})

	it("drops a row with NO region rather than emitting a blank one", async () => {
		// Some exports, such as ZA, leave admin1 blank on every row.
		const path = await writeExport("blank.txt", [
			["PT", "1000-001", "Alvalade", "", "Lisboa"],
			["PT", "1000-002", "Alvalade", "Lisboa", "Lisboa"],
		])

		expect(await readTriplesFromGeonames("PT", path, "Portugal", acceptAll)).toHaveLength(1)
	})

	it("drops a place the gazetteer does not know as a locality", async () => {
		// The gazetteer check applies to the admin2 locality, and the colonia goes to `dependentLocality`.
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

		// The place column holds a street here, so it must stay out of the locality.
		expect(row?.locality).toBe("Bengaluru")
		expect(row?.dependentLocality).toBe("Mahatma Gandhi Road")
		expect(row?.postcodePlacement).toBe("after_region")
		expect(row?.locale).toBe("en-IN")
	})

	it("reads BR from the default column, where the municipality sits in column 3 and admin2 alike", async () => {
		// The BR export writes the municipality in both the place and admin2 columns, so the default mapping is correct.
		const path = await writeExport("br.txt", [["BR", "69945-000", "Acrelândia", "Acre", "Acrelândia"]])

		const [row] = await readTriplesFromGeonames("BR", path, "Brazil", acceptAll)

		expect(row?.locality).toBe("Acrelândia")
		expect(row?.region).toBe("Acre")
		expect(row?.postcodePlacement).toBe("after_region")
		expect(row?.locale).toBe("pt-BR")
	})

	it("takes the CITY from the column that country's export puts it in, which is inverted for the US", async () => {
		// In the US export, the place column is the city and admin2 is the county.
		const path = await writeExport("us.txt", [
			["US", "94901", "San Rafael", "California", "Marin"],
			["US", "60639", "Chicago", "Illinois", "Cook"],
		])

		const triples = await readTriplesFromGeonames("US", path, "United States", acceptAll)

		expect(triples.map((t) => t.locality)).toEqual(["San Rafael", "Chicago"])
		// US address lines omit the county, so the reader drops it.
		expect(triples.every((t) => t.dependentLocality === undefined)).toBe(true)
		expect(triples.every((t) => t.postcodePlacement === "after_region" && t.locale === "en-US")).toBe(true)
	})

	it("emits NOTHING for a country whose placement nothing attests", async () => {
		// An empty result is expected, because a guessed placement could be wrong.
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
		// A locality with many postcodes keeps up to the quota instead of being dropped.
		const triples = Array.from({ length: 100 }, (_, i) => make("Schwedt/Oder", String(i)))

		const kept = applyLocalityQuota(triples, 24)

		expect(kept).toHaveLength(24)
		expect(kept.every((row) => row.locality === "Schwedt/Oder")).toBe(true)
	})

	it("counts per COUNTRY as well as per locality", () => {
		// Each country gets its own quota for a shared locality name.
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
		// A country with many distinct localities can dominate even under a per-locality quota.
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
		// A country without a budget could dominate the output, so the budget drops it.
		const triples = [make("FR", "Lyon", "69000"), make("MX", "Puebla", "72000")]

		expect(applyCountryBudget(triples, new Map([["FR", 10]])).map((row) => row.cc)).toEqual(["FR"])
	})

	it("accepts one number as the same cap for every country", () => {
		const triples = [make("FR", "a", "1"), make("FR", "b", "2"), make("MX", "c", "3")]

		expect(applyCountryBudget(triples, 1).map((row) => row.cc)).toEqual(["FR", "MX"])
	})

	it("spends the budget ACROSS regions, because source order is postcode order and a postcode sorts geographically", () => {
		// Taking rows in source order would fill the budget from the first few regions.
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

		// The Catalan preferred name carries a "Província de" generic that envelopes omit.
		// Without it, the name matches the Castilian form and deduplicates.
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
 * Writes an admin and a postcode gazetteer on the unified schema.
 *
 * Two postcodes resolve to a region, one resolves to a locality without a region, and one has no parent.
 * The names follow the WOF pattern: `spr.name` holds the English or unaccented name,
 * and the Catalan preferred name of a Castilian province is the name of its whole community.
 */
async function writeFixtureGazetteers(): Promise<{ adminDB: PathBuilder; postcodeDB: PathBuilder }> {
	const adminDB = root.path("admin.db")
	const postcodeDB = root.path("postalcode-intl.db")

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
		const adminDB = root.path("admin-ca.db")

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
		// The admin source has no postcodes, so the pairs must omit the field.
		expect(pairs.every((p) => !("postcode" in p))).toBe(true)
	})

	it("stamps `und` when the caller names no locale, rather than guessing one from the country", async () => {
		const pairs = await readPairsFromAdmin(["CA"], { adminDB: root.path("admin-ca.db") })

		expect(pairs.every((p) => p.locale === "und")).toBe(true)
	})
})

describe("POSTCODE_CONVENTIONS", () => {
	it("keeps the two trailing conventions APART", () => {
		// VE writes the code after the locality, and IN writes it after the region.
		expect(POSTCODE_CONVENTIONS.get("VE")?.placement).toBe("after_locality")
		expect(POSTCODE_CONVENTIONS.get("IN")?.placement).toBe("after_region")
	})

	it("omits countries whose surface no board row attests", () => {
		// A country needs an eval board row that shows its placement.
		expect(POSTCODE_CONVENTIONS.has("AU")).toBe(false)
		expect(POSTCODE_CONVENTIONS.has("ZA")).toBe(false)
	})
})
