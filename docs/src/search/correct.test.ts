/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { correctTokens, damerauLevenshtein } from "./correct.ts"
import { fixtureDatabase } from "./database.node.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("damerauLevenshtein", () => {
	test.each([
		["viterbi", "viterbi", 0],
		["vitrebi", "viterbi", 1],
		["vitebi", "viterbi", 1],
		["decodr", "decod", 1],
		["grammer", "grammar", 1],
		["abc", "xyz", 3],
	])("%s to %s is %i", (a, b, distance) => {
		expect(damerauLevenshtein(a, b)).toBe(distance)
	})
})

describe("correctTokens", () => {
	test("replaces a transposed token with the vocabulary term", async () => {
		expect(await correctTokens(db, ["vitrebi"])).toEqual(["viterbi"])
	})

	test("corrects only the tokens that need it", async () => {
		// The vocabulary holds stemmed terms, so `grammer` corrects to `grammar` and `viterbi` stays.
		expect(await correctTokens(db, ["viterbi", "grammer"])).toEqual(["viterbi", "grammar"])
	})

	test("accepts one edit only for a token under six characters", async () => {
		// `tier` is in the vocabulary.
		// `tiexx` is two edits away and stays as typed; `tierr` is one.
		// The six-character `tierxx` is also two edits away and is accepted.
		// Each shares a trigram with `tier`; the first assertion shows `tier` is proposed for `tiexx`.
		const proposed = await db.query<{ term: string }>(
			"SELECT t.term FROM terms_trigram JOIN terms t ON t.rowid = terms_trigram.rowid WHERE terms_trigram MATCH '\"tie\"'"
		)

		expect(proposed.map((row) => row.term)).toContain("tier")
		expect(await correctTokens(db, ["tiexx"])).toBeNull()
		expect(await correctTokens(db, ["tierr"])).toEqual(["tier"])
		expect(await correctTokens(db, ["tierxx"])).toEqual(["tier"])
	})

	test("returns null when no token has a close term", async () => {
		expect(await correctTokens(db, ["zzzzzzz"])).toBeNull()
	})

	test("leaves a token under three characters as typed", async () => {
		expect(await correctTokens(db, ["ab"])).toBeNull()
	})
})
