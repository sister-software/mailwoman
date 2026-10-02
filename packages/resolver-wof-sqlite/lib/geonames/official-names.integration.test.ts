/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `ingestGeonamesAliases({ alternateDir })` decorates alias rows with the alternateNamesV2 language
 * tag, `privateuse` ("preferred"), and the `official` bit, set when the language is CLDR-official for
 * the country. Colloquial and historic forms never qualify. Without the V2 file the fold is untagged.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile } from "@mailwoman/core/fs/writers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test } from "vitest"

import { ingestGeonamesAliases } from "#geonames"
import type { WOFDatabase } from "#schema"

type Row = Record<string, string | number | null>

let dir: TemporaryDirectory
let altDir: TemporaryDirectory

/**
 * One GeoNames main-dump row (19 tab-separated columns).
 */
function mainRow(over: Record<number, string>): string {
	const f = new Array(19).fill("")

	for (const [i, v] of Object.entries(over)) {
		f[Number(i)] = v
	}

	return f.join("\t")
}

/**
 * One alternateNamesV2 row: alternateNameId, geonameid, isolanguage, name,
 * isPreferredName, isShortName, isColloquial, isHistoric, from, to.
 */
function altRow(gid: string, lang: string, name: string, flags: Partial<Record<4 | 5 | 6 | 7, string>> = {}): string {
	const f = ["1", gid, lang, name, "", "", "", "", "", ""]

	for (const [i, v] of Object.entries(flags)) {
		f[Number(i)] = v as string
	}

	return f.join("\t")
}

function freshDB(): DatabaseClient<WOFDatabase> {
	const db = DatabaseClient.temp<WOFDatabase>()

	db.exec(
		`CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
		 latitude REAL, longitude REAL, min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
		 is_current INTEGER, is_deprecated INTEGER, is_ceased INTEGER, is_superseded INTEGER, is_superseding INTEGER, lastmodified INTEGER)`
	)

	db.exec(
		`CREATE TABLE names (id INTEGER, name TEXT, placetype TEXT, country TEXT, language TEXT, privateuse TEXT, official INTEGER, lastmodified INTEGER)`
	)

	db.exec(`CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT, lastmodified INTEGER)`)
	db.exec(`CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)`)

	return db
}

beforeAll(async () => {
	dir = await temporaryDirectory("geonames-official-")
	altDir = await temporaryDirectory("geonames-official-alt-")

	// Turku alternates include the Swedish official name, Greek transliteration and historic form.
	await writeLocalFile(
		mainRow({
			0: "633679",
			1: "Turku",
			2: "Turku",
			3: "Åbo,Tourkou,Aboa,Santa Isabel",
			4: "60.45148",
			5: "22.26869",
			6: "P",
			7: "PPLA",
			8: "FI",
			14: "175945",
		}),
		dir.path("FI.txt")
	)

	// "Santa Isabel" has one language-tagged unflagged row and a separate language-less
	// row carrying the historic evidence (isHistoric and a `to` date).
	// Historic-ness is a fact about the name, so the unflagged row must not classify official.
	const santaIsabelHistoric = ["1", "633679", "", "Santa Isabel", "", "", "", "1", "", "1973"].join("\t")

	await writeLocalTextFile(
		[
			altRow("633679", "sv", "Åbo"), // official Swedish, deliberately not flagged preferred (the real FI row is not)
			altRow("633679", "el", "Tourkou"), // Greek transliteration (not official in FI)
			altRow("633679", "la", "Aboa", { 7: "1" }), // historic, never official
			altRow("633679", "sv", "Santa Isabel"), // official language, unflagged row…
			santaIsabelHistoric, // but a sibling row marks the name historic
		].join("\n"),
		altDir.path("FI.txt")
	)
})

afterAll(async () => {
	await dir[Symbol.asyncDispose]()
	await altDir[Symbol.asyncDispose]()
})

test("V2 tags mark the official-language preferred name; transliterations and historic forms stay 0", async () => {
	using db = freshDB()

	await ingestGeonamesAliases(db, ["FI"], dir.path, () => {}, { alternateDir: altDir.path })

	const byName = (name: string): Row =>
		db.prepare(`SELECT language, privateuse, official FROM names WHERE name = ?`).get(name) as Row

	// Åbo qualifies without isPreferredName.
	// The flag is sparse annotation in real dumps (Turku's actual sv row is unflagged),
	// so officialness must not require it.
	expect(byName("Åbo")).toEqual({ language: "sv", privateuse: "", official: 1 })
	expect(byName("Tourkou")).toEqual({ language: "el", privateuse: "", official: 0 })
	expect(byName("Aboa")).toEqual({ language: "la", privateuse: "", official: 0 })
	// The historic evidence lives on a different row than the language tag.
	expect(byName("Santa Isabel")).toEqual({ language: "sv", privateuse: "", official: 0 })
	// The primary-name mirror row stays untagged.
	// `spr.name` is already the name-exact tier.
	expect(byName("Turku")).toEqual({ language: "", privateuse: "", official: 0 })
})

test("without the V2 file the fold is untagged, exactly the pre-#936 behavior", async () => {
	using db = freshDB()

	await ingestGeonamesAliases(db, ["FI"], dir.path, () => {}, { alternateDir: altDir.path("nope") })

	const rows = db.prepare(`SELECT name, language, privateuse, official FROM names ORDER BY name`).all() as Row[]

	expect(rows).toHaveLength(5)

	for (const r of rows) {
		expect(r.language).toBe("")
		expect(r.privateuse).toBe("")
		expect(r.official).toBe(0)
	}
})
