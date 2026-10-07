/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * A present-but-tableless extract must make the street-level lookups a no-op miss.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { AddressPointSqliteLookup, AddressPointInterpolator } from "#address"
import type { AddressPointDatabase } from "#address"
import { StreetInterpolator } from "#interpolation"
import type { StreetSegmentDatabase } from "#street"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const query = { street: "Main St", number: "100", postcode: "03301" }

async function tablelessDBFile(): Promise<PathBuilder> {
	const dir = fixtures.use(await temporaryDirectory("mw-empty-extract-")).path
	const path = dir("empty.db")
	using seed = new DatabaseClient<AddressPointDatabase>(path)
	seed.exec("CREATE TABLE unrelated (x)")

	return path
}

describe("empty/tableless extract degrades gracefully (#568)", () => {
	it("AddressPointSqliteLookup: missing address_point table → constructs, find() returns null", async () => {
		const dbFile = await tablelessDBFile()
		let lookup: AddressPointSqliteLookup | null = null

		expect(() => (lookup = new AddressPointSqliteLookup(dbFile))).not.toThrow()
		expect(lookup!.find(query)).toBeNull()
		lookup![Symbol.dispose]()
	})

	it("StreetInterpolator: missing street_segment table → constructs, find() returns null", () => {
		const db = DatabaseClient.temp<AddressPointDatabase>()
		db.exec("CREATE TABLE unrelated (x)")
		let interp: StreetInterpolator | null = null

		expect(
			() => (interp = new StreetInterpolator({ database: DatabaseClient.temp<StreetSegmentDatabase>() }))
		).not.toThrow()

		expect(interp!.find(query)).toBeNull()
	})

	it("AddressPointInterpolator: missing address_point table → defers to fallback (null with none)", () => {
		const db = DatabaseClient.temp<AddressPointDatabase>()
		db.exec("CREATE TABLE unrelated (x)")
		let interp: AddressPointInterpolator | null = null
		expect(() => (interp = new AddressPointInterpolator({ database: db }))).not.toThrow()
		expect(interp!.find(query)).toBeNull()
	})
})
