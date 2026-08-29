/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression test for #568: a present-but-tableless shard (an interrupted build, or a stray 0-byte
 *   file a `sqlite3 <missing>.db "…"` diagnostic created) must make the street-level lookups a
 *   no-op MISS, not throw `no such table` at construction and take down a whole state's geocode.
 */

import { mkdtempSync, rmSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { AddressPointSqliteLookup } from "@mailwoman/resolver-wof-sqlite/address-point"
import { AddressPointInterpolator } from "@mailwoman/resolver-wof-sqlite/address-point-interpolation"
import type { AddressPointDatabase } from "@mailwoman/resolver-wof-sqlite/address-point-schema"
import { StreetInterpolator } from "@mailwoman/resolver-wof-sqlite/interpolation"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { StreetSegmentDatabase } from "@mailwoman/resolver-wof-sqlite/street-segment-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, describe, expect, it } from "vitest"

const query = { street: "Main St", number: "100", postcode: "03301" }
const dirs: string[] = []

function tablelessDBFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "mw-empty-shard-"))
	dirs.push(dir)
	const path = join(dir, "empty.db")
	using seed = new DatabaseClient<AddressPointDatabase>(path)
	seed.exec("CREATE TABLE unrelated (x)")

	return path
}

afterAll(() => {
	for (const d of dirs) {
		rmSync(d, { recursive: true, force: true })
	}
})

describe("empty/tableless shard degrades gracefully (#568)", () => {
	it("AddressPointSqliteLookup: missing address_point table → constructs, find() returns null", () => {
		let lookup: AddressPointSqliteLookup | undefined
		expect(() => (lookup = new AddressPointSqliteLookup(tablelessDBFile()))).not.toThrow()
		expect(lookup!.find(query)).toBeNull()
		lookup!.close()
	})

	it("StreetInterpolator: missing street_segment table → constructs, find() returns null", () => {
		const db = new DatabaseClient<AddressPointDatabase>(":memory:")
		db.exec("CREATE TABLE unrelated (x)")
		let interp: StreetInterpolator | undefined

		expect(
			() => (interp = new StreetInterpolator({ database: new DatabaseClient<StreetSegmentDatabase>(":memory:") }))
		).not.toThrow()

		expect(interp!.find(query)).toBeNull()
	})

	it("AddressPointInterpolator: missing address_point table → defers to fallback (null with none)", () => {
		const db = new DatabaseClient<AddressPointDatabase>(":memory:")
		db.exec("CREATE TABLE unrelated (x)")
		let interp: AddressPointInterpolator | undefined
		expect(() => (interp = new AddressPointInterpolator({ database: db }))).not.toThrow()
		expect(interp!.find(query)).toBeNull()
	})
})
