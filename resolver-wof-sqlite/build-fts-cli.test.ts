/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `mailwoman-wof-build-fts` CLI. Drives `main()` directly with synthetic argv so we
 *   exercise the parsing / file-existence / progress paths without forking a child process.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { main } from "./build-fts-cli.ts"
import { placeSearchFTSExists } from "./fts.ts"

let scratch: string

function buildFixtureDB(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		INSERT INTO spr VALUES (1, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);
		INSERT INTO spr VALUES (2, NULL, 'Tokyo', 'locality', 'JP', 35.68, 139.69, 35.50, 35.83, 139.34, 139.91, -1, 0);
	`)
	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-wof-fts-cli-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("build-fts-cli main()", () => {
	test("exits 0 and builds the index against a fresh DB", () => {
		const dbPath = join(scratch, "fixture.db")
		buildFixtureDB(dbPath)
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		const exitCode = main([dbPath])
		expect(exitCode).toBe(0)
		stderrSpy.mockRestore()

		const db = new DatabaseSync(dbPath)

		try {
			expect(placeSearchFTSExists(db)).toBe(true)
		} finally {
			db.close()
		}
	})

	test("exits 0 and is a no-op when the index already exists", () => {
		const dbPath = join(scratch, "fixture.db")
		buildFixtureDB(dbPath)
		main([dbPath]) // first build
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		const exitCode = main([dbPath])
		expect(exitCode).toBe(0)
		// Find the summary line in the stderr captures
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toMatch(/Already present/)
		stderrSpy.mockRestore()
	})

	test("exits 0 and rebuilds when --drop is passed", () => {
		const dbPath = join(scratch, "fixture.db")
		buildFixtureDB(dbPath)
		main([dbPath])
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		const exitCode = main([dbPath, "--drop"])
		expect(exitCode).toBe(0)
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toMatch(/Built/)
		stderrSpy.mockRestore()
	})

	test("exits 1 when the database path does not exist", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const exitCode = main(["/nope/does/not/exist.db"])
		expect(exitCode).toBe(1)
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toMatch(/file not found/)
		stderrSpy.mockRestore()
	})

	test("exits 2 when an unknown flag is passed", () => {
		// vitest auto-throws on process.exit calls inside tests with the message
		// "process.exit unexpectedly called with \"<code>\"".
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		expect(() => main(["--bogus", "x.db"])).toThrow(/process\.exit.*"2"/)

		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toMatch(/unknown flag/)
		stderrSpy.mockRestore()
	})

	test("exits 2 when zero positional args are passed", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		expect(() => main([])).toThrow(/process\.exit.*"2"/)
		stderrSpy.mockRestore()
	})

	test("accepts multiple positional args (variadic — one DB per arg)", () => {
		// Build two real fixture DBs and pass them both. Both should land with indexes.
		const dbA = join(scratch, "a.db")
		const dbB = join(scratch, "b.db")
		buildFixtureDB(dbA)
		buildFixtureDB(dbB)
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		expect(main([dbA, dbB])).toBe(0)
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("")
		// One "Built" line per DB.
		expect(written.match(/Built:/g)?.length).toBe(2)
		stderrSpy.mockRestore()
	})

	test("multi-DB invocation surfaces the worst exit code (missing file → 1)", () => {
		const dbOK = join(scratch, "ok.db")
		buildFixtureDB(dbOK)
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		// Good DB succeeds, missing DB fails. Worst-of-both = 1.
		expect(main([dbOK, "/nope/missing.db"])).toBe(1)
		stderrSpy.mockRestore()
	})

	test("--help exits 0 without doing any work", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		expect(() => main(["--help"])).toThrow(/process\.exit.*"0"/)

		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("")
		expect(written).toMatch(/usage:/)
		stderrSpy.mockRestore()
	})
})
