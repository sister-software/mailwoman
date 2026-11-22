// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { describe, expect, it } from "vitest"

import { readValidationPool } from "#tools/dev-tools/corpus/validation/quota"

describe("readValidationPool", () => {
	it("leaves a group a training receipt requires out of the pool, and counts it by country", async () => {
		await using directory = await temporaryDirectory("validation-quota-")
		const file = directory.path("test.parquet").toString()
		const manifest = directory.path("MANIFEST.json").toString()

		{
			using db = await openDuckDB()

			await db.run(
				"COPY (SELECT * FROM (VALUES " +
					"('SM', 'rendered-prominent-places-aa', 'wof-admin-7', ['locality']), " +
					"('SM', 'wof-admin-7-default-self', NULL, ['locality']), " +
					"('SM', 'wof-admin-8-default-self', NULL, ['locality']), " +
					"('SM', 'oa-sm-1', NULL, ['street'])" +
					`) t(country, source_id, base_source_id, span_tags)) TO '${file}' (FORMAT PARQUET)`
			)
		}

		await writeLocalJSONFile({ files: [{ path: file, rows: 4, split: "test" }] }, manifest)

		const { candidates, totals, skipped } = await readValidationPool({
			manifest,
			frozen: { groups: new Set() },
			capRows: 100,
			required: { receipts: [], records: new Map([[7, "SM"]]) },
		})

		expect(candidates.map((candidate) => candidate.group).toSorted()).toEqual(["oa-sm-1", "wof-admin-8-default-self"])
		expect(totals.get("SM")).toEqual({ rows: 2, streetRows: 1, groups: 2 })
		expect(skipped).toEqual({ receipts: [], requiredRecords: 1, skippedGroups: 2, byCountry: { SM: 2 } })
	})
})
