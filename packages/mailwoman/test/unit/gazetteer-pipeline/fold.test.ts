/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isWritable } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { foldGeonamesIntoAdmin } from "mailwoman/gazetteer-pipeline"
import type { PathBuilderLike } from "path-ts"
import { afterAll, beforeAll, expect, test } from "vitest"

let root: TemporaryDirectory

beforeAll(async () => {
	root = await temporaryDirectory("fold-geonames-")
})

afterAll(() => root[Symbol.asyncDispose]())

/**
 * The connection closes before the seal: `sealDatabase` opens its own handle to checkpoint the file and
 * refuses while another writer still holds it.
 */
async function buildSealed(
	path: PathBuilderLike,
	populate: (db: DatabaseClient<WOFDatabase>) => void | Promise<void> = () => {}
): Promise<void> {
	{
		using db = new DatabaseClient<WOFDatabase>(path)
		await createUnifiedSchema(db)
		await populate(db)
	}

	await sealDatabase(path)
}

test("foldGeonamesIntoAdmin: a SEALED admin source yields a writable staging copy", async () => {
	// `copyFileSync` stamps the source's read-only mode onto the copy, so without the write-bit restore
	// the fold's first write fails with "attempt to write a readonly database".
	const adminIn = root.path("admin-sealed.db")
	await buildSealed(adminIn)

	const adminOut = root.path("admin-folded.db")
	const emptyDumps = root.path("geonames-empty")
	await makeDirectories(emptyDumps)

	const result = await foldGeonamesIntoAdmin({
		adminIn,
		adminOut,
		countries: [],
		geonamesDir: emptyDumps,
		alternateDir: emptyDumps,
	})

	expect(result.ingested).toBe(0)
	await expect(isWritable(adminOut)).resolves.not.toThrow()
})

test("foldGeonamesIntoAdmin: overwrites a stale prior copy, sealed or not", async () => {
	const adminIn = root.path("admin-sealed-2.db")
	await buildSealed(adminIn)

	// `copyFileSync` writes through an existing destination and keeps its mode, so a stale 0444 copy
	// re-poisons every subsequent fold unless the fold removes it first.
	const adminOut = root.path("admin-folded-2.db")

	{
		using stale = new DatabaseClient<WOFDatabase>(adminOut)
		stale.exec("CREATE TABLE stale_marker (id INTEGER)")
	}

	await sealDatabase(adminOut)

	const emptyDumps = root.path("geonames-empty-2")
	await makeDirectories(emptyDumps)

	await foldGeonamesIntoAdmin({
		adminIn,
		adminOut,
		countries: [],
		geonamesDir: emptyDumps,
		alternateDir: emptyDumps,
	})

	using folded = new DatabaseClient<WOFDatabase>(adminOut, { readOnly: true })
	const marker = folded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stale_marker'").all()

	expect(marker).toHaveLength(0)
})

test("foldGeonamesIntoAdmin: refuses a fold that would drop the source's existing alias coverage", async () => {
	// `buildAdmin` bakes a 161-country fold into every admin artifact and the fold rewrites its whole id
	// range, so folding a narrower list against one deletes the difference.
	const adminIn = root.path("admin-prefolded.db")

	await buildSealed(adminIn, (db) => {
		const insert = db.prepare(
			`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude,
			 max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
			 VALUES (?, -1, ?, 'locality', ?, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)`
		)

		insert.run(9_000_000_000_000, "Gaborone", "BW")
		insert.run(9_000_000_000_001, "Wien", "AT")
	})

	const emptyDumps = root.path("geonames-empty-3")
	await makeDirectories(emptyDumps)

	await expect(
		foldGeonamesIntoAdmin({
			adminIn,
			adminOut: root.path("admin-folded-3.db"),
			countries: ["AT"],
			geonamesDir: emptyDumps,
			alternateDir: emptyDumps,
		})
	).rejects.toThrow(/would DROP .*coverage.*BW/s)
})

test("foldGeonamesIntoAdmin: a country list covering the source's coverage passes the guard", async () => {
	const adminIn = root.path("admin-prefolded-2.db")

	await buildSealed(adminIn, (db) => {
		db.prepare(
			`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude,
			 max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
			 VALUES (?, -1, 'Wien', 'locality', 'AT', 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)`
		).run(9_000_000_000_000)
	})

	const emptyDumps = root.path("geonames-empty-4")
	await makeDirectories(emptyDumps)
	const adminOut = root.path("admin-folded-4.db")

	const result = await foldGeonamesIntoAdmin({
		adminIn,
		adminOut,
		countries: ["AT", "BW"],
		geonamesDir: emptyDumps,
		alternateDir: emptyDumps,
	})

	expect(result.refoldedCountries).toEqual(["AT"])

	// The dumps are absent so both countries skip, yet the pre-existing row is gone because the fold
	// rewrites its range rather than patching it.
	using folded = new DatabaseClient<WOFDatabase>(adminOut, { readOnly: true })
	const left = folded.prepare("SELECT COUNT(*) AS n FROM spr WHERE id >= 9000000000000").get() as { n: number }

	expect(left.n).toBe(0)
})
