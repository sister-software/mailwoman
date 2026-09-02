/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Row-schema tests for the demo-cascade smoke eval (#524). The module's own header says it was
 *   split out of the runner "so the schema contract is unit-testable without loading the model / the
 *   hot DB" — and then no test was ever written, which is part of why nobody noticed when the
 *   2026-07-10 probe triage deleted the module out from under its importer and left the check leg
 *   unloadable. A test that imports it is the cheapest possible regression check for that class of mistake:
 *   delete the file again and CI goes red immediately, instead of four weeks later when someone
 *   stages a `wof-hot.db`.
 *
 *   Weightless (#582) — pure string parsing, runs in CI.
 */

import { parseSmokeRows } from "mailwoman/eval-harness/demo-cascade-rows"
import { describe, expect, test } from "vitest"

const VALID = '{"input":"90210","expect":{"id":85688531,"name":"Beverly Hills","placetype":"locality"}}'
const ANCHOR = '{"input":"12345","expect":{"anchor_centroid":true},"note":"slim DB has no postalcode row"}'

describe("parseSmokeRows", () => {
	test("parses a well-formed row", () => {
		const rows = parseSmokeRows(VALID, "test.jsonl")

		expect(rows).toHaveLength(1)
		expect(rows[0]!.input).toBe("90210")
		expect(rows[0]!.expect.id).toBe(85_688_531)
	})

	test("accepts the anchor-centroid form and carries the note", () => {
		const rows = parseSmokeRows(ANCHOR, "test.jsonl")

		expect(rows[0]!.expect.anchor_centroid).toBe(true)
		expect(rows[0]!.note).toBe("slim DB has no postalcode row")
	})

	test("skips blank lines and both comment markers, and numbers rows by FILE line", () => {
		// The row number in an error must point at the line a human would count to in the file, which is
		// why the skipped lines still advance the counter.
		const text = ["# a comment", "", "// another", VALID, "{}"].join("\n")

		expect(() => parseSmokeRows(text, "test.jsonl")).toThrow(/row 5/)
	})

	test("an empty file is an error, not a vacuous pass", () => {
		expect(() => parseSmokeRows("\n\n# nothing here\n", "empty.jsonl")).toThrow(/no rows found/)
	})

	test("names the file and the row on invalid JSON, and echoes the line", () => {
		expect(() => parseSmokeRows("{not json", "rows.jsonl")).toThrow(/rows\.jsonl: row 1 is malformed — invalid JSON/)
	})

	test("rejects an unknown top-level key", () => {
		expect(() => parseSmokeRows('{"input":"x","expect":{"id":1},"expectd":true}', "r.jsonl")).toThrow(
			/unknown key "expectd"/
		)
	})

	test("rejects an unknown expect key, listing what is allowed", () => {
		expect(() => parseSmokeRows('{"input":"x","expect":{"idd":1}}', "r.jsonl")).toThrow(
			/unknown `expect` key "idd" \(allowed: id, name, placetype, anchor_centroid\)/
		)
	})

	test("requires EXACTLY one of id / anchor_centroid", () => {
		const neither = '{"input":"x","expect":{"name":"nope"}}'
		const both = '{"input":"x","expect":{"id":1,"anchor_centroid":true}}'

		for (const row of [neither, both]) {
			expect(() => parseSmokeRows(row, "r.jsonl")).toThrow(/exactly one of `id`/)
		}
	})

	test("rejects a non-positive or non-integer id", () => {
		for (const id of ["0", "-3", "1.5", '"85688531"']) {
			expect(() => parseSmokeRows(`{"input":"x","expect":{"id":${id}}}`, "r.jsonl")).toThrow(
				/`expect\.id` must be a positive integer WOF id/
			)
		}
	})

	test("anchor_centroid must be literally true — false is a malformed row, not an opt-out", () => {
		expect(() => parseSmokeRows('{"input":"x","expect":{"anchor_centroid":false}}', "r.jsonl")).toThrow(
			/`expect\.anchor_centroid` must be literally `true`/
		)
	})

	test("rejects an empty or non-string input", () => {
		for (const input of ['""', '"   "', "42"]) {
			expect(() => parseSmokeRows(`{"input":${input},"expect":{"id":1}}`, "r.jsonl")).toThrow(
				/`input` must be a non-empty string/
			)
		}
	})

	test("rejects a row that is not a JSON object", () => {
		for (const row of ["[1,2]", '"a string"', "7"]) {
			expect(() => parseSmokeRows(row, "r.jsonl")).toThrow(/row must be a JSON object/)
		}
	})

	test("truncates a pathologically long row in the echo", () => {
		const long = `{"input":"${"x".repeat(500)}","expect":{}}`

		expect(() => parseSmokeRows(long, "r.jsonl")).toThrow(/…/)
	})
})
