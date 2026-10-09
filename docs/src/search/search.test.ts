/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { SearchRecord } from "@mailwoman/react/search/types"
import { describe, expect, test } from "vitest"

import { fixtureDatabase } from "./database.node.ts"
import type { SearchDatabase, SQLValue } from "./database.ts"
import { FIXTURE_RECORDS } from "./fixtures.ts"
import { collapseBySection, HITS_PER_PAGE, search, surfaceWord } from "./search.ts"

const db = fixtureDatabase(FIXTURE_RECORDS)

describe("search", () => {
	test("returns one hit per section, so a page's matching sections each appear", async () => {
		const response = await search(db, "viterbi")

		const anchors = response.hits.filter((hit) => hit.url === "/docs/kb/decoding-and-viterbi").map((hit) => hit.anchor)

		expect(anchors).toEqual(["", "objective"])
		expect(response.hits[0]?.hierarchy[1]).toBe("Decoding and Viterbi")
		expect(response.corrected).toBeNull()
	})

	test("corrects a misspelled token and reports the corrected text as a word from the hits", async () => {
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
		expect(await search(db, "zzzzzzz")).toEqual({ query: "zzzzzzz", corrected: null, hits: [] })
	})
})

function record(url: string, anchor: string): SearchRecord {
	return {
		id: `${url}#${anchor}`,
		url,
		anchor,
		hierarchy: ["Docs", url, null, null, null, null, null],
		content: "",
		level: 1,
		position: 0,
	}
}

describe("collapseBySection", () => {
	test("keeps one hit per section and at most three per page, in rank order", () => {
		const ranked = [
			record("/a", ""),
			record("/a", "one"),
			record("/a", "one"),
			record("/a", "two"),
			record("/a", "three"),
			record("/b", ""),
		]

		expect(collapseBySection(ranked, 10).map((hit) => `${hit.url}#${hit.anchor}`)).toEqual([
			"/a#",
			"/a#one",
			"/a#two",
			"/b#",
		])

		expect(HITS_PER_PAGE).toBe(3)
	})
})

describe("surfaceWord", () => {
	test("picks the most frequent word in the hits that begins with the stem", () => {
		const rows = [
			{ ...record("/x", ""), content: "Geocoding a geocode. Geocoding again." },
			{ ...record("/y", ""), content: "The geocoder." },
		]

		expect(surfaceWord("geocod", rows)).toBe("geocoding")
	})

	test("returns the stem itself when no hit word begins with it", () => {
		expect(surfaceWord("zzz", [record("/x", "")])).toBe("zzz")
	})
})
