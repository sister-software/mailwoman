/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { isSealed, openBuiltDatabase, SealedArtifactError, sealDatabase } from "./sealed-db.ts"

function makeDB(): string {
	const dir = mkdtempSync(join(tmpdir(), "sealed-db-"))
	const path = join(dir, "artifact.db")
	const db = new DatabaseSync(path)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
	db.exec("INSERT INTO t (v) VALUES ('x')")
	db.close()

	return path
}

describe("sealDatabase", () => {
	it("chmods the file 0444, switches journal_mode to delete, and removes sidecars", () => {
		const path = makeDB()
		sealDatabase(path)
		expect(statSync(path).mode & 0o777).toBe(0o444)
		expect(isSealed(path)).toBe(true)
		const db = new DatabaseSync(path, { readOnly: true })
		expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete")
		db.close()
	})

	it("is idempotent — sealing a sealed artifact leaves it sealed", () => {
		const path = makeDB()
		sealDatabase(path)
		sealDatabase(path)
		expect(isSealed(path)).toBe(true)
	})
})

describe("openBuiltDatabase", () => {
	it("opens a sealed artifact read-only by default", () => {
		const path = makeDB()
		sealDatabase(path)
		const db = openBuiltDatabase(path)
		expect((db.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("x")
		db.close()
	})

	it("throws SealedArtifactError (naming the rebuild command) on a write open of a sealed artifact", () => {
		const path = makeDB()
		sealDatabase(path)
		expect(() => openBuiltDatabase(path, { write: true })).toThrowError(SealedArtifactError)
		expect(() => openBuiltDatabase(path, { write: true })).toThrowError(/sealed read-only artifact/)
		expect(() => openBuiltDatabase(path, { write: true })).toThrowError(/gazetteer build/)
	})

	it("allows a write open of an UNsealed database (builder staging)", () => {
		const path = makeDB()
		const db = openBuiltDatabase(path, { write: true })
		db.exec("INSERT INTO t (v) VALUES ('y')")
		db.close()
	})
})
