// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import { PROMINENT_PLACES_RECORD_VERSION } from "#tools/training/audits/prominent/coverage"
import {
	createRequiredGroupsTable,
	readRequiredTrainingGroups,
	requiredGroupSQL,
} from "#tools/training/audits/required-groups"

/**
 * GB's ranked Alpha (required), Beta (unselected) and Gamma (a failed GeoNames match), and FR's capital Delta.
 * A config admitting only GB doesn't require Delta.
 */
const PLACES_SQL =
	"SELECT * FROM (VALUES " +
	"(101, 'GB', 1, true, false, 'importance', NULL), " +
	"(102, 'GB', 9, false, false, 'importance', NULL), " +
	"(103, 'GB', 2, true, false, 'geonames', 'competing-candidate'), " +
	"(104, 'FR', 1, false, true, 'importance', NULL)" +
	") AS t(spr_id, country, rank, by_rank, capital, score_source, geonames_check)"

describe("readRequiredTrainingGroups", () => {
	it("reads the receipt's required places for the config's countries, and names each place's groups", async () => {
		await using directory = await temporaryDirectory("required-groups-")
		const places = directory.path("places.parquet").toString()

		{
			using db = await openDuckDB()

			await db.run(`COPY (${PLACES_SQL}) TO '${places}' (FORMAT PARQUET)`)
		}

		await writeLocalJSONFile(
			{ version: PROMINENT_PLACES_RECORD_VERSION, places_sha256: await sha256File(places) },
			directory.path("PLACES.json")
		)

		const required = await readRequiredTrainingGroups({
			data: { prominent_place_coverage: places, country_weights: { GB: 1 } },
		})

		expect(required.records).toEqual(new Map([[101, "GB"]]))
		expect(required.receipts).toMatchObject([{ receipt: "prominent_place_coverage", places, required_places: 1 }])

		using db = await openDuckDB()

		await createRequiredGroupsTable(db, required)

		const groups = [
			"wof-admin-101",
			"wof-admin-101-default-self",
			"wof-admin-1010-default-self",
			"wof-admin-102",
			"wof-admin-jp-101",
			"oa-gb-101",
		]

		const rows = (
			await db.runAndReadAll(
				`SELECT g, ${requiredGroupSQL("g")} AS required FROM (VALUES ${groups.map((g) => `('${g}')`).join(", ")}) t(g)`
			)
		).getRowObjects()

		expect(Object.fromEntries(rows.map((row) => [String(row.g), row.required]))).toEqual({
			"wof-admin-101": true,
			"wof-admin-101-default-self": true,
			"wof-admin-1010-default-self": false,
			"wof-admin-102": false,
			"wof-admin-jp-101": false,
			"oa-gb-101": false,
		})
	})

	it("requires no group of a config that declares no receipt", async () => {
		const required = await readRequiredTrainingGroups({
			data: { prominent_place_coverage: null, country_weights: { GB: 1 } },
		})

		expect(required).toEqual({ receipts: [], records: new Map() })
	})
})
