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

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { removePath } from "@mailwoman/core/fs/writers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { computeSurfaceCountryCounts } from "mailwoman/gazetteer-pipeline/fst"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let scratch: TemporaryDirectory

/**
 * The columns {@link computeSurfaceCountryCounts} reads: `spr` primaries plus the `names` alias table.
 */
function buildFixture(path: string, extraName?: string): void {
	using db = new DatabaseClient<WOFDatabase>(path)

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
}

beforeEach(async () => {
	scratch = await temporaryDirectory("scan-memo-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

describe("computeSurfaceCountryCounts memoization", () => {
	it("counts distinct countries per folded surface", async () => {
		const path = scratch.resolve("a.db")
		buildFixture(path)

		const counts = await computeSurfaceCountryCounts(path)

		expect(counts.get("springfield")).toBe(2)
		expect(counts.get("rennes")).toBe(1)
	})

	it("returns the SAME map instance on a repeat call for an unchanged file", async () => {
		const path = scratch.resolve("a.db")
		buildFixture(path)

		expect(await computeSurfaceCountryCounts(path)).toBe(await computeSurfaceCountryCounts(path))
	})

	it("re-scans when the file is REPLACED — the sealed-artifact rebuild case", async () => {
		const path = scratch.resolve("a.db")
		buildFixture(path)
		const first = await computeSurfaceCountryCounts(path)

		expect(first.get("roazhon")).toBeUndefined()

		// Rebuild the artifact in place with different content, exactly as a gazetteer rebuild does.
		await removePath(path)
		buildFixture(path, "Roazhon")
		const second = await computeSurfaceCountryCounts(path)

		expect(second).not.toBe(first)
		expect(second.get("roazhon")).toBe(1)
	})

	it("keeps separate entries for separate paths", async () => {
		const a = scratch.resolve("a.db")
		const b = scratch.resolve("b.db")
		buildFixture(a)
		buildFixture(b, "Roazhon")

		expect(await computeSurfaceCountryCounts(a)).not.toBe(await computeSurfaceCountryCounts(b))
		expect((await computeSurfaceCountryCounts(b)).get("roazhon")).toBe(1)
	})
})
