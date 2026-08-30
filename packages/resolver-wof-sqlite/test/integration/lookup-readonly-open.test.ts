/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression guard for the OPEN MODE `WOFSQLitePlaceLookup` chooses on the `databasePath` branch: read-only by
 *   default (every serve/query path), read-write ONLY when `buildFTS` is requested (the FTS5 index build — the sole
 *   writer). Shipped shards are sealed 0444 and Docker `:ro` mounts forbid write-mode opens (#1213).
 *
 *   Why this needs a construction spy rather than a plain 0444 open: SQLite silently DOWNGRADES a write-mode open to
 *   read-only on an owned read-only file, so a 0444 open succeeds under the old `readOnly: false` too and cannot
 *   distinguish old code from new. Recording the `readOnly` option actually passed to `DatabaseSync` is the reliable
 *   signal. (`lookup.test.ts` keeps an end-to-end 0444 smoke test proving a sealed file resolves; this file proves the
 *   invariant.)
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode } from "@mailwoman/core/fs/writers"
import { join } from "@mailwoman/platform/path"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

// Record every DatabaseSync construction (path + the readOnly option) while delegating to the real implementation.
const spy = vi.hoisted(() => ({ opens: [] as Array<{ path: string; readOnly: boolean | undefined }> }))

vi.mock("@mailwoman/platform/sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mailwoman/platform/sqlite")>()

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

// vi.resetModules() BEFORE importing the module under test: the root vitest config runs
// `isolate: false` (one shared module graph per worker), so `node:sqlite` / `./lookup.ts` may
// already sit in the shared cache — evaluated with the REAL DatabaseSync by an earlier file. A
// cached module is never re-evaluated, so this file's vi.mock factory would never run and the
// construction spy would stay empty (the failure this guards against reads as "expected [] to
// have a length of 1"). Reset on the way in so the chain re-evaluates against the mock, and on the
// way out so the NEXT file in this fork never inherits our RecordingDatabaseSync from the cache.
vi.resetModules()
afterAll(() => vi.resetModules())

// Dynamic imports AFTER the reset (and after the hoisted vi.mock registration above) so the
// module-under-test chain evaluates against the RecordingDatabaseSync mock.
// oxlint-disable-next-line no-restricted-imports -- this probe RECORDS the construction, so it must name the builtin
const { DatabaseSync } = await import("@mailwoman/platform/sqlite")
const { WOFSQLitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite/lookup")

/**
 * Seed a minimal on-disk WOF fixture (schema + one place), WITHOUT the FTS index. Writable.
 */
function seedFixture(path: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

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
	).run(101_715_829, 85_688_489, "Paris", "locality", "US", 33.66, -95.55)

	db.prepare(`INSERT INTO names (id, language, name) VALUES (?, ?, ?)`).run(101_715_829, "und", "Paris")
}

/**
 * The readOnly option recorded for the main-shard open of `path` (asserts exactly one such open).
 */
function readOnlyForOpenOf(path: string): boolean | undefined {
	const opens = spy.opens.filter((o) => o.path === path)
	expect(opens).toHaveLength(1)

	return opens[0]!.readOnly
}

describe("WOFSQLitePlaceLookup open mode (databasePath branch)", () => {
	let dir: string
	let dbPath: string

	beforeEach(async () => {
		dir = fixtures.use(await temporaryDirectory("mw-wof-openmode-")).path
		dbPath = join(dir, "admin-fixture.db")
		seedFixture(dbPath)
	})

	afterEach(async () => {
		// Restore write permission (a test may have sealed the file) so the temp dir can be removed.
		try {
			await changeMode(dbPath, 0o644)
		} catch {
			/* already gone */
		}

		spy.opens.length = 0
	})

	test("buildFTS: true opens the main shard READ-WRITE (the FTS5 index build must write)", () => {
		spy.opens.length = 0
		using lookup = new WOFSQLitePlaceLookup({ databasePath: dbPath, buildFTS: true })

		expect(readOnlyForOpenOf(dbPath)).toBe(false)
	})

	test("buildFTS omitted opens the main shard READ-ONLY, even against a sealed 0444 file, and still queries", async () => {
		// Build the FTS index first (read-write), then seal the file 0444 to mimic a shipped shard.
		new WOFSQLitePlaceLookup({ databasePath: dbPath, buildFTS: true })[Symbol.dispose]()
		await changeMode(dbPath, 0o444)

		spy.opens.length = 0
		using lookup = new WOFSQLitePlaceLookup({ databasePath: dbPath })

		expect(readOnlyForOpenOf(dbPath)).toBe(true)

		const candidates = await lookup.findPlace({ text: "Paris", country: "US" })
		expect(candidates.length).toBeGreaterThan(0)
		expect(candidates[0]).toMatchObject({ name: "Paris", country: "US", placetype: "locality" })
	})
})
