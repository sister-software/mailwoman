// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The candidate build reads the importance build stamped with its own admin database's md5,
 *   and refuses every other importance file by name.
 *
 *   The defect this guards: with `--importance` left off, the candidate build read an undated
 *   default file built from an older admin database, and its manifest said only `importance=yes`.
 */

import { gzip } from "@mailwoman/core/fs/compression"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode, copyFileTo, writeLocalFile } from "@mailwoman/core/fs/writers"
import { md5File } from "@mailwoman/core/hash"
import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import {
	importanceDatabasePath,
	readImportanceSource,
	resolveImportanceForAdmin,
	resolveImportanceOrRefusal,
} from "@mailwoman/resolver-wof-sqlite/schema/importance-source"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { isSealed } from "@mailwoman/sqlite/sealed/db"
import type { PathBuilder } from "path-ts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { buildCandidate } from "#tools/pipeline"
import { buildImportance, type BuildImportanceResult } from "#tools/pipeline/importance"

let root: TemporaryDirectory
let adminA: PathBuilder
let adminB: PathBuilder
let built: BuildImportanceResult

/**
 * A two-place admin database; `population` varies the bytes so two fixtures differ in md5.
 */
function writeAdmin(path: PathBuilder, population: number): void {
	using db = new DatabaseClient<Record<string, never>>(path)

	db.exec(
		"CREATE TABLE spr (id INTEGER PRIMARY KEY, placetype TEXT, latitude REAL, longitude REAL, is_current INTEGER)"
	)

	db.exec("CREATE TABLE concordances (id INTEGER, other_source TEXT, other_id TEXT)")
	db.exec("CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER)")
	db.exec("INSERT INTO spr VALUES (1, 'locality', 42.5, 1.5, 1), (2, 'locality', 12.05, -61.75, 1)")
	db.exec("INSERT INTO concordances VALUES (1, 'wd:id', 'Q1863'), (2, 'wd:id', 'Q41474')")
	db.prepare("INSERT INTO place_population VALUES (1, ?), (2, ?)").run(population, population)
}

beforeAll(async () => {
	root = await temporaryDirectory("importance-source-")
	adminA = root.path("admin-a.db")
	adminB = root.path("admin-b.db")

	writeAdmin(adminA, 22_000)
	writeAdmin(adminB, 33_000)

	const tsv = root.path("wikimedia-importance.csv.gz")

	await writeLocalFile(
		await gzip("language\ttype\ttitle\timportance\twikidata_id\nen\ta\tAndorra la Vella\t0.56\tQ1863\n"),
		tsv
	)

	built = await buildImportance({ adminDB: adminA, tsv })
})

afterAll(() => root[Symbol.asyncDispose]())

describe("buildImportance", () => {
	test("writes a sealed copy beside the admin database, named for and stamped with its md5", async () => {
		const md5 = await md5File(adminA)

		expect(built.out).toBe(importanceDatabasePath(adminA, md5))
		await expect(isSealed(built.out)).resolves.toBe(true)
		await expect(readImportanceSource(built.out)).resolves.toMatchObject({ path: adminA.toString(), md5 })
		expect(built.total).toBe(2)
	})

	test("an Overture division sharing a WOF record's Wikidata id leaves the record its score", async () => {
		// Andorra la Vella as WOF holds it, with no population, and a division 600
		// km away claiming the same id with one.
		// One fan-out group over both keeps only the division, by population.
		// Each part resolves its own group, so the record keeps its score.
		const admin = root.path("admin-overture.db")
		const division = OVERTURE_ID_BASE + 1

		writeAdmin(admin, 0)

		{
			using db = new DatabaseClient<Record<string, never>>(admin)

			db.prepare("INSERT INTO spr VALUES (?, 'locality', 47.9, 1.9, 1)").run(division)
			db.prepare("INSERT INTO concordances VALUES (?, 'wd:id', 'Q1863')").run(division)
			db.prepare("INSERT INTO place_population VALUES (?, 22000)").run(division)
		}

		const result = await buildImportance({ adminDB: admin, tsv: root.path("wikimedia-importance.csv.gz") })

		using db = new DatabaseClient<Record<string, never>>(result.out, { readOnly: true })

		expect(
			db.prepare("SELECT id, encyclopedic FROM place_importance WHERE id IN (1, ?) ORDER BY id").all(division)
		).toEqual([
			{ id: 1, encyclopedic: 0.56 },
			{ id: division, encyclopedic: 0.56 },
		])
	})
})

describe("resolveImportanceForAdmin", () => {
	test("finds the importance build for the admin database from the admin database alone", async () => {
		await expect(resolveImportanceForAdmin(adminA)).resolves.toEqual({
			path: built.out,
			md5: await md5File(built.out),
		})
	})

	test("refuses an admin database with no importance build, naming both files", async () => {
		const expected = importanceDatabasePath(adminB, await md5File(adminB))

		await expect(resolveImportanceForAdmin(adminB)).rejects.toThrow(
			`no importance build for admin ${adminB.toString()}`
		)

		await expect(resolveImportanceForAdmin(adminB)).rejects.toThrow(`${expected} does not exist`)
	})

	test("a report reader receives the refusal with both paths instead of an empty result", async () => {
		const refused = await resolveImportanceOrRefusal(adminB)

		expect(refused.path).toBeNull()
		expect(refused.refusal).toContain(`no importance build for admin ${adminB.toString()}`)
		await expect(resolveImportanceOrRefusal(adminA)).resolves.toMatchObject({ path: built.out, refusal: null })
	})

	test("refuses an importance build stamped with another admin database, naming both", async () => {
		await expect(resolveImportanceForAdmin(adminB, built.out)).rejects.toThrow(
			new RegExp(`built from admin ${RegExp.escape(adminA.toString())} .*not admin ${RegExp.escape(adminB.toString())}`)
		)
	})

	test("refuses an importance file that records no admin database", async () => {
		const unstamped = root.path("admin-global-priority-importance.db")

		await copyFileTo(adminA, unstamped)
		await changeMode(unstamped, 0o644)

		{
			using db = new DatabaseClient<Record<string, never>>(unstamped)

			db.exec(
				"CREATE TABLE place_importance (id INTEGER PRIMARY KEY, referential REAL, encyclopedic REAL, importance REAL)"
			)
		}

		await expect(resolveImportanceForAdmin(adminA, unstamped)).rejects.toThrow(
			`importance ${unstamped.toString()} records no admin database`
		)
	})
})

test("buildCandidate refuses to build without the importance build for its admin database", async () => {
	const out = root.path("candidate.db")

	await expect(buildCandidate({ adminDB: adminB, out, postcodeDatabases: [], localityDatabases: [] })).rejects.toThrow(
		`no importance build for admin ${adminB.toString()}`
	)
})
