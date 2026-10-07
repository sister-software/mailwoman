/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { fixtureDatabase } from "./database.node.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"
import { lexicalRows, matchExpression, queryTokens } from "./lexical.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("queryTokens", () => {
	test("keeps tokens that contain a letter or a digit", () => {
		expect(queryTokens('  tier-1  "regression" -- *** ')).toEqual(["tier-1", '"regression"'])
	})
})

describe("matchExpression", () => {
	test("quotes every token and marks the last one as a prefix", () => {
		expect(matchExpression(["decoder", "gram"])).toBe('"decoder" "gram"*')
	})

	test("doubles a quote character inside a token", () => {
		expect(matchExpression(['say"hi'])).toBe('"say""hi"*')
	})

	test("returns null for zero tokens", () => {
		expect(matchExpression([])).toBeNull()
	})
})

describe("lexicalRows", () => {
	test("ranks a heading match above a content match", async () => {
		const rows = await lexicalRows(db, ["viterbi"])

		expect(rows.map((row) => row.id)).toEqual(["viterbi-top", "viterbi-section"])
	})

	test("matches the last token as a prefix", async () => {
		expect((await lexicalRows(db, ["decoder", "gram"])).map((row) => row.id)).toContain("viterbi-section")
	})

	test("matches a singular query against a plural word", async () => {
		expect((await lexicalRows(db, ["parser"])).map((row) => row.id)).toEqual(["parsers"])
	})

	test("returns an empty list for zero tokens", async () => {
		expect(await lexicalRows(db, [])).toEqual([])
	})

	test.each(['"', "a AND", "NEAR(a b)", "col:value", "a* OR", "(", "a - b", "^a", "-"])(
		"returns rows or an empty list for the FTS5 syntax %s",
		async (text) => {
			await expect(lexicalRows(db, queryTokens(text))).resolves.toBeInstanceOf(Array)
		}
	)
})
