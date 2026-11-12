// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { DatabaseSync } from "node:sqlite"

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runProcess } from "@mailwoman/core/process"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { openBuiltClient } from "#sealed"
import {
	isSealed,
	recoverInterruptedBuilds,
	SealedArtifactError,
	sealDatabase,
	swapDatabaseIntoPlace,
} from "#sealed/db"

/**
 * The pid of an exited process.
 *
 * A sibling whose file name ends in that pid reads as left by a killed build.
 */
async function exitedPID(): Promise<number> {
	const result = await runProcess(process.execPath, ["-e", "process.stdout.write(String(process.pid))"])

	return Number(result.stdout)
}

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function makeDB(): Promise<PathBuilder> {
	const dir = fixtures.use(await temporaryDirectory("sealed-db-")).path
	const path = dir("artifact.db")
	using db = new DatabaseSync(path.toString())
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
		await expect(isSealed(path)).resolves.toBe(true)
		using db = new DatabaseSync(path.toString(), { readOnly: true })
		expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete")
	})

	it("is idempotent — sealing a sealed artifact leaves it sealed", async () => {
		const path = await makeDB()
		await sealDatabase(path)
		await sealDatabase(path)
		await expect(isSealed(path)).resolves.toBe(true)
	})
})

describe("openBuiltClient", () => {
	it("opens a sealed artifact read-only by default", async () => {
		const path = await makeDB()
		await sealDatabase(path)
		using db = await openBuiltClient(path)
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
		using db = await openBuiltClient(path, { write: true })

		expect(() => db.exec("INSERT INTO t (v) VALUES ('y')")).not.toThrow()
	})
})

describe("swapDatabaseIntoPlace", () => {
	it("replaces the prior version and clears the aside copy", async () => {
		const final = await makeDB()
		const tmp = final.dirname()("replacement.db")
		const db = new DatabaseSync(tmp.toString())
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
		db.exec("INSERT INTO t (v) VALUES ('replacement')")
		db[Symbol.dispose]()

		await swapDatabaseIntoPlace(tmp, final)

		const swapped = new DatabaseSync(final.toString(), { readOnly: true })
		expect((swapped.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("replacement")
		swapped[Symbol.dispose]()
		await expect(pathExists(`${final}.old-${process.pid}`)).resolves.toBe(false)
	})

	it("restores the prior version when the forward rename fails — the slot is never left empty", async () => {
		const final = await makeDB()
		const missingTmp = final.dirname()("never-built.db")

		// A nonexistent tmp makes the forward rename throw after the prior version was
		// moved aside — the exact crash window the restore closes.
		await expect(swapDatabaseIntoPlace(missingTmp, final)).rejects.toThrow(/ENOENT/)

		await expect(pathExists(final)).resolves.toBe(true)
		using restored = new DatabaseSync(final.toString(), { readOnly: true })
		expect((restored.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("x")
	})
})

describe("recoverInterruptedBuilds", () => {
	it("moves a killed build's set-aside version back into an empty slot and removes its other leftovers", async () => {
		const dir = fixtures.use(await temporaryDirectory("sealed-recover-")).path
		const final = dir("artifact.db")
		const dead = await exitedPID()

		await writeLocalTextFile("published", dir(`artifact.db.old-${dead}`))
		await writeLocalTextFile("half-built", dir(`artifact.db.tmp-${dead}`))
		await writeLocalTextFile("journal", dir(`artifact.db.tmp-${dead}-wal`))
		// This process is alive, so its temp file belongs to a build in progress.
		await writeLocalTextFile("building", dir(`artifact.db.tmp-${process.pid}`))

		await recoverInterruptedBuilds(final)

		await expect(readLocalTextFile(final)).resolves.toBe("published")
		await expect(pathExists(dir(`artifact.db.old-${dead}`))).resolves.toBe(false)
		await expect(pathExists(dir(`artifact.db.tmp-${dead}`))).resolves.toBe(false)
		await expect(pathExists(dir(`artifact.db.tmp-${dead}-wal`))).resolves.toBe(false)
		await expect(pathExists(dir(`artifact.db.tmp-${process.pid}`))).resolves.toBe(true)
	})

	it("removes a killed build's set-aside version when the slot already holds an artifact", async () => {
		const dir = fixtures.use(await temporaryDirectory("sealed-recover-")).path
		const final = dir("artifact.db")
		const dead = await exitedPID()

		await writeLocalTextFile("current", final)
		await writeLocalTextFile("older", dir(`artifact.db.old-${dead}`))

		await recoverInterruptedBuilds(final)

		await expect(readLocalTextFile(final)).resolves.toBe("current")
		await expect(pathExists(dir(`artifact.db.old-${dead}`))).resolves.toBe(false)
	})
})
