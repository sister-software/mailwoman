// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { iterateJSONL, readJSONL, writeJSONL } from "./jsonl.ts"

describe("jsonl", () => {
	it("round-trips rows and skips blank lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "jsonl-"))
		const path = join(dir, "rows.jsonl")
		const rows = [{ a: 1 }, { b: "two" }]

		expect(writeJSONL(path, rows)).toBe(2)
		expect(readJSONL(path)).toEqual(rows)

		// Blank + whitespace-only lines are skipped, trailing newline tolerated.
		writeFileSync(path, '{"a":1}\n\n  \n{"b":"two"}\n', "utf8")
		expect(readJSONL(path)).toEqual(rows)

		const streamed: unknown[] = []

		for await (const row of iterateJSONL(path)) {
			streamed.push(row)
		}

		expect(streamed).toEqual(rows)
	})
})
