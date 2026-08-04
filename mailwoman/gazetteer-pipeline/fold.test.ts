/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { sealDatabase } from "@mailwoman/core/utils"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { afterAll, beforeAll, expect, test } from "vitest"

import { foldGeonamesIntoAdmin } from "./index.ts"

let root: string

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "fold-geonames-"))
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

test("foldGeonamesIntoAdmin: a SEALED admin source yields a writable staging copy", async () => {
	// The live admin artifact is sealed 0444 (sealDatabase is every builder's last step). copyFileSync
	// stamps the source mode onto the copy, so without the write-bit restore the fold's first write
	// dies with "attempt to write a readonly database" — exactly how the 2026-08-04 candidate rebuild
	// failed against the freshly-sealed admin DB.
	const adminIn = join(root, "admin-sealed.db")
	const db = new DatabaseSync(adminIn)
	await createUnifiedSchema(db)
	db.close()
	sealDatabase(adminIn)

	const adminOut = join(root, "admin-folded.db")
	const emptyDumps = join(root, "geonames-empty")
	mkdirSync(emptyDumps, { recursive: true })

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
	const adminIn = join(root, "admin-sealed-2.db")
	const db = new DatabaseSync(adminIn)
	await createUnifiedSchema(db)
	db.close()
	sealDatabase(adminIn)

	// A prior fold output at the destination — itself sealed, the worst case: copyFileSync writes
	// THROUGH an existing destination and keeps its mode, so a stale 0444 copy re-poisons every
	// subsequent fold unless the fold removes it first.
	const adminOut = join(root, "admin-folded-2.db")
	const stale = new DatabaseSync(adminOut)
	stale.exec("CREATE TABLE stale_marker (id INTEGER)")
	stale.close()
	sealDatabase(adminOut)

	const emptyDumps = join(root, "geonames-empty-2")
	mkdirSync(emptyDumps, { recursive: true })

	await foldGeonamesIntoAdmin({
		adminIn,
		adminOut,
		countries: [],
		geonamesDir: emptyDumps,
		alternateDir: emptyDumps,
	})

	const folded = new DatabaseSync(adminOut, { readOnly: true })
	const marker = folded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stale_marker'").all()
	folded.close()

	expect(marker).toHaveLength(0)
})
