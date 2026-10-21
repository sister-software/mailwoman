/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import { overlayDuckDBLimits, spec } from "./overlay-manifest.tsx"

describe("corpus overlay-manifest DuckDB options", () => {
	it("declares both options as numbers", () => {
		expect(spec.options["duckdb-memory-gib"].type).toBe("number")
		expect(spec.options["duckdb-threads"].type).toBe("number")
		expect(spec.options["duckdb-threads"].validate(1.5)).toBe(false)
		expect(spec.options["duckdb-memory-gib"].validate(0)).toBe(false)
	})

	it("reaches the DuckDB connection in the units openDuckDB reads", async () => {
		using db = await openDuckDB(overlayDuckDBLimits({ duckdbMemoryGib: 4, duckdbThreads: 2 }))

		const result = await db.runAndReadAll(
			"SELECT current_setting('memory_limit') AS memory_limit, current_setting('threads') AS threads"
		)

		const row = result.getRowObjectsJS()[0] as { memory_limit: unknown; threads: unknown }

		expect(String(row.memory_limit)).toBe("4.0 GiB")
		expect(String(row.threads)).toBe("2")
	})

	it("leaves an omitted option absent so openDuckDB applies its stated default", () => {
		expect(overlayDuckDBLimits({})).toEqual({})
	})
})
