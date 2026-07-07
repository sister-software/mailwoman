/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #936 ingest bit — `ingestGeonamesAliases({ alternateDir })` decorates alias rows with the
 *   alternateNamesV2 language tag, `privateuse` ("preferred"), and the `official` bit (language is
 *   CLDR-official for the country; colloquial/historic never qualify). The Turku fixture mirrors
 *   the motivating row: "Åbo" is Turku's official Swedish name, not a mere alias. Without the V2
 *   file the fold is byte-identical to the pre-#936 untagged behavior.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterAll, beforeAll, expect, test } from "vitest"

import { ingestGeonamesAliases } from "./geonames-aliases.js"

type Row = Record<string, string | number | null>

let dir: string
let altDir: string

/** One GeoNames main-dump row (19 tab-separated columns). */
function mainRow(over: Record<number, string>): string {
	const f = Array(19).fill("")

	for (const [i, v] of Object.entries(over)) {
		f[Number(i)] = v
	}

	return f.join("\t")
}

/**
 * One alternateNamesV2 row: alternateNameId, geonameid, isolanguage, name, isPreferredName, isShortName, isColloquial,
 * isHistoric, from, to.
 */
function altRow(gid: string, lang: string, name: string, flags: Partial<Record<4 | 5 | 6 | 7, string>> = {}): string {
	const f = ["1", gid, lang, name, "", "", "", "", "", ""]

	for (const [i, v] of Object.entries(flags)) {
		f[Number(i)] = v as string
	}

	return f.join("\t")
}

function freshDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:")

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

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "geonames-official-"))
	altDir = mkdtempSync(join(tmpdir(), "geonames-official-alt-"))

	// Turku: alternates carry the Swedish official name, a Greek transliteration, and a historic form.
	writeFileSync(
		join(dir, "FI.txt"),
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
		})
	)
	// "Santa Isabel" reproduces the Malabo shape: one language-tagged UNFLAGGED row + a separate
	// language-less row carrying the historic evidence (isHistoric + a `to` date). Historic-ness is a
	// fact about the NAME — the unflagged row must not classify official.
	const santaIsabelHistoric = ["1", "633679", "", "Santa Isabel", "", "", "", "1", "", "1973"].join("\t")

	writeFileSync(
		join(altDir, "FI.txt"),
		[
			altRow("633679", "sv", "Åbo"), // official Swedish — deliberately NOT preferred-flagged (the real FI row isn't)
			altRow("633679", "el", "Tourkou"), // Greek transliteration — not official in FI
			altRow("633679", "la", "Aboa", { 7: "1" }), // historic — never official
			altRow("633679", "sv", "Santa Isabel"), // official language, unflagged row…
			santaIsabelHistoric, // …but a sibling row marks the NAME historic
		].join("\n")
	)
})

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
	rmSync(altDir, { recursive: true, force: true })
})

test("V2 tags mark the official-language preferred name; transliterations and historic forms stay 0", () => {
	const db = freshDb()

	ingestGeonamesAliases(db, ["FI"], dir, () => {}, { alternateDir: altDir })

	const byName = (name: string): Row =>
		db.prepare(`SELECT language, privateuse, official FROM names WHERE name = ?`).get(name) as Row

	// Åbo qualifies WITHOUT isPreferredName — the flag is sparse annotation in real dumps (Turku's
	// actual sv row is unflagged), so officialness must not require it.
	expect(byName("Åbo")).toEqual({ language: "sv", privateuse: "", official: 1 })
	expect(byName("Tourkou")).toEqual({ language: "el", privateuse: "", official: 0 })
	expect(byName("Aboa")).toEqual({ language: "la", privateuse: "", official: 0 })
	// The Malabo shape: the historic evidence lives on a DIFFERENT row than the language tag.
	expect(byName("Santa Isabel")).toEqual({ language: "sv", privateuse: "", official: 0 })
	// The primary-name mirror row stays untagged — spr.name already IS the name-exact tier.
	expect(byName("Turku")).toEqual({ language: "", privateuse: "", official: 0 })
	db.close()
})

test("without the V2 file the fold is untagged, exactly the pre-#936 behavior", () => {
	const db = freshDb()

	ingestGeonamesAliases(db, ["FI"], dir, () => {}, { alternateDir: join(altDir, "nope") })

	const rows = db.prepare(`SELECT name, language, privateuse, official FROM names ORDER BY name`).all() as Row[]

	expect(rows.length).toBe(5)

	for (const r of rows) {
		expect(r.language).toBe("")
		expect(r.privateuse).toBe("")
		expect(r.official).toBe(0)
	}
	db.close()
})
