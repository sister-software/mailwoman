/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
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
		await writeLocalTextFile(record(8, SQUARE, { "wof:placetype": "country", "wof:country": "CD" }), repo("8.geojson"))

		const candidatePath = directory.path("candidate.db")

		{
			using db = new DatabaseClient<CandidateDatabase>(candidatePath)

			db.exec(
				`CREATE TABLE placetype_codes (id INTEGER, placetype TEXT);
				 CREATE TABLE country_codes (id INTEGER, code TEXT);
				 CREATE TABLE candidate (spr_id INTEGER, placetype_id INTEGER, country_id INTEGER);
				 INSERT INTO placetype_codes VALUES (1, 'locality'), (2, 'country');
				 INSERT INTO country_codes VALUES (1, 'GB'), (2, 'CD');
				 INSERT INTO candidate (spr_id, placetype_id, country_id) VALUES
				   (1, 1, 1), (1, 1, 1), (2, 1, 1), (3, 1, 1), (5, 1, 1), (6, 1, 1), (9000, 1, 1), (9001, 2, 2);`
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
			read: 8,
			kept: 2,
			linkedByWikidata: 1,
			linkedByCountryCode: 1,
			coarsened: 0,
			superseded: 1,
			deprecated: 1,
			notInGazetteer: 1,
			pointOnly: 1,
		})

		using built = new DatabaseClient<PolygonDatabase>(out, { readOnly: true })
		const rows = built.prepare("SELECT id FROM polygons ORDER BY id").all() as Array<{ id: number }>

		expect(rows.map(({ id }) => id)).toEqual([1, 6, 9000, 9001])
	})

	it("coarsens a boundary until it fits the size limit, and counts it", async () => {
		await using directory = await temporaryDirectory("polygons-")
		const ring: number[][] = []

		// A circle of 40,000 positions serializes well past the limit at a tolerance that keeps them.
		for (let step = 0; step < 40_000; step++) {
			const angle = (step / 40_000) * 2 * Math.PI

			ring.push([50 * Math.cos(angle), 50 * Math.sin(angle)])
		}

		ring.push(ring[0]!)

		await writeLocalTextFile(
			record(1, { type: "Polygon", coordinates: [ring] }),
			directory.path("repos", "whosonfirst-data-admin-ru", "data", "1.geojson")
		)

		const candidatePath = directory.path("candidate.db")

		{
			using db = new DatabaseClient<CandidateDatabase>(candidatePath)

			db.exec(
				`CREATE TABLE placetype_codes (id INTEGER, placetype TEXT);
				 CREATE TABLE country_codes (id INTEGER, code TEXT);
				 CREATE TABLE candidate (spr_id INTEGER, placetype_id INTEGER, country_id INTEGER);
				 INSERT INTO candidate VALUES (1, 1, 1);`
			)
		}

		const adminPath = directory.path("admin.db")

		{
			using db = new DatabaseClient<WOFDatabase>(adminPath)

			db.exec("CREATE TABLE concordances (id INTEGER, other_id TEXT, other_source TEXT);")
		}

		const out = directory.path("polygons.db")

		const { counts } = await buildPolygonsDatabase({
			reposDir: directory.path("repos"),
			candidatePath,
			adminPath,
			out,
			countries: ["ru"],
			tolerance: 0.000001,
		})

		expect(counts.coarsened).toBe(1)

		using built = new DatabaseClient<PolygonDatabase>(out, { readOnly: true })
		const [row] = built.prepare("SELECT length(geom) AS bytes FROM polygons").all() as Array<{ bytes: number }>

		expect(row!.bytes).toBeLessThanOrEqual(200_000)
	})

	it("drops an archipelago's smallest parts when simplifying cannot reach the limit, keeping the largest", async () => {
		await using directory = await temporaryDirectory("polygons-")

		const square = (x: number, y: number, size: number) => [
			[
				[x, y],
				[x + size, y],
				[x + size, y + size],
				[x, y + size],
				[x, y],
			],
		]

		const islets = Array.from({ length: 20_000 }, (_, index) => square(index * 0.01, 10, 0.001))
		const mainland = square(0, 0, 8)

		await writeLocalTextFile(
			record(1, { type: "MultiPolygon", coordinates: [...islets, mainland] }),
			directory.path("repos", "whosonfirst-data-admin-id", "data", "1.geojson")
		)

		const candidatePath = directory.path("candidate.db")

		{
			using db = new DatabaseClient<CandidateDatabase>(candidatePath)

			db.exec(
				`CREATE TABLE placetype_codes (id INTEGER, placetype TEXT);
				 CREATE TABLE country_codes (id INTEGER, code TEXT);
				 CREATE TABLE candidate (spr_id INTEGER, placetype_id INTEGER, country_id INTEGER);
				 INSERT INTO candidate VALUES (1, 1, 1);`
			)
		}

		const adminPath = directory.path("admin.db")

		{
			using db = new DatabaseClient<WOFDatabase>(adminPath)

			db.exec("CREATE TABLE concordances (id INTEGER, other_id TEXT, other_source TEXT);")
		}

		const out = directory.path("polygons.db")

		await buildPolygonsDatabase({
			reposDir: directory.path("repos"),
			candidatePath,
			adminPath,
			out,
			countries: ["id"],
			tolerance: 0.001,
		})

		using built = new DatabaseClient<PolygonDatabase>(out, { readOnly: true })
		const [row] = built.prepare("SELECT geom FROM polygons").all() as Array<{ geom: string }>
		const kept = parseJSONStrict<{ coordinates: number[][][][] }>(row!.geom).coordinates

		expect(row!.geom.length).toBeLessThanOrEqual(200_000)
		expect(kept[0]![0]).toContainEqual([8, 8])
	})
})
