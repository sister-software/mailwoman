/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Row-schema contract tests for the demo-cascade smoke eval (#524). The runner must fail LOUD —
 *   naming the row — on any malformed row, and the committed row file must always satisfy its own
 *   schema (id verification against the gazetteer is the author's job; shape is CI's).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { parseSmokeRows } from "./demo-cascade-rows.js"

const here = fileURLToPath(new URL(".", import.meta.url))

const valid = (over: Record<string, unknown> = {}) =>
	JSON.stringify({ input: "Brooklyn", expect: { id: 421205765, name: "Brooklyn" }, ...over })

describe("parseSmokeRows", () => {
	it("parses a valid id-asserting row", () => {
		const rows = parseSmokeRows(valid(), "test.jsonl")
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ input: "Brooklyn", expect: { id: 421205765 } })
	})

	it("parses a valid anchor-centroid row", () => {
		const rows = parseSmokeRows(JSON.stringify({ input: "90210", expect: { anchor_centroid: true } }), "test.jsonl")
		expect(rows[0]?.expect.anchor_centroid).toBe(true)
	})

	it("skips blank lines and comment lines", () => {
		const rows = parseSmokeRows(`\n# comment\n// also a comment\n${valid()}\n`, "test.jsonl")
		expect(rows).toHaveLength(1)
	})

	it("names the row on invalid JSON", () => {
		expect(() => parseSmokeRows(`${valid()}\nnot json{`, "test.jsonl")).toThrow(/test\.jsonl: row 2.*invalid JSON/s)
	})

	it("names the row on a missing input", () => {
		expect(() => parseSmokeRows(JSON.stringify({ expect: { id: 1 } }), "rows.jsonl")).toThrow(
			/rows\.jsonl: row 1.*`input` must be a non-empty string/s
		)
	})

	it("rejects an empty-string input", () => {
		expect(() => parseSmokeRows(valid({ input: "  " }), "rows.jsonl")).toThrow(/non-empty string/)
	})

	it("rejects a missing expect", () => {
		expect(() => parseSmokeRows(JSON.stringify({ input: "x" }), "rows.jsonl")).toThrow(/`expect` must be an object/)
	})

	it("rejects a row with BOTH id and anchor_centroid", () => {
		expect(() => parseSmokeRows(valid({ expect: { id: 5, anchor_centroid: true } }), "rows.jsonl")).toThrow(
			/exactly one of/
		)
	})

	it("rejects a row with NEITHER id nor anchor_centroid", () => {
		expect(() => parseSmokeRows(valid({ expect: { name: "Brooklyn" } }), "rows.jsonl")).toThrow(/exactly one of/)
	})

	it("rejects a non-integer id", () => {
		expect(() => parseSmokeRows(valid({ expect: { id: "421205765" } }), "rows.jsonl")).toThrow(
			/`expect.id` must be a positive integer/
		)
		expect(() => parseSmokeRows(valid({ expect: { id: 1.5 } }), "rows.jsonl")).toThrow(/positive integer/)
		expect(() => parseSmokeRows(valid({ expect: { id: -3 } }), "rows.jsonl")).toThrow(/positive integer/)
	})

	it("rejects an unknown expect key (typo guard)", () => {
		expect(() => parseSmokeRows(valid({ expect: { wof_id: 1 } }), "rows.jsonl")).toThrow(
			/unknown `expect` key "wof_id"/
		)
	})

	it("rejects an unknown top-level key", () => {
		expect(() => parseSmokeRows(valid({ comment: "nope" }), "rows.jsonl")).toThrow(/unknown key "comment"/)
	})

	it("rejects a non-string note", () => {
		expect(() => parseSmokeRows(valid({ note: 42 }), "rows.jsonl")).toThrow(/`note` must be a string/)
	})

	it("rejects an empty file — never a vacuous pass", () => {
		expect(() => parseSmokeRows("\n\n# only comments\n", "rows.jsonl")).toThrow(/no rows found/)
	})

	it("echoes the offending line in the error", () => {
		expect(() => parseSmokeRows(JSON.stringify({ input: "x", expect: {} }), "rows.jsonl")).toThrow(/row: \{"input"/)
	})
})

describe("the committed row file", () => {
	it("data/eval/external/demo-cascade-smoke.jsonl satisfies the schema", () => {
		const file = resolve(here, "../../data/eval/external/demo-cascade-smoke.jsonl")
		const rows = parseSmokeRows(readFileSync(file, "utf8"), file)
		expect(rows.length).toBeGreaterThanOrEqual(20)
		// Every id-asserting row carries the human-readable cross-checks the README asks for.
		for (const row of rows) {
			if (row.expect.id !== undefined) expect(row.expect.name, row.input).toBeTruthy()
		}
	})
})
