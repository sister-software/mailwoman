/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression test for #568: a present-but-tableless shard (an interrupted build, or a stray 0-byte
 *   file a `sqlite3 <missing>.db "…"` diagnostic created) must make the street-level lookups a
 *   no-op MISS, not throw `no such table` at construction and take down a whole state's geocode.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite/address-point"
import { AddressPointInterpolator } from "@mailwoman/resolver-wof-sqlite/address-point-interpolation"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import { StreetInterpolator } from "@mailwoman/resolver-wof-sqlite/interpolation"
import type { StreetSegmentDatabase } from "@mailwoman/resolver-wof-sqlite/street-segment-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const query = { street: "Main St", number: "100", postcode: "03301" }

async function tablelessDBFile(): Promise<string> {
	const dir = fixtures.use(await temporaryDirectory("mw-empty-shard-")).path
	const path = join(dir, "empty.db")
	using seed = new DatabaseClient<AddressPointDatabase>(path)
	seed.exec("CREATE TABLE unrelated (x)")

	return path
}

describe("empty/tableless shard degrades gracefully (#568)", () => {
	it("AddressPointSqliteLookup: missing address_point table → constructs, find() returns null", async () => {
		const dbFile = await tablelessDBFile()
		let lookup: AddressPointSqliteLookup | undefined

		expect(() => (lookup = new AddressPointSqliteLookup(dbFile))).not.toThrow()
		expect(lookup!.find(query)).toBeNull()
		lookup![Symbol.dispose]()
	})

	it("StreetInterpolator: missing street_segment table → constructs, find() returns null", () => {
		const db = DatabaseClient.temp<AddressPointDatabase>()
		db.exec("CREATE TABLE unrelated (x)")
		let interp: StreetInterpolator | undefined

		expect(
			() => (interp = new StreetInterpolator({ database: DatabaseClient.temp<StreetSegmentDatabase>() }))
		).not.toThrow()

		expect(interp!.find(query)).toBeNull()
	})

	it("AddressPointInterpolator: missing address_point table → defers to fallback (null with none)", () => {
		const db = DatabaseClient.temp<AddressPointDatabase>()
		db.exec("CREATE TABLE unrelated (x)")
		let interp: AddressPointInterpolator | undefined
		expect(() => (interp = new AddressPointInterpolator({ database: db }))).not.toThrow()
		expect(interp!.find(query)).toBeNull()
	})
})
