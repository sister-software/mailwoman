/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { queryTokens } from "@mailwoman/react/search/tokens"
import { describe, expect, test } from "vitest"

import { fixtureDatabase } from "./database.node.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"
import { lexicalRows, matchExpression } from "./lexical.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

/**
 * The fixture id of each row.
 *
 * The index identifies a record by its rowid, which follows the insertion order of the fixtures.
 */
async function fixtureIDs(tokens: readonly string[]): Promise<string[]> {
	return (await lexicalRows(db, tokens)).map((row) => FIXTURE_RECORDS[Number(row.id) - 1]?.id ?? row.id)
}

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
		await expect(fixtureIDs(["viterbi"])).resolves.toEqual(["viterbi-top", "viterbi-section"])
	})

	test("ranks a page whose heading matches above a table row whose name matches", async () => {
		await expect(fixtureIDs(["norway"])).resolves.toEqual(["norway-page", "row"])
	})

	test("matches the last token as a prefix", async () => {
		await expect(fixtureIDs(["decoder", "gram"])).resolves.toContain("viterbi-section")
	})

	test("matches a singular query against a plural word", async () => {
		await expect(fixtureIDs(["parser"])).resolves.toEqual(["parsers"])
	})

	test("returns an empty list for zero tokens", async () => {
		await expect(lexicalRows(db, [])).resolves.toEqual([])
	})

	test.each(['"', "a AND", "NEAR(a b)", "col:value", "a* OR", "(", "a - b", "^a", "-"])(
		"returns rows or an empty list for the FTS5 syntax %s",
		async (text) => {
			await expect(lexicalRows(db, queryTokens(text))).resolves.toBeInstanceOf(Array)
		}
	)
})
