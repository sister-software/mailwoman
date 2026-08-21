/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `postcode_locality` shard contract: the shipped column shape (names, order, types, NOT NULL),
 *   the `(postcode, country)` probe index, and the one thing the shared schema exists to prevent —
 *   the builders' positional INSERT drifting out of the DDL's column order.
 *
 *   Every shard the resolver attaches — the polygon build and the three CJK builds — must present
 *   this exact shape, so these assertions are pinned to the values, not derived from the module
 *   under test.
 */

import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import {
	createPostcodeLocalityIndex,
	createPostcodeLocalityMetaTable,
	createPostcodeLocalityTable,
	POSTCODE_LOCALITY_COLUMNS,
	POSTCODE_LOCALITY_INSERT_SQL,
	type PostcodeLocalityDatabase,
	type PostcodeLocalityInsertValues,
} from "mailwoman/gazetteer-pipeline/postcode-locality/schema"
import { describe, expect, it } from "vitest"

interface TableInfoRow {
	cid: number
	name: string
	type: string
	notnull: number
	pk: number
}

/**
 * A fresh in-memory shard with both tables and the index.
 */
async function buildShard(ifNotExists: boolean): Promise<DatabaseSync> {
	const database = new DatabaseSync(":memory:")
	const kdb = new DatabaseClient<PostcodeLocalityDatabase>({ database })

	await createPostcodeLocalityTable(kdb, { ifNotExists })
	await createPostcodeLocalityIndex(kdb, { ifNotExists })
	await createPostcodeLocalityMetaTable(kdb, { ifNotExists })

	return database
}

function tableInfo(db: DatabaseSync, table: string): TableInfoRow[] {
	return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[]
}

describe("createPostcodeLocalityTable", () => {
	it("declares the shipped column shape", async () => {
		const db = await buildShard(false)

		expect(
			tableInfo(db, "postcode_locality").map((c) => ({
				cid: c.cid,
				name: c.name,
				type: c.type.toUpperCase(),
				notnull: c.notnull,
			}))
		).toEqual([
			{ cid: 0, name: "postcode", type: "TEXT", notnull: 1 },
			{ cid: 1, name: "country", type: "TEXT", notnull: 1 },
			{ cid: 2, name: "locality_id", type: "INTEGER", notnull: 1 },
			{ cid: 3, name: "locality_name", type: "TEXT", notnull: 1 },
			// The only nullable column — a `|`-joined alt-name list the CJK builds may have nothing for.
			{ cid: 4, name: "aliases", type: "TEXT", notnull: 0 },
			{ cid: 5, name: "distance_km", type: "REAL", notnull: 1 },
			{ cid: 6, name: "is_containing", type: "INTEGER", notnull: 1 },
		])

		db.close()
	})

	it("declares the meta key/value shape with `key` as the primary key", async () => {
		const db = await buildShard(false)

		expect(tableInfo(db, "meta").map((c) => ({ name: c.name, type: c.type.toUpperCase(), pk: c.pk }))).toEqual([
			{ name: "key", type: "TEXT", pk: 1 },
			{ name: "value", type: "TEXT", pk: 0 },
		])

		db.close()
	})

	it("is re-runnable under `ifNotExists` — the accumulative build fills one shard country by country", async () => {
		const database = new DatabaseSync(":memory:")
		const kdb = new DatabaseClient<PostcodeLocalityDatabase>({ database })

		await createPostcodeLocalityTable(kdb, { ifNotExists: true })
		await createPostcodeLocalityIndex(kdb, { ifNotExists: true })
		await createPostcodeLocalityMetaTable(kdb, { ifNotExists: true })

		await expect(createPostcodeLocalityTable(kdb, { ifNotExists: true })).resolves.toBeUndefined()
		await expect(createPostcodeLocalityIndex(kdb, { ifNotExists: true })).resolves.toBeUndefined()
		await expect(createPostcodeLocalityMetaTable(kdb, { ifNotExists: true })).resolves.toBeUndefined()

		// Without the flag the same statement is an error — that is what makes a rebuild build a rebuild.
		await expect(createPostcodeLocalityTable(kdb, { ifNotExists: false })).rejects.toThrow(/already exists/)

		database.close()
	})
})

describe("createPostcodeLocalityIndex", () => {
	it("creates the non-unique (postcode, country) probe index", async () => {
		const db = await buildShard(false)

		expect(db.prepare("PRAGMA index_list(postcode_locality)").all()).toEqual([
			expect.objectContaining({ name: "postcode_locality_by_pc", unique: 0, partial: 0 }),
		])

		expect(
			(
				db.prepare("PRAGMA index_info(postcode_locality_by_pc)").all() as unknown as Array<{
					seqno: number
					name: string
				}>
			).map((c) => [c.seqno, c.name])
		).toEqual([
			[0, "postcode"],
			[1, "country"],
		])

		db.close()
	})
})

describe("POSTCODE_LOCALITY_INSERT_SQL", () => {
	it("binds in the DDL's column order", async () => {
		const db = await buildShard(false)
		const declared = tableInfo(db, "postcode_locality").map((c) => c.name)

		expect([...POSTCODE_LOCALITY_COLUMNS]).toEqual(declared)

		const named = /INSERT INTO postcode_locality \(([^)]*)\) VALUES \(([^)]*)\)/.exec(POSTCODE_LOCALITY_INSERT_SQL)

		expect(named).not.toBeNull()
		expect(named![1]!.split(",").map((c) => c.trim())).toEqual(declared)
		expect(named![2]!.split(",").map((c) => c.trim())).toEqual(declared.map(() => "?"))

		db.close()
	})

	it("lands each positional value in its own column", async () => {
		const db = await buildShard(false)

		const values: PostcodeLocalityInsertValues = ["10115", "DE", 101_752_063, "Berlin", "Berlin|Berlino", 0, 1]

		db.prepare(POSTCODE_LOCALITY_INSERT_SQL).run(...values)

		expect(db.prepare("SELECT * FROM postcode_locality").get()).toEqual({
			postcode: "10115",
			country: "DE",
			locality_id: 101_752_063,
			locality_name: "Berlin",
			aliases: "Berlin|Berlino",
			distance_km: 0,
			is_containing: 1,
		})

		db.close()
	})

	it("accepts a null alias list", async () => {
		const db = await buildShard(false)

		db.prepare(POSTCODE_LOCALITY_INSERT_SQL).run("10115", "DE", 101_752_063, "Berlin", null, 1.5, 0)

		expect(db.prepare("SELECT aliases, distance_km FROM postcode_locality").get()).toEqual({
			aliases: null,
			distance_km: 1.5,
		})

		db.close()
	})
})
