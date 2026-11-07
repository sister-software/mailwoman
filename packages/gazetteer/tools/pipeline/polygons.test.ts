/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import type { PolygonDatabase } from "@mailwoman/resolver-wof-sqlite/polygon-schema"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, it } from "vitest"

import { buildPolygonsDatabase } from "#tools/pipeline/polygons"

const SQUARE = {
	type: "Polygon",
	coordinates: [
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
			[0, 0],
		],
	],
}

const record = (id: number, geometry: unknown, properties: Record<string, unknown> = {}) =>
	stringifyJSON({ id, type: "Feature", geometry, properties: { "wof:id": id, ...properties } })

describe("buildPolygonsDatabase", () => {
	it("keeps a place's area, reaches a merged place by Wikidata id, and counts each refusal by its reason", async () => {
		await using directory = await temporaryDirectory("polygons-")
		const repo = directory.path("repos", "whosonfirst-data-admin-gb", "data")

		await writeLocalTextFile(record(1, SQUARE), repo("1.geojson"))
		await writeLocalTextFile(record(1, { type: "Point", coordinates: [9, 9] }), repo("1-alt-quattroshapes.geojson"))
		await writeLocalTextFile(record(2, SQUARE, { "wof:superseded_by": [1] }), repo("2.geojson"))
		await writeLocalTextFile(record(3, SQUARE, { "edtf:deprecated": "2020" }), repo("3.geojson"))
		await writeLocalTextFile(record(4, SQUARE), repo("4.geojson"))
		await writeLocalTextFile(record(5, { type: "Point", coordinates: [1, 1] }), repo("5.geojson"))
		await writeLocalTextFile(record(7, SQUARE, { "wof:concordances": { "wd:id": "Q155" } }), repo("7.geojson"))

		const candidatePath = directory.path("candidate.db")

		{
			using db = new DatabaseClient<CandidateDatabase>(candidatePath)

			db.exec(
				"CREATE TABLE candidate (spr_id INTEGER); INSERT INTO candidate VALUES (1), (1), (2), (3), (5), (6), (9000);"
			)
		}

		const adminPath = directory.path("admin.db")

		{
			using db = new DatabaseClient<WOFDatabase>(adminPath)

			db.exec(
				"CREATE TABLE concordances (id INTEGER, other_id TEXT, other_source TEXT); INSERT INTO concordances VALUES (9000, 'Q155', 'wd:id');"
			)
		}

		// A clone reached through a symbolic link holds real rows.
		await writeLocalTextFile(record(6, SQUARE), directory.path("linked", "data", "6.geojson"))
		await createSymbolicLink(directory.path("linked"), directory.path("repos", "whosonfirst-data-admin-us"))

		const out = directory.path("polygons.db")

		const { counts } = await buildPolygonsDatabase({
			reposDir: directory.path("repos"),
			candidatePath,
			adminPath,
			out,
			countries: ["gb", "us"],
			tolerance: 0.001,
		})

		expect(counts).toMatchObject({
			read: 7,
			kept: 2,
			linkedByWikidata: 1,
			superseded: 1,
			deprecated: 1,
			notInGazetteer: 1,
			pointOnly: 1,
		})

		using built = new DatabaseClient<PolygonDatabase>(out, { readOnly: true })
		const rows = built.prepare("SELECT id FROM polygons ORDER BY id").all() as Array<{ id: number }>

		expect(rows.map(({ id }) => id)).toEqual([1, 6, 9000])
	})
})
