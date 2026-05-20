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

import { main } from "./build-fts-cli.js"
import { placeSearchFtsExists } from "./fts.js"

let scratch: string

function buildFixtureDb(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE places (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, placetype TEXT NOT NULL, country TEXT);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY, place_id INTEGER, language TEXT, kind TEXT, name TEXT);
		INSERT INTO places VALUES (1, NULL, 'Paris', 'locality', 'FR');
		INSERT INTO places VALUES (2, NULL, 'Tokyo', 'locality', 'JP');
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
		buildFixtureDb(dbPath)
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		const exitCode = main([dbPath])
		expect(exitCode).toBe(0)
		stderrSpy.mockRestore()

		const db = new DatabaseSync(dbPath)
		try {
			expect(placeSearchFtsExists(db)).toBe(true)
		} finally {
			db.close()
		}
	})

	test("exits 0 and is a no-op when the index already exists", () => {
		const dbPath = join(scratch, "fixture.db")
		buildFixtureDb(dbPath)
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
		buildFixtureDb(dbPath)
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

	test("exits 2 when zero or multiple positional args are passed", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		expect(() => main([])).toThrow(/process\.exit.*"2"/)
		expect(() => main(["a.db", "b.db"])).toThrow(/process\.exit.*"2"/)

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
