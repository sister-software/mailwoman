/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DE fragment board's classes, its state exclusion and per-class surface dedupe, and the Unicode word
 *   boundaries its patterns read as Python's `re` reads them.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import {
	buildDEFragmentBoard,
	foldBoardWords,
	housenumberClass,
	normalizeBoardSurface,
	streetClass,
} from "#de/fragment-board"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"

const LEXICON = new Set(["berlin", "bad homburg"])

describe("streetClass", () => {
	it("checks date, then particle, then lexicon homonym, then bare street", () => {
		expect(streetClass("Straße des 17. Juni", LEXICON)).toBe("date-name")
		expect(streetClass("Am 3. Oktober", LEXICON)).toBe("date-name")
		expect(streetClass("An der Alster", LEXICON)).toBe("street-particle")
		expect(streetClass("Bad Homburger Weg", LEXICON)).toBe("bare-street")
		expect(streetClass("Alte Bad Homburg Straße", LEXICON)).toBe("admin-street-homonym")
		expect(streetClass("Hauptstraße", LEXICON)).toBe("bare-street")
	})

	it("reads a word boundary as Python does, so a letter before `straße` is no boundary", () => {
		expect(streetClass("Großstraße des 1", LEXICON)).toBe("bare-street")
		expect(streetClass("Alte Straße des 1", LEXICON)).toBe("date-name")
		expect(streetClass("Ö17. Juni", LEXICON)).toBe("bare-street")
	})

	it("classes a house number with letters or a range as alphanumeric", () => {
		expect(housenumberClass("12a")).toBe("alnum-housenumber")
		expect(housenumberClass("3-5")).toBe("alnum-housenumber")
		expect(housenumberClass("12")).toBe("street-housenumber")
	})
})

describe("normalizeBoardSurface", () => {
	it("folds edge punctuation and case, word by word", () => {
		expect(foldBoardWords("(Am) Markt, 3.")).toEqual(["am", "markt", "3"])
		expect(normalizeBoardSurface("  Straße  des 17. Juni ")).toBe("straße des 17 juni")
	})
})

const sql = (value: string | null) => (value === null ? "NULL" : `'${escapeSQLString(value)}'`)

describe("buildDEFragmentBoard", () => {
	it("leaves out Berlin and Saxony, keeps one row per class surface, and writes the reserved surfaces", async () => {
		await using scratch = await temporaryDirectory("mailwoman-de-board-")
		const parquet = scratch.path("addresses-de.parquet").toString()
		const lexicon = scratch.path("lexicon.json").toString()
		const out = scratch.path("board", "overture-fragments-de.jsonl").toString()

		const rows: [string, string, string | null, string | null][] = [
			["BY", "München", "An der Isar", "4"],
			["BY", "München", "An der Isar", "4"],
			["BE", "Berlin", "Unter den Linden", "1"],
			["SN", "Dresden", "Prager Straße", "2a"],
			["HE", "Frankfurt", "Bad Homburger Weg", null],
			["HE", "Frankfurt", "Straße des 17. Juni", "12a"],
		]

		using db = await openDuckDB()

		await db.run("CREATE TABLE source (street VARCHAR, number VARCHAR, address_levels STRUCT(value VARCHAR)[])")

		await db.run(
			`INSERT INTO source VALUES ${rows
				.map(
					([state, muni, street, number]) =>
						`(${sql(street)}, ${sql(number)}, [{'value': ${sql(state)}}, {'value': ${sql(muni)}}])`
				)
				.join(", ")}`
		)

		await db.run(`COPY source TO ${sql(parquet)} (FORMAT parquet)`)
		await writeLocalTextFile(stringifyJSON({ entries: { berlin: {}, frankfurt: {} } }), lexicon)

		const counts = await buildDEFragmentBoard({ parquet, lexicon, out, perClass: 5, seed: 42 })
		const board = await Array.fromAsync(JSONSpliterator.fromAsync<{ klass: string; input: string; id: string }>(out))

		expect(board.map((row) => [row.klass, row.input])).toEqual([
			["alnum-housenumber", "Straße des 17. Juni 12a"],
			["bare-locality", "München"],
			["bare-locality", "Frankfurt"],
			["bare-street", "Bad Homburger Weg"],
			["date-name", "Straße des 17. Juni"],
			["street-housenumber", "An der Isar 4"],
			["street-particle", "An der Isar"],
		])

		expect(board[1]!.id).toBe("ovt-de-bare-locality-00000")
		expect(counts.get("admin-street-homonym")).toBe(0)

		await expect(readLocalTextFile(scratch.path("board", "overture-fragments-de.surfaces.txt"))).resolves.toBe(
			"an der isar\nbad homburger weg\nfrankfurt\nmünchen\nstraße des 17 juni\n"
		)
	})

	it("refuses a missing parquet file, naming its path", async () => {
		await using scratch = await temporaryDirectory("mailwoman-de-board-")
		const parquet = scratch.path("absent.parquet").toString()

		await expect(
			buildDEFragmentBoard({ parquet, lexicon: "x", out: scratch.path("out.jsonl").toString(), perClass: 1, seed: 1 })
		).rejects.toThrow(parquet)
	})
})
