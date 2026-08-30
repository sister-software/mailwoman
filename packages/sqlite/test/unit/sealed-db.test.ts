/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { dirname, join } from "@mailwoman/platform/path"
import { DatabaseSync } from "@mailwoman/platform/sqlite"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"
import { isSealed, SealedArtifactError, sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function makeDB(): Promise<string> {
	const dir = fixtures.use(await temporaryDirectory("sealed-db-")).path
	const path = join(dir, "artifact.db")
	using db = new DatabaseSync(path)
	db.exec("PRAGMA journal_mode = WAL")
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
	db.exec("INSERT INTO t (v) VALUES ('x')")

	return path
}

describe("sealDatabase", () => {
	it("chmods the file 0444, switches journal_mode to delete, and removes sidecars", async () => {
		const path = await makeDB()
		await sealDatabase(path)
		expect((await statPath(path)).mode & 0o777).toBe(0o444)
		expect(await isSealed(path)).toBe(true)
		using db = new DatabaseSync(path, { readOnly: true })
		expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete")
	})

	it("is idempotent — sealing a sealed artifact leaves it sealed", async () => {
		const path = await makeDB()
		await sealDatabase(path)
		await sealDatabase(path)
		expect(await isSealed(path)).toBe(true)
	})
})

describe("openBuiltClient", () => {
	it("opens a sealed artifact read-only by default", async () => {
		const path = await makeDB()
		await sealDatabase(path)
		await using db = await openBuiltClient(path)
		expect((db.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("x")
	})

	it("throws SealedArtifactError (naming the rebuild command) on a write open of a sealed artifact", async () => {
		const path = await makeDB()
		await sealDatabase(path)
		await expect(openBuiltClient(path, { write: true })).rejects.toThrow(SealedArtifactError)
		await expect(openBuiltClient(path, { write: true })).rejects.toThrow(/sealed read-only artifact/)
		await expect(openBuiltClient(path, { write: true })).rejects.toThrow(/gazetteer build/)
	})

	it("allows a write open of an UNsealed database (builder staging)", async () => {
		const path = await makeDB()
		await using db = await openBuiltClient(path, { write: true })

		expect(() => db.exec("INSERT INTO t (v) VALUES ('y')")).not.toThrow()
	})
})

describe("swapDatabaseIntoPlace", () => {
	it("replaces the prior version and clears the aside copy", async () => {
		const final = await makeDB()
		const tmp = join(dirname(final), "replacement.db")
		const db = new DatabaseSync(tmp)
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
		db.exec("INSERT INTO t (v) VALUES ('replacement')")
		db[Symbol.dispose]()

		await swapDatabaseIntoPlace(tmp, final)

		const swapped = new DatabaseSync(final, { readOnly: true })
		expect((swapped.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("replacement")
		swapped[Symbol.dispose]()
		expect(await pathExists(`${final}.old-${process.pid}`)).toBe(false)
	})

	it("restores the prior version when the forward rename fails — the slot is never left empty", async () => {
		const final = await makeDB()
		const missingTmp = join(dirname(final), "never-built.db")

		// A nonexistent tmp makes the forward rename throw AFTER the prior version was moved aside —
		// the exact crash window the restore closes.
		await expect(swapDatabaseIntoPlace(missingTmp, final)).rejects.toThrow(/ENOENT/)

		expect(await pathExists(final)).toBe(true)
		using restored = new DatabaseSync(final, { readOnly: true })
		expect((restored.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("x")
	})
})
