/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression guard for the OPEN MODE `WOFSqlitePlaceLookup` chooses on the `databasePath` branch: read-only by
 *   default (every serve/query path), read-write ONLY when `buildFTS` is requested (the FTS5 index build — the sole
 *   writer). Shipped shards are sealed 0444 and Docker `:ro` mounts forbid write-mode opens (#1213).
 *
 *   Why this needs a construction spy rather than a plain 0444 open: SQLite silently DOWNGRADES a write-mode open to
 *   read-only on an owned read-only file, so a 0444 open succeeds under the old `readOnly: false` too and cannot
 *   distinguish old code from new. Recording the `readOnly` option actually passed to `DatabaseSync` is the reliable
 *   signal. (`lookup.test.ts` keeps an end-to-end 0444 smoke test proving a sealed file resolves; this file proves the
 *   invariant.)
 */

import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

// Record every DatabaseSync construction (path + the readOnly option) while delegating to the real implementation.
const spy = vi.hoisted(() => ({ opens: [] as Array<{ path: string; readOnly: boolean | undefined }> }))

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>()

	class RecordingDatabaseSync extends actual.DatabaseSync {
		constructor(path: string, options?: { readOnly?: boolean }) {
			spy.opens.push({ path, readOnly: options?.readOnly })

			// node:sqlite rejects an explicit `undefined` options arg — forward only when actually passed.
			if (options === undefined) {
				super(path)
			} else {
				super(path, options)
			}
		}
	}

	return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

import { DatabaseSync } from "node:sqlite"

import { WOFSqlitePlaceLookup } from "./lookup.ts"

/** Seed a minimal on-disk WOF fixture (schema + one place), WITHOUT the FTS index. Writable. */
function seedFixture(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER NOT NULL, language TEXT, name TEXT NOT NULL);
	`)
	db.prepare(
		`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated)
		 VALUES (?, ?, ?, ?, ?, ?, ?, -1, 0)`
	).run(101715829, 85688489, "Paris", "locality", "US", 33.66, -95.55)
	db.prepare(`INSERT INTO names (id, language, name) VALUES (?, ?, ?)`).run(101715829, "und", "Paris")
	db.close()
}

/** The readOnly option recorded for the main-shard open of `path` (asserts exactly one such open). */
function readOnlyForOpenOf(path: string): boolean | undefined {
	const opens = spy.opens.filter((o) => o.path === path)
	expect(opens.length).toBe(1)

	return opens[0]!.readOnly
}

describe("WOFSqlitePlaceLookup open mode (databasePath branch)", () => {
	let dir: string
	let dbPath: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mw-wof-openmode-"))
		dbPath = join(dir, "admin-fixture.db")
		seedFixture(dbPath)
	})

	afterEach(() => {
		// Restore write permission (a test may have sealed the file) so the temp dir can be removed.
		try {
			chmodSync(dbPath, 0o644)
		} catch {
			/* already gone */
		}
		rmSync(dir, { recursive: true, force: true })
		spy.opens.length = 0
	})

	test("buildFTS: true opens the main shard READ-WRITE (the FTS5 index build must write)", () => {
		spy.opens.length = 0
		const lookup = new WOFSqlitePlaceLookup({ databasePath: dbPath, buildFTS: true })

		try {
			expect(readOnlyForOpenOf(dbPath)).toBe(false)
		} finally {
			lookup.close()
		}
	})

	test("buildFTS omitted opens the main shard READ-ONLY, even against a sealed 0444 file, and still queries", async () => {
		// Build the FTS index first (read-write), then seal the file 0444 to mimic a shipped shard.
		new WOFSqlitePlaceLookup({ databasePath: dbPath, buildFTS: true }).close()
		chmodSync(dbPath, 0o444)

		spy.opens.length = 0
		const lookup = new WOFSqlitePlaceLookup({ databasePath: dbPath })

		try {
			// The distinguishing signal: the construction chose readOnly:true (a write-mode open would fail on a
			// genuine `:ro` mount even though SQLite downgrades it on an owned 0444 file).
			expect(readOnlyForOpenOf(dbPath)).toBe(true)

			const candidates = await lookup.findPlace({ text: "Paris", country: "US" })
			expect(candidates.length).toBeGreaterThan(0)
			expect(candidates[0]).toMatchObject({ name: "Paris", country: "US", placetype: "locality" })
		} finally {
			lookup.close()
		}
	})
})
