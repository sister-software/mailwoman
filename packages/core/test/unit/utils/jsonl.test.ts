/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { iterateJSONL, writeJSONL } from "@mailwoman/core/utils/jsonl"
import { mkdtempSync, writeFileSync } from "@mailwoman/platform/fs"
import { tmpdir } from "@mailwoman/platform/os"
import { join } from "@mailwoman/platform/path"
import { describe, expect, it } from "vitest"

describe("jsonl", () => {
	it("round-trips rows and skips blank lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jsonl-"))
		const path = join(dir, "rows.jsonl")
		const rows = [{ a: 1 }, { b: "two" }]

		expect(writeJSONL(path, rows)).toBe(2)
		expect(await Array.fromAsync(iterateJSONL(path))).toEqual(rows)

		// Blank + whitespace-only lines are skipped, trailing newline tolerated.
		writeFileSync(path, '{"a":1}\n\n  \n{"b":"two"}\n', "utf8")
		expect(await Array.fromAsync(iterateJSONL(path))).toEqual(rows)
	})
})
