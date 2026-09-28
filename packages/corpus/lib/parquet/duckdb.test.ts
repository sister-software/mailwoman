/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { totalMemoryBytes } from "@mailwoman/core/utils/system"
import { DUCKDB_MEMORY_SHARE, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

/**
 * One setting as DuckDB reports it back.
 */
async function setting(db: Awaited<ReturnType<typeof openDuckDB>>, name: string): Promise<string> {
	const result = await db.runAndReadAll(`SELECT current_setting('${name}') AS value`)

	return String((result.getRowObjectsJS()[0] as { value: unknown }).value)
}

describe("openDuckDB", () => {
	it("bounds every connection's memory, because DuckDB allocates outside the V8 heap", async () => {
		using db = await openDuckDB()

		const limit = await setting(db, "memory_limit")
		const [value, unit] = limit.split(" ")
		const bytes = Number(value) * (unit === "GiB" ? 1024 ** 3 : unit === "MiB" ? 1024 ** 2 : 1)

		// DuckDB rounds the value it reports, so the assertion is a band rather than an equality.
		const expected = totalMemoryBytes() * DUCKDB_MEMORY_SHARE

		expect(bytes).toBeGreaterThan(expected * 0.9)
		expect(bytes).toBeLessThan(expected * 1.1)
	})

	it("admits four concurrent instances within host memory, which the previous default did not", () => {
		// The default exists to bound the host rather than one query.
		// Two instances at half the host exceed it together.
		// That is the case that took the machine down on 2026-09-28.
		expect(DUCKDB_MEMORY_SHARE * 4).toBeLessThanOrEqual(1)
	})

	it("takes an explicit limit and thread count for a caller that knows what else is running", async () => {
		using db = await openDuckDB({ memoryLimitBytes: 512 * 1024 * 1024, threads: 2 })

		// DuckDB reads the binary unit `formatIEC` writes and reports the same quantity back.
		// `formatSI`'s `MB` would arrive as decimal megabytes and report 488.2 MiB instead.
		expect(await setting(db, "memory_limit")).toBe("512.0 MiB")
		expect(await setting(db, "threads")).toBe("2")
	})

	it("points a spill at a directory that exists, so a spill is not a failed query", async () => {
		using db = await openDuckDB()

		const directory = await setting(db, "temp_directory")

		expect(directory.length).toBeGreaterThan(0)

		const { pathExists } = await import("@mailwoman/core/fs/readers")

		expect(await pathExists(directory)).toBe(true)
	})
})
