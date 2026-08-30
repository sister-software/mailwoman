/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { accessSync, constants } from "@mailwoman/platform/fs"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { foldGeonamesIntoAdmin } from "mailwoman/gazetteer-pipeline"
import { afterAll, beforeAll, expect, test } from "vitest"

let root: TemporaryDirectory

beforeAll(async () => {
	root = await temporaryDirectory("fold-geonames-")
})

afterAll(() => root[Symbol.asyncDispose]())

/**
 * Build a fixture database at `path` and seal it.
 *
 * The connection closes before the seal: `sealDatabase` opens its own handle to checkpoint the file and switch its
 * journal mode, and refuses while another writer still holds it.
 */
async function buildSealed(
	path: string,
	populate: (db: DatabaseClient<WOFDatabase>) => void | Promise<void> = () => {}
): Promise<void> {
	{
		using db = new DatabaseClient<WOFDatabase>(path)
		await createUnifiedSchema(db)
		await populate(db)
	}

	sealDatabase(path)
}

test("foldGeonamesIntoAdmin: a SEALED admin source yields a writable staging copy", async () => {
	// The live admin artifact is sealed 0444 (sealDatabase is every builder's last step). copyFileSync
	// stamps the source mode onto the copy, so without the write-bit restore the fold's first write
	// dies with "attempt to write a readonly database" — exactly how the 2026-08-04 candidate rebuild
	// failed against the freshly-sealed admin DB.
	const adminIn = root.resolve("admin-sealed.db")
	await buildSealed(adminIn)

	const adminOut = root.resolve("admin-folded.db")
	const emptyDumps = root.resolve("geonames-empty")
	await makeDirectories(emptyDumps)

	// Zero countries: no dump files needed — the place_search rebuild alone exercises the write path.
	const result = await foldGeonamesIntoAdmin({
		adminIn,
		adminOut,
		countries: [],
		geonamesDir: emptyDumps,
		alternateDir: emptyDumps,
	})

	expect(result.ingested).toBe(0)
	// The staging copy must carry the write bit even though the source is sealed.
	expect(() => accessSync(adminOut, constants.W_OK)).not.toThrow()
})

test("foldGeonamesIntoAdmin: overwrites a stale prior copy, sealed or not", async () => {
	const adminIn = root.resolve("admin-sealed-2.db")
	await buildSealed(adminIn)

	// A prior fold output at the destination — itself sealed, the worst case: copyFileSync writes
	// THROUGH an existing destination and keeps its mode, so a stale 0444 copy re-poisons every
	// subsequent fold unless the fold removes it first.
	const adminOut = root.resolve("admin-folded-2.db")

	{
		using stale = new DatabaseClient<WOFDatabase>(adminOut)
		stale.exec("CREATE TABLE stale_marker (id INTEGER)")
	}

	sealDatabase(adminOut)

	const emptyDumps = root.resolve("geonames-empty-2")
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
	// #1514. `buildAdmin` bakes a 161-country fold into every admin artifact, and the fold rewrites its
	// whole id range — so folding a NARROWER list against one deletes the difference. The 2026-08-05
	// build did exactly that with the old 14-country default and nothing said a word.
	const adminIn = root.resolve("admin-prefolded.db")

	await buildSealed(adminIn, (db) => {
		const insert = db.prepare(
			`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude,
			 max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
			 VALUES (?, -1, ?, 'locality', ?, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)`
		)

		insert.run(9_000_000_000_000, "Gaborone", "BW")
		insert.run(9_000_000_000_001, "Wien", "AT")
	})

	const emptyDumps = root.resolve("geonames-empty-3")
	await makeDirectories(emptyDumps)

	await expect(
		foldGeonamesIntoAdmin({
			adminIn,
			adminOut: root.resolve("admin-folded-3.db"),
			countries: ["AT"],
			geonamesDir: emptyDumps,
			alternateDir: emptyDumps,
		})
	).rejects.toThrow(/would DROP .*coverage.*BW/s)
})

test("foldGeonamesIntoAdmin: a country list covering the source's coverage passes the guard", async () => {
	const adminIn = root.resolve("admin-prefolded-2.db")

	await buildSealed(adminIn, (db) => {
		db.prepare(
			`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude,
			 max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
			 VALUES (?, -1, 'Wien', 'locality', 'AT', 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0)`
		).run(9_000_000_000_000)
	})

	const emptyDumps = root.resolve("geonames-empty-4")
	await makeDirectories(emptyDumps)
	const adminOut = root.resolve("admin-folded-4.db")

	const result = await foldGeonamesIntoAdmin({
		adminIn,
		adminOut,
		countries: ["AT", "BW"],
		geonamesDir: emptyDumps,
		alternateDir: emptyDumps,
	})

	expect(result.refoldedCountries).toEqual(["AT"])

	// The dumps are absent, so both countries skip — and the pre-existing row is gone anyway, because the
	// fold rewrites its range rather than patching it. A silent survivor is what bound Gaborone's names
	// to an Austrian village.
	using folded = new DatabaseClient<WOFDatabase>(adminOut, { readOnly: true })
	const left = folded.prepare("SELECT COUNT(*) AS n FROM spr WHERE id >= 9000000000000").get() as { n: number }

	expect(left.n).toBe(0)
})
