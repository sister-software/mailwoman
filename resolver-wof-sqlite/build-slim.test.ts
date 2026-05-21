/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildSlimWofDatabase}. Builds a tiny fixture WOF with a country + a few
 *   localities (varying populations) + postcodes + a non-US locality, then asserts that the slim
 *   output keeps only what the selection policy promises.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { buildSlimWofDatabase } from "./build-slim.js"

let scratch: string

function buildFixtureWof(path: string): void {
	const db = new DatabaseSync(path)
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, max_latitude REAL, min_longitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE geojson (id INTEGER PRIMARY KEY, body TEXT);

		-- US country + region (ancestor placetypes — always kept)
		INSERT INTO spr VALUES (100, NULL, 'United States', 'country', 'US', 39.0, -97.0, 24.5, 49.4, -125.0, -66.9, -1, 0);
		INSERT INTO spr VALUES (101, 100, 'Illinois', 'region', 'US', 40.0, -89.0, 37.0, 42.5, -91.5, -87.0, -1, 0);

		-- Three US localities with varying populations
		INSERT INTO spr VALUES (200, 101, 'Chicago', 'locality', 'US', 41.88, -87.63, 41.6, 42.0, -87.9, -87.5, -1, 0);
		INSERT INTO spr VALUES (201, 101, 'Springfield', 'locality', 'US', 39.80, -89.65, 39.7, 39.9, -89.8, -89.5, -1, 0);
		INSERT INTO spr VALUES (202, 101, 'Mascoutah', 'locality', 'US', 38.49, -89.79, 38.4, 38.5, -89.85, -89.75, -1, 0);

		-- US postcodes (always kept)
		INSERT INTO spr VALUES (300, 201, '62701', 'postalcode', 'US', 39.81, -89.65, 39.80, 39.82, -89.66, -89.64, -1, 0);
		INSERT INTO spr VALUES (301, 200, '60601', 'postalcode', 'US', 41.88, -87.62, 41.87, 41.89, -87.63, -87.61, -1, 0);

		-- Non-US locality (should be dropped)
		INSERT INTO spr VALUES (400, NULL, 'Paris', 'locality', 'FR', 48.85, 2.34, 48.81, 48.90, 2.22, 2.46, -1, 0);

		-- Deprecated US locality (should be dropped)
		INSERT INTO spr VALUES (500, 101, 'Old Town', 'locality', 'US', 40.0, -89.0, 40.0, 40.0, -89.0, -89.0, 1, 1);

		-- names rows
		INSERT INTO names (id, language, name) VALUES (100, 'eng', 'America');
		INSERT INTO names (id, language, name) VALUES (200, 'eng', 'Chicago');
		INSERT INTO names (id, language, name) VALUES (201, 'eng', 'Springfield');
		INSERT INTO names (id, language, name) VALUES (202, 'eng', 'Mascoutah');
		INSERT INTO names (id, language, name) VALUES (300, 'eng', 'Springfield ZIP');
		INSERT INTO names (id, language, name) VALUES (400, 'fra', 'Paris');

		-- geojson with wof:population so the population-ranked selector has something to sort on
		INSERT INTO geojson VALUES (100, '{"properties":{"wof:population":331000000}}');
		INSERT INTO geojson VALUES (101, '{"properties":{"wof:population":12700000}}');
		INSERT INTO geojson VALUES (200, '{"properties":{"wof:population":2700000}}');
		INSERT INTO geojson VALUES (201, '{"properties":{"wof:population":114000}}');
		INSERT INTO geojson VALUES (202, '{"properties":{"wof:population":8000}}');
		INSERT INTO geojson VALUES (300, '{"properties":{}}');
		INSERT INTO geojson VALUES (301, '{"properties":{}}');
		INSERT INTO geojson VALUES (400, '{"properties":{"wof:population":2100000}}');
		INSERT INTO geojson VALUES (500, '{"properties":{"wof:population":0}}');
	`)
	db.close()
}

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-slim-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

describe("buildSlimWofDatabase", () => {
	test("keeps ancestors, top-K localities by population, and all postcodes", async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)

		const result = await buildSlimWofDatabase({
			inputs: [source],
			output,
			topLocalitiesPerCountry: 2, // keeps Chicago + Springfield, drops Mascoutah
		})

		expect(result.rowCounts.spr).toBe(6) // 2 ancestors + 2 localities + 2 postcodes
		expect(result.rowCounts.placeSearch).toBe(6)
		expect(result.rowCounts.placeBbox).toBe(6)

		const slim = new DatabaseSync(output, { readOnly: true })
		try {
			const names = slim
				.prepare(`SELECT name FROM spr ORDER BY id`)
				.all()
				.map((r) => (r as { name: string }).name)
			expect(names).toEqual(["United States", "Illinois", "Chicago", "Springfield", "62701", "60601"])

			// Mascoutah, Paris, and Old Town must be absent.
			expect(names).not.toContain("Mascoutah")
			expect(names).not.toContain("Paris")
			expect(names).not.toContain("Old Town")
		} finally {
			slim.close()
		}
	})

	test("preserves names + geojson only for selected IDs", async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)

		await buildSlimWofDatabase({ inputs: [source], output, topLocalitiesPerCountry: 1 })

		const slim = new DatabaseSync(output, { readOnly: true })
		try {
			const nameIds = slim
				.prepare(`SELECT DISTINCT id FROM names ORDER BY id`)
				.all()
				.map((r) => (r as { id: number }).id)
			// Top-1 locality = Chicago (200); ancestors 100/101; postcodes 300/301.
			expect(nameIds).toEqual([100, 200, 300])
			// Paris (400) and Mascoutah (202) names must be gone.
			expect(nameIds).not.toContain(400)
			expect(nameIds).not.toContain(202)

			// geojson is dropped at the end of the build — it's only needed to feed place_population,
			// and lookup.ts never reads it at query time. Confirm the drop happened.
			const geojsonExists = slim.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'geojson'`).get()
			expect(geojsonExists).toBeUndefined()
		} finally {
			slim.close()
		}
	})

	test("builds the place_population aux table on the trimmed row set", async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)

		await buildSlimWofDatabase({ inputs: [source], output, topLocalitiesPerCountry: 2 })

		const slim = new DatabaseSync(output, { readOnly: true })
		try {
			const rows = slim
				.prepare(`SELECT id, population FROM place_population ORDER BY population DESC LIMIT 3`)
				.all() as Array<{ id: number; population: number }>
			expect(rows[0]?.id).toBe(100) // US country, biggest population
			expect(rows[0]?.population).toBe(331000000)
		} finally {
			slim.close()
		}
	})

	test("merges rows across multiple input shards without duplicating", async () => {
		const adminSource = join(scratch, "admin.db")
		const postcodeSource = join(scratch, "postcode.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(adminSource)
		// Postcode shard: same schema, only contributes postcodes (here, re-use the admin fixture's
		// postcode rows to verify INSERT OR IGNORE actually de-dupes on id).
		buildFixtureWof(postcodeSource)

		const result = await buildSlimWofDatabase({
			inputs: [adminSource, postcodeSource],
			output,
			topLocalitiesPerCountry: 1,
		})

		// Same 5 rows (1 country + 1 region + 1 locality + 2 postcodes) — no duplication across shards.
		expect(result.rowCounts.spr).toBe(5)
	})
})
