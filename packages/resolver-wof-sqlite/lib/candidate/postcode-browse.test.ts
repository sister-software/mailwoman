// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, test } from "vitest"

import { PostcodePlaceBrowser } from "#candidate/postcode-browse"
import {
	CANDIDATE_POSTCODE_PLACE_INDEX,
	type CandidateDatabase,
	createCandidatePostcodePlaceIndex,
	createCandidateStagingTables,
	createCandidateTable,
} from "#candidate/schema"

const POSTCODE = 3
const LOCALITY = 1

/**
 * A candidate gazetteer with postcode places, one of them under two primary rows,
 * one alias row, and a locality, so a page must keep only postcode places and list each once.
 */
async function candidateFixture(withPostcodes: boolean): Promise<DatabaseClient<CandidateDatabase>> {
	const db = DatabaseClient.temp<CandidateDatabase>()

	await createCandidateStagingTables(db)
	await createCandidateTable(db)

	db.exec(`INSERT INTO country_codes VALUES (0, 'FR'), (1, 'EE'), (2, 'FJ')`)
	db.exec(`INSERT INTO placetype_codes VALUES (${LOCALITY}, 'locality')`)

	const row = db.prepare(
		"INSERT INTO candidate (name_key, country_id, region_id, placetype_id, neg_rank, spr_id, name, latitude, longitude, is_primary) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)"
	)

	row.run("paris", 0, 0, LOCALITY, 101, "Paris", 48.85, 2.35, 1)

	if (withPostcodes) {
		db.exec(`INSERT INTO placetype_codes VALUES (${POSTCODE}, 'postalcode')`)
		row.run("75008", 0, 0, POSTCODE, 421_307_191, "75008", 48.87, 2.31, 1)
		// The same place under a second region scope is a second primary row.
		row.run("75008", 0, 7, POSTCODE, 421_307_191, "75008", 48.87, 2.31, 1)
		row.run("paris 8", 0, 0, POSTCODE, 421_307_191, "Paris 8", 48.87, 2.31, 0)
		row.run("75008", 1, 0, POSTCODE, 9_500_000_088_047, "75008", 59.11, 25.4, 1)
		row.run("fj1", 2, 0, POSTCODE, 9_500_000_000_001, "FJ1", -17.5, 179.5, 1)
		await createCandidatePostcodePlaceIndex(db, POSTCODE)
	}

	return db
}

describe("PostcodePlaceBrowser", () => {
	test("pages through each postcode place once, in id order, by its own country", async () => {
		await using cleanup = new AsyncDisposableStack()
		const db = cleanup.adopt(await candidateFixture(true), (d) => d.destroy())
		using browser = new PostcodePlaceBrowser({ database: db })

		expect(browser.holdsPostcodes()).toBe(true)

		const first = await browser.page({ box: null, after: null, limit: 2 })

		expect(first.map(({ id, country }) => [id, country])).toEqual([
			[421_307_191, "FR"],
			[9_500_000_000_001, "FJ"],
		])

		expect(
			(await browser.page({ box: null, after: first.at(-1)!.id, limit: 2 })).map(({ id, country }) => [id, country])
		).toEqual([[9_500_000_088_047, "EE"]])

		expect(await browser.place(9_500_000_088_047)).toEqual({
			id: 9_500_000_088_047,
			name: "75008",
			placetype: "postalcode",
			country: "EE",
			latitude: 59.11,
			longitude: 25.4,
		})

		expect(await browser.place(101)).toBeNull()
	})

	test("a box keeps the places whose point it holds, across the antimeridian too", async () => {
		await using cleanup = new AsyncDisposableStack()
		const db = cleanup.adopt(await candidateFixture(true), (d) => d.destroy())
		using browser = new PostcodePlaceBrowser({ database: db })

		const paris = await browser.page({ box: { minLon: 2, minLat: 48, maxLon: 3, maxLat: 49 }, after: null, limit: 10 })

		expect(paris.map(({ id }) => id)).toEqual([421_307_191])

		const fiji = await browser.page({
			box: { minLon: 179, minLat: -18, maxLon: -179, maxLat: -17 },
			after: null,
			limit: 10,
		})

		expect(fiji.map(({ id }) => id)).toEqual([9_500_000_000_001])
	})

	test("a page reads the partial index rather than the candidate table", async () => {
		await using cleanup = new AsyncDisposableStack()
		const db = cleanup.adopt(await candidateFixture(true), (d) => d.destroy())

		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT spr_id, country_id, latitude, longitude, MIN(name) AS name FROM candidate INDEXED BY ${CANDIDATE_POSTCODE_PLACE_INDEX} WHERE placetype_id = ${POSTCODE} AND is_primary = 1 AND spr_id > ? GROUP BY spr_id ORDER BY spr_id LIMIT ?`
			)
			.all(0, 10) as Array<{ detail: string }>

		expect(plan.map(({ detail }) => detail).join("\n")).toContain(`COVERING INDEX ${CANDIDATE_POSTCODE_PLACE_INDEX}`)
	})

	test("a gazetteer without postcode places holds none and pages nothing", async () => {
		await using cleanup = new AsyncDisposableStack()
		const db = cleanup.adopt(await candidateFixture(false), (d) => d.destroy())
		using browser = new PostcodePlaceBrowser({ database: db })

		expect(browser.holdsPostcodes()).toBe(false)
		expect(await browser.page({ box: null, after: null, limit: 10 })).toEqual([])
	})
})
