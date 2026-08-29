/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `mwdev_sources` — what data we hold, per country, per artifact.
 *
 *   The tests that matter are the ones about ABSENCE, because every one of them corresponds to a wrong conclusion
 *   somebody could draw from a row count: a shard with rows but no join tables reads as usable and is not; a country
 *   asked for and missing must come back as a zero rather than as a missing key; and an unreadable file is a finding,
 *   never an exception that takes the whole census down with it.
 */

import { censusArtifact, gazetteerArtifacts } from "@mailwoman/dev-mcp/source-census"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let root: string

/**
 * A shard with `spr` and the ancestry tables — the shape a corpus builder can extract triples from.
 */
function writeJoinable(path: string, rows: ReadonlyArray<[string, number]>): void {
	const db = new DatabaseClient<WOFDatabase>(path)

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

	db.destroy()
}

/**
 * `spr` only, and every `parent_id` is the -1 sentinel — countable, not joinable, not walkable.
 */
function writeCountOnly(path: string, country: string, n: number): void {
	const db = new DatabaseClient<WOFDatabase>(path)

	db.exec("CREATE TABLE spr (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, country TEXT)")

	for (let i = 0; i < n; i++) {
		db.prepare("INSERT INTO spr (id, parent_id, name, country) VALUES (?, -1, ?, ?)").run(i + 1, `p${i}`, country)
	}

	db.destroy()
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "mw-source-census-"))
	mkdirSync(join(root, "wof"), { recursive: true })

	writeJoinable(join(root, "wof", "postalcode-intl.db"), [
		["FR", 3],
		["DE", 2],
	])

	writeCountOnly(join(root, "wof", "postalcode-geonames-intl.db"), "PT", 5)
	new DatabaseClient<WOFDatabase>(join(root, "wof", "postalcode-fr.db")).destroy()
	writeJoinable(join(root, "wof", "postalcode-us.db.prev"), [["US", 9]])
	writeFileSync(join(root, "wof", "notes.txt"), "not a database")
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

describe("censusArtifact", () => {
	it("reports rows AND what the shard can be joined through", () => {
		const row = censusArtifact(join(root, "wof", "postalcode-intl.db"))

		expect(row.readable).toBe(true)
		expect(row.countries).toEqual({ FR: 3, DE: 2 })
		expect(row.join).toEqual(["ancestry", "names"])
		expect(row.parentLinked).toBe(true)
	})

	it("separates COUNTABLE from JOINABLE — the distinction a row count hides", () => {
		// 395,544 PT postcodes in a shard with no ancestry table is not 395,544 usable triples. This is the exact
		// shape that made a real config declare PT unbuildable while the rows were sitting there.
		const row = censusArtifact(join(root, "wof", "postalcode-geonames-intl.db"))

		expect(row.readable).toBe(true)
		expect(row.countries).toEqual({ PT: 5 })
		expect(row.join).toEqual([])
	})

	it("reports parent_id being the -1 sentinel, which no row count can show", () => {
		expect(censusArtifact(join(root, "wof", "postalcode-geonames-intl.db")).parentLinked).toBe(false)
	})

	it("reports a country asked for and ABSENT as a zero, not a missing key", () => {
		// A missing key reads as "not measured". The caller is deciding whether to go and acquire data, and those are
		// opposite conclusions.
		const row = censusArtifact(join(root, "wof", "postalcode-intl.db"), ["FR", "VE"])

		expect(row.countries).toEqual({ FR: 3, VE: 0 })
	})

	it("treats a zero-byte shard as a FINDING, not an exception", () => {
		const row = censusArtifact(join(root, "wof", "postalcode-fr.db"))

		expect(row.readable).toBe(false)
		expect(row.reason).toMatch(/zero bytes/)
		expect(row.bytes).toBe(0)
	})

	it("reports a file that is not there rather than throwing", () => {
		const row = censusArtifact(join(root, "wof", "nothing-here.db"))

		expect(row.readable).toBe(false)
		expect(row.reason).toBe("not on disk")
	})
})

describe("gazetteerArtifacts", () => {
	it("lists the .db shards and skips .prev / .bak siblings", () => {
		// A `.prev` reports the same country a second time under a name nobody can act on.
		const names = gazetteerArtifacts(root).map((path: string) => path.split("/").pop())

		expect(names).toEqual(["postalcode-fr.db", "postalcode-geonames-intl.db", "postalcode-intl.db"])
	})

	it("returns nothing rather than throwing when the data root has no wof directory", () => {
		expect(gazetteerArtifacts(join(root, "does-not-exist"))).toEqual([])
	})
})
