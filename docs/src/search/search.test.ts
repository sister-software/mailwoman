/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, test } from "vitest"

import { fixtureDatabase } from "./database.node.ts"
import type { SearchDatabase, SQLValue } from "./database.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"
import { search } from "./search.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("search", () => {
	test("returns one hit per url with a snippet and highlights", async () => {
		const response = await search(db, "viterbi")

		expect(response.hits.filter((hit) => hit.url === "/docs/kb/decoding-and-viterbi")).toHaveLength(1)
		expect(response.hits[0]?.hierarchy[1]).toBe("Decoding and Viterbi")
		expect(response.corrected).toBeUndefined()
	})

	test("corrects a misspelled token and reports the corrected text", async () => {
		const response = await search(db, "vitrebi")

		expect(response.corrected).toBe("viterbi")
		expect(response.hits[0]?.url).toBe("/docs/kb/decoding-and-viterbi")
	})

	test("returns zero hits for text without a letter or digit, and runs no query", async () => {
		let queries = 0

		const counting: SearchDatabase = {
			query<Row>(sql: string, parameters?: readonly SQLValue[]) {
				queries++

				return db.query<Row>(sql, parameters)
			},
		}

		expect((await search(counting, "-- ***")).hits).toEqual([])
		expect(queries).toBe(0)
	})

	test("honors the limit", async () => {
		expect((await search(db, "the", 1)).hits).toHaveLength(1)
	})

	test("returns zero hits when nothing matches and no correction is close", async () => {
		expect(await search(db, "zzzzzzz")).toEqual({ query: "zzzzzzz", hits: [] })
	})
})
