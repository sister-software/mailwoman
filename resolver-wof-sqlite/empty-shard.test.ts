/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression test for #568: a present-but-tableless shard (an interrupted build, or a stray 0-byte
 *   file a `sqlite3 <missing>.db "…"` diagnostic created) must make the street-level lookups a
 *   no-op MISS, not throw `no such table` at construction and take down a whole state's geocode.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, describe, expect, it } from "vitest"

import { AddressPointInterpolator } from "./address-point-interpolation.js"
import { AddressPointSqliteLookup } from "./address-point.js"
import { StreetInterpolator } from "./interpolation.js"

const query = { street: "Main St", number: "100", postcode: "03301" }
const dirs: string[] = []

function tablelessDbFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "mw-empty-shard-"))
	dirs.push(dir)
	const path = join(dir, "empty.db")
	const seed = new DatabaseSync(path)
	seed.exec("CREATE TABLE unrelated (x)") // a valid db file, but no address_point / street_segment table
	seed.close()
	return path
}

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe("empty/tableless shard degrades gracefully (#568)", () => {
	it("AddressPointSqliteLookup: missing address_point table → constructs, find() returns null", () => {
		let lookup: AddressPointSqliteLookup | undefined
		expect(() => (lookup = new AddressPointSqliteLookup(tablelessDbFile()))).not.toThrow()
		expect(lookup!.find(query)).toBeNull()
		lookup!.close()
	})

	it("StreetInterpolator: missing street_segment table → constructs, find() returns null", () => {
		const db = new DatabaseSync(":memory:")
		db.exec("CREATE TABLE unrelated (x)")
		let interp: StreetInterpolator | undefined
		expect(() => (interp = new StreetInterpolator({ database: db }))).not.toThrow()
		expect(interp!.find(query)).toBeNull()
	})

	it("AddressPointInterpolator: missing address_point table → defers to fallback (null with none)", () => {
		const db = new DatabaseSync(":memory:")
		db.exec("CREATE TABLE unrelated (x)")
		let interp: AddressPointInterpolator | undefined
		expect(() => (interp = new AddressPointInterpolator({ database: db }))).not.toThrow()
		expect(interp!.find(query)).toBeNull()
	})
})
