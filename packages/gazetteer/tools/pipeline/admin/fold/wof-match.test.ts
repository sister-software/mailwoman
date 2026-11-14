// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   A folded place matches the WOF record of its own tier by concordance,
 *   by country for a country, or by a WOF name within the tier's radius.
 *   Past the radius, or in another tier, the match is null.
 */

import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { createUnifiedSchema } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { buildWOFPlaceIndex } from "#tools/pipeline/admin/fold/wof-match"

/**
 * A staging database holding Zimbabwe, Harare Province, and Harare with an alternate name.
 */
async function stagingDatabase(): Promise<DatabaseClient<WOFDatabase>> {
	const db = DatabaseClient.temp<WOFDatabase>()

	await createUnifiedSchema(db)

	const spr = db.prepare(
		`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current) VALUES (?, ?, ?, ?, 'ZW', ?, ?, 1)`
	)

	spr.run(85_632_243, -1, "Zimbabwe", "country", -19, 29.8)
	spr.run(85_678_001, 85_632_243, "Harare", "region", -17.8, 31)
	spr.run(421_168_573, 85_678_001, "Harare", "locality", -17.8292, 31.0522)

	db.prepare(`INSERT INTO names (id, name, placetype, country, language) VALUES (?, ?, 'locality', 'ZW', 'eng')`).run(
		421_168_573,
		"Salisbury"
	)

	db.prepare(`INSERT INTO concordances (id, other_id, other_source) VALUES (?, ?, ?)`).run(
		421_168_573,
		"890299",
		"gn:id"
	)

	return db
}

describe("buildWOFPlaceIndex", () => {
	it("matches a country by its code alone, whatever its name and point", async () => {
		using db = await stagingDatabase()
		const index = buildWOFPlaceIndex(db)

		expect(
			index.match({ name: "Republic of Zimbabwe", placetype: "country", country: "ZW", latitude: 0, longitude: 0 })
		).toEqual({ id: 85_632_243, placetype: "country", by: "country" })
	})

	it("matches a GeoNames place by its gn:id concordance", async () => {
		using db = await stagingDatabase()
		const index = buildWOFPlaceIndex(db)

		expect(
			index.match({
				name: "Harare City",
				placetype: "locality",
				country: "ZW",
				latitude: -17.9,
				longitude: 31.1,
				geonamesID: 890_299,
			})
		).toEqual({ id: 421_168_573, placetype: "locality", by: "geonames" })
	})

	it("matches an alternate WOF name within the settlement radius and refuses it beyond", async () => {
		using db = await stagingDatabase()
		const index = buildWOFPlaceIndex(db)
		const near = { name: "SALISBURY", placetype: "localadmin", country: "ZW", latitude: -17.84, longitude: 31.06 }

		expect(index.match(near)).toEqual({ id: 421_168_573, placetype: "locality", by: "name" })
		// About 22 km south, past the 5 km settlement radius.
		expect(index.match({ ...near, latitude: -18.03 })).toBeNull()
	})

	it("keeps a match inside its tier: a region named like a locality matches the region", async () => {
		using db = await stagingDatabase()
		const index = buildWOFPlaceIndex(db)

		expect(
			index.match({ name: "Harare", placetype: "region", country: "ZW", latitude: -17.9, longitude: 31.2 })
		).toEqual({ id: 85_678_001, placetype: "region", by: "name" })
	})

	it("matches a localadmin with no settlement of its name to the county of its name", async () => {
		using db = await stagingDatabase()

		db.prepare(
			`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current) VALUES (102049925, 85678001, 'Mazowe', 'county', 'ZW', -17.4, 30.9, 1)`
		).run()

		const index = buildWOFPlaceIndex(db)

		expect(
			index.match({ name: "Mazowe", placetype: "localadmin", country: "ZW", latitude: -17.45, longitude: 30.95 })
		).toEqual({ id: 102_049_925, placetype: "county", by: "name" })
	})

	it("claims a Wikidata id only for a record that has none", async () => {
		using db = await stagingDatabase()

		db.prepare(`INSERT INTO concordances (id, other_id, other_source) VALUES (?, ?, ?)`).run(
			85_678_001,
			"Q1186",
			"wd:id"
		)

		const index = buildWOFPlaceIndex(db)

		expect(index.claimWikidata({ id: 85_678_001 })).toBe(false)
		expect(index.claimWikidata({ id: 421_168_573 })).toBe(true)
		expect(index.claimWikidata({ id: 421_168_573 })).toBe(false)
	})

	it("claims a name once per record and refuses one the record already carries", async () => {
		using db = await stagingDatabase()
		const index = buildWOFPlaceIndex(db)
		const harare = { id: 421_168_573, placetype: "locality" }

		expect(index.claimName(harare, "ZW", "Salisbury")).toBe(false)
		expect(index.claimName(harare, "ZW", "Harare Kapital")).toBe(true)
		expect(index.claimName(harare, "ZW", "harare kapital")).toBe(false)
	})

	it("matches a Wikidata id two records share to the record of the candidate's tier, whatever the insertion order", async () => {
		for (const order of [
			[85_678_001, 421_168_573],
			[421_168_573, 85_678_001],
		]) {
			using db = await stagingDatabase()

			const concordance = db.prepare(
				`INSERT INTO concordances (id, other_id, other_source) VALUES (?, 'Q3921', 'wd:id')`
			)

			for (const id of order) {
				concordance.run(id)
			}

			const index = buildWOFPlaceIndex(db)
			const at = { name: "Harare", country: "ZW", latitude: -17.83, longitude: 31.05, wikidata: "Q3921" }

			expect(index.match({ ...at, placetype: "locality" }), String(order)).toEqual({
				id: 421_168_573,
				placetype: "locality",
				by: "wikidata",
			})

			expect(index.match({ ...at, placetype: "region" }), String(order)).toEqual({
				id: 85_678_001,
				placetype: "region",
				by: "wikidata",
			})
		}
	})
})
