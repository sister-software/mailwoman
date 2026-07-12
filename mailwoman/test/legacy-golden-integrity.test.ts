/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-0 legacy excision: integrity guard for the committed golden artifacts (spec §Evidence
 *   capture). These files are the non-regression references for the v7 production swaps; this
 *   test fails if one goes missing, truncates, or stops parsing. Deleted in plan 4 along with the
 *   legacy suite once the swaps have landed and their gates carry the load.
 *   The golden files are readonly artifacts: never hand-edit them — regenerate via the dev-tools
 *   capture scripts (this guard cannot catch value edits).
 */

import { readFileSync } from "node:fs"

import { expect, test } from "vitest"

function readRows(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
}

test("parity-inputs.jsonl: every row has a file, an input, and expected records", () => {
	const rows = readRows("mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl") as Array<{
		file?: string
		input?: string
		expected?: unknown[]
	}>

	expect(rows.length).toBeGreaterThanOrEqual(370)

	for (const row of rows) {
		expect(typeof row.file).toBe("string")
		expect(typeof row.input).toBe("string")
		expect(Array.isArray(row.expected)).toBe(true)
	}
})

test("parity-raw.jsonl: aligned 1:1 with parity-inputs", () => {
	const inputs = readRows("mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl")
	const raw = readRows("mailwoman/test-fixtures/legacy-golden/parity-raw.jsonl") as Array<{ solutions?: unknown[] }>

	expect(raw.length).toBe(inputs.length)

	for (const row of raw) {
		expect(Array.isArray(row.solutions)).toBe(true)
	}
})

test("v1-parse-golden.jsonl: outcomes carry solutions arrays", () => {
	const rows = readRows("mailwoman/test-fixtures/legacy-golden/v1-parse-golden.jsonl") as Array<{
		input?: string
		outcome?: { solutions?: unknown[] }
	}>

	expect(rows.length).toBeGreaterThanOrEqual(350)

	for (const row of rows) {
		expect(typeof row.input).toBe("string")
		expect(Array.isArray(row.outcome?.solutions)).toBe(true)
	}
})

test("libpostal parse-golden.jsonl: wire rows are [{label, value}] under status 200", () => {
	const rows = readRows("libpostal/test-fixtures/parse-golden.jsonl") as Array<{
		status?: number
		body?: Array<{ label?: string; value?: string }>
	}>

	expect(rows.length).toBeGreaterThanOrEqual(350)

	for (const row of rows) {
		expect(row.status).toBe(200)

		for (const component of row.body ?? []) {
			expect(typeof component.label).toBe("string")
			expect(typeof component.value).toBe("string")
		}
	}
})

test("nominatim search-golden.jsonl: full responses captured", () => {
	const rows = readRows("nominatim/test-fixtures/search-golden.jsonl") as Array<{ query?: string; status?: number }>

	expect(rows.length).toBeGreaterThanOrEqual(100)

	for (const row of rows) {
		expect(typeof row.query).toBe("string")
		expect(typeof row.status).toBe("number")
	}
})
