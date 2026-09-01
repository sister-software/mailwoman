/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `mwdev_sources` — what data we hold, per country, per artifact.
 *
 *   The tests that matter are the ones about ABSENCE, because every one of them corresponds to a wrong conclusion
 *   somebody could draw from a row count: a extract with rows but no join tables reads as usable and is not; a country
 *   asked for and missing must come back as a zero rather than as a missing key; and an unreadable file is a finding,
 *   never an exception that takes the whole census down with it.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { censusArtifact, gazetteerArtifacts } from "@mailwoman/dev-mcp/source-census"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let root: TemporaryDirectory

/**
 * A extract with `spr` and the ancestry tables — the shape a corpus builder can extract triples from.
 */
function writeJoinable(path: string, rows: ReadonlyArray<[string, number]>): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, country TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		CREATE TABLE names (id INTEGER, name TEXT);
	`)

	let id = 1

	for (const [country, n] of rows) {
		for (let i = 0; i < n; i++) {
			db.prepare("INSERT INTO spr (id, parent_id, name, country) VALUES (?, ?, ?, ?)").run(id++, 42, `p${i}`, country)
		}
	}
}

/**
 * `spr` only, and every `parent_id` is the -1 sentinel — countable, not joinable, not walkable.
 */
function writeCountOnly(path: string, country: string, n: number): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, country TEXT)")

	for (let i = 0; i < n; i++) {
		db.prepare("INSERT INTO spr (id, parent_id, name, country) VALUES (?, -1, ?, ?)").run(i + 1, `p${i}`, country)
	}
}

beforeAll(async () => {
	root = await temporaryDirectory("mw-source-census-")
	await makeDirectories(root.resolve("wof"))

	writeJoinable(root.resolve("wof", "postalcode-intl.db"), [
		["FR", 3],
		["DE", 2],
	])

	writeCountOnly(root.resolve("wof", "postalcode-geonames-intl.db"), "PT", 5)
	new DatabaseClient<WOFDatabase>(root.resolve("wof", "postalcode-fr.db")).destroy()
	writeJoinable(root.resolve("wof", "postalcode-us.db.prev"), [["US", 9]])
	await writeLocalTextFile("not a database", root.resolve("wof", "notes.txt"))
})

afterAll(() => root[Symbol.asyncDispose]())

describe("censusArtifact", () => {
	it("reports rows AND what the extract can be joined through", async () => {
		const row = await censusArtifact(root.resolve("wof", "postalcode-intl.db"))

		expect(row.readable).toBe(true)
		expect(row.countries).toEqual({ FR: 3, DE: 2 })
		expect(row.join).toEqual(["ancestry", "names"])
		expect(row.parentLinked).toBe(true)
	})

	it("separates COUNTABLE from JOINABLE — the distinction a row count hides", async () => {
		// 395,544 PT postcodes in a extract with no ancestry table is not 395,544 usable triples. This is the exact
		// shape that made a real config declare PT unbuildable while the rows were sitting there.
		const row = await censusArtifact(root.resolve("wof", "postalcode-geonames-intl.db"))

		expect(row.readable).toBe(true)
		expect(row.countries).toEqual({ PT: 5 })
		expect(row.join).toEqual([])
	})

	it("reports parent_id being the -1 sentinel, which no row count can show", async () => {
		expect((await censusArtifact(root.resolve("wof", "postalcode-geonames-intl.db"))).parentLinked).toBe(false)
	})

	it("reports a country asked for and ABSENT as a zero, not a missing key", async () => {
		// A missing key reads as "not measured". The caller is deciding whether to go and acquire data, and those are
		// opposite conclusions.
		const row = await censusArtifact(root.resolve("wof", "postalcode-intl.db"), ["FR", "VE"])

		expect(row.countries).toEqual({ FR: 3, VE: 0 })
	})

	it("treats a zero-byte extract as a FINDING, not an exception", async () => {
		const row = await censusArtifact(root.resolve("wof", "postalcode-fr.db"))

		expect(row.readable).toBe(false)
		expect(row.reason).toMatch(/zero bytes/)
		expect(row.bytes).toBe(0)
	})

	it("reports a file that is not there rather than throwing", async () => {
		const row = await censusArtifact(root.resolve("wof", "nothing-here.db"))

		expect(row.readable).toBe(false)
		expect(row.reason).toBe("not on disk")
	})
})

describe("gazetteerArtifacts", () => {
	it("lists the .db extracts and skips .prev / .bak siblings", async () => {
		// A `.prev` reports the same country a second time under a name nobody can act on.
		const names = (await gazetteerArtifacts(root.path)).map((path: string) => path.split("/").pop())

		expect(names).toEqual(["postalcode-fr.db", "postalcode-geonames-intl.db", "postalcode-intl.db"])
	})

	it("returns nothing rather than throwing when the data root.path has no wof directory", async () => {
		expect(await gazetteerArtifacts(root.resolve("does-not-exist"))).toEqual([])
	})
})
