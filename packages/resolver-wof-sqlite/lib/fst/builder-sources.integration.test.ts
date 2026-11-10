/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FST builder reads Who's On First and GeoNames data only: it refuses a country holding an Overture Divisions
 *   place, and it leaves out an alias the Overture fold added to a WOF record.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { buildFSTFromWOF } from "#fst/builder"
import type { WOFDatabase } from "#schema"
import { createUnifiedSchema } from "#unified-schema"

/**
 * Writes a one-place admin database: Springfield, with a WOF name and an Overture alias.
 */
async function writeDatabase(path: string, extraPlaceID?: number): Promise<void> {
	using db = new DatabaseClient<WOFDatabase>(path)

	await createUnifiedSchema(db)

	const spr = db.prepare(
		`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current) VALUES (?, -1, ?, 'locality', 'US', 39.8, -89.6, 1)`
	)

	spr.run(101_725_629, "Springfield")

	if (extraPlaceID) {
		spr.run(extraPlaceID, "Overture Springfield")
	}

	const names = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, source) VALUES (?, ?, 'locality', 'US', 'eng', ?)`
	)

	names.run(101_725_629, "Springfield", "wof")
	names.run(101_725_629, "Capital City", "overture")
}

describe("buildFSTFromWOF sources", () => {
	it("leaves out an alias the Overture fold added to a WOF record", async () => {
		await using directory = await temporaryDirectory("fst-sources-")
		const dbPath = directory.path("admin.db").toString()

		await writeDatabase(dbPath)

		const { matcher } = await buildFSTFromWOF({ dbPath, countries: ["US"], placetypes: ["locality"] })

		expect(matcher.query("springfield").accepting).toHaveLength(1)
		expect(matcher.query("capital city").accepting).toEqual([])
	})

	it("refuses a country that holds an Overture Divisions place", async () => {
		await using directory = await temporaryDirectory("fst-sources-")
		const dbPath = directory.path("admin.db").toString()

		await writeDatabase(dbPath, OVERTURE_ID_BASE + 7)

		await expect(buildFSTFromWOF({ dbPath, countries: ["US"], placetypes: ["locality"] })).rejects.toThrow(
			"1 of 2 places for [US] come from the Overture Divisions fold"
		)
	})
})
