/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The full-DB scans behind the locality-surface build are memoized by (path, mtimeMs, size). Two
 *   builds in one process — the FR and US passes — used to pay the scan twice; measured 2026-08-02
 *   that pair was 236.9s of a 253s CI leg.
 *
 *   The invalidation key is deliberately (mtimeMs, size) and not path alone: the WOF admin DB is a
 *   sealed readonly artifact that a rebuild REPLACES, and a path-only memo would serve the old scan
 *   against the new file for the life of the process.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { computeSurfaceCountryCounts } from "./fst.ts"

let scratch: string

/**
 * The columns {@link computeSurfaceCountryCounts} reads: `spr` primaries plus the `names` alias table.
 */
function buildFixture(path: string, extraName?: string): void {
	const db = new DatabaseSync(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT, is_current INTEGER
		);
		CREATE TABLE names (id INTEGER, name TEXT);

		INSERT INTO spr VALUES (1, 'Springfield', 'locality', 'US', 1);
		INSERT INTO spr VALUES (2, 'Springfield', 'locality', 'CA', 1);
		INSERT INTO spr VALUES (3, 'Rennes', 'locality', 'FR', 1);
	`)

	if (extraName) {
		db.prepare("INSERT INTO names VALUES (?, ?)").run(3, extraName)
	}

	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "scan-memo-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true })
})

describe("computeSurfaceCountryCounts memoization", () => {
	it("counts distinct countries per folded surface", () => {
		const path = join(scratch, "a.db")
		buildFixture(path)

		const counts = computeSurfaceCountryCounts(path)

		expect(counts.get("springfield")).toBe(2)
		expect(counts.get("rennes")).toBe(1)
	})

	it("returns the SAME map instance on a repeat call for an unchanged file", () => {
		const path = join(scratch, "a.db")
		buildFixture(path)

		expect(computeSurfaceCountryCounts(path)).toBe(computeSurfaceCountryCounts(path))
	})

	it("re-scans when the file is REPLACED — the sealed-artifact rebuild case", async () => {
		const path = join(scratch, "a.db")
		buildFixture(path)
		const first = computeSurfaceCountryCounts(path)

		expect(first.get("roazhon")).toBeUndefined()

		// Rebuild the artifact in place with different content, exactly as a gazetteer rebuild does.
		await rm(path)
		buildFixture(path, "Roazhon")
		const second = computeSurfaceCountryCounts(path)

		expect(second).not.toBe(first)
		expect(second.get("roazhon")).toBe(1)
	})

	it("keeps separate entries for separate paths", () => {
		const a = join(scratch, "a.db")
		const b = join(scratch, "b.db")
		buildFixture(a)
		buildFixture(b, "Roazhon")

		expect(computeSurfaceCountryCounts(a)).not.toBe(computeSurfaceCountryCounts(b))
		expect(computeSurfaceCountryCounts(b).get("roazhon")).toBe(1)
	})
})
