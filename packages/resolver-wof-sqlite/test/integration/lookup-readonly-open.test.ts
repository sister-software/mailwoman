/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Regression guard for the open mode WOFSQLitePlaceLookup chooses on the databasePath branch:
 * read-only by default on every serve and query path, read-write only when buildFTS is requested
 * because the FTS5 index build is the sole writer. Shipped extracts are sealed 0444 and Docker :ro
 * mounts forbid write-mode opens.
 *
 * SQLite silently downgrades a write-mode open to read-only on an owned read-only file, so a 0444
 * open succeeds under a write-mode option too. Recording the readOnly option passed to DatabaseSync
 * is the reliable signal.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { changeMode } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilder } from "path-ts"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

// Record every DatabaseSync construction (path + the readOnly option) while delegating to the real implementation.
const spy = vi.hoisted(() => ({ opens: [] as Array<{ path: string; readOnly: boolean | undefined }> }))

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>()

	class RecordingDatabaseSync extends actual.DatabaseSync {
		constructor(path: string, options?: { readOnly?: boolean }) {
			spy.opens.push({ path, readOnly: options?.readOnly })

			// node:sqlite rejects an explicit `undefined` options arg, so forward only when actually passed.
			if (options === undefined) {
				super(path)
			} else {
				super(path, options)
			}
		}
	}

	return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

// The root vitest config runs `isolate: false` with one shared module graph
// per worker, so `node:sqlite` or `./lookup.ts` may already sit in the cache,
// evaluated with the real DatabaseSync by an earlier file.
// The mock factory would never run for a cached module and the construction spy would stay empty.
// Reset on the way in so the chain re-evaluates against the mock, and on the way out
// so the next file never inherits our RecordingDatabaseSync. so the next file in this
// fork never inherits our RecordingDatabaseSync from the cache.
vi.resetModules()
afterAll(() => vi.resetModules())

// Dynamic imports after the reset (and after the hoisted vi.mock registration above) so the
// module-under-test chain evaluates against the RecordingDatabaseSync mock.
// oxlint-disable-next-line no-restricted-imports -- this probe records the construction, so it must import the builtin directly
await import("node:sqlite")
const { WOFSQLitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite/lookup")

/**
 * Seed a minimal on-disk WOF fixture (schema and one place) without the FTS index.
 * Writable.
 */
function seedFixture(path: PathBuilder): void {
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
 * The readOnly option recorded for the main-extract open of `path` (asserts exactly one such open).
 */
function readOnlyForOpenOf(path: PathBuilder): boolean | undefined {
	const opens = spy.opens.filter((o) => o.path === path.toString())
	expect(opens).toHaveLength(1)

	return opens[0]!.readOnly
}

describe("WOFSQLitePlaceLookup open mode (databasePath branch)", () => {
	let dir: PathBuilder
	let dbPath: PathBuilder

	beforeEach(async () => {
		dir = fixtures.use(await temporaryDirectory("mw-wof-openmode-")).path
		dbPath = dir("admin-fixture.db")
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

	test("buildFTS: true opens the main extract READ-WRITE (the FTS5 index build must write)", () => {
		spy.opens.length = 0
		using _lookup = new WOFSQLitePlaceLookup({ databasePath: dbPath, buildFTS: true })

		expect(readOnlyForOpenOf(dbPath)).toBe(false)
	})

	test("buildFTS omitted opens the main extract READ-ONLY, even against a sealed 0444 file, and still queries", async () => {
		// Build the FTS index first (read-write), then seal the file 0444 to mimic a shipped extract.
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
