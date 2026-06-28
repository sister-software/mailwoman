/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildSlimWofDatabase}. Builds a tiny fixture WOF with a country + a few
 *   localities (varying populations) + postcodes + a non-US locality, then asserts that the slim
 *   output keeps only what the selection policy promises.
 *
 *   The fixture mirrors the PRODUCTION source shape: `spr` + `names` + a pre-built `place_population`
 *   aux table, and NO `geojson` table. `scripts/build-unified-wof.ts` extracts `wof:population`
 *   into `place_population` at ingest and never persists geojson, so the slim builder reads
 *   population straight from that table.
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
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);

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

		-- place_population (sparse, pre-built upstream) so the population-ranked selector has something
		-- to sort on. Postcodes (300/301) and the deprecated locality (500) carry no population row.
		INSERT INTO place_population VALUES (100, 331000000);
		INSERT INTO place_population VALUES (101, 12700000);
		INSERT INTO place_population VALUES (200, 2700000);
		INSERT INTO place_population VALUES (201, 114000);
		INSERT INTO place_population VALUES (202, 8000);
		INSERT INTO place_population VALUES (400, 2100000);
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

	test("preserves names + place_population only for selected IDs", async () => {
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

			// place_population is filtered to surviving spr ids: ancestors 100/101 + top-1 locality 200.
			// Postcodes (300/301) have no population row; trimmed places (202/400) are gone.
			const popIds = slim
				.prepare(`SELECT id FROM place_population ORDER BY id`)
				.all()
				.map((r) => (r as { id: number }).id)
			expect(popIds).toEqual([100, 101, 200])
			expect(popIds).not.toContain(400)
			expect(popIds).not.toContain(202)

			// The slim DB never carries a geojson table — production source has none, and the builder
			// reads population from place_population, not geojson.
			const geojsonExists = slim.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'geojson'`).get()
			expect(geojsonExists).toBeUndefined()
		} finally {
			slim.close()
		}
	})

	test("carries place_population for the trimmed row set, ranked by population", async () => {
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

	test("dropNames removes the names table but keeps a working FTS index", async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)

		const result = await buildSlimWofDatabase({ inputs: [source], output, topLocalitiesPerCountry: 2, dropNames: true })
		// The report still carries the pre-drop names count (informative), even though the table is gone.
		expect(result.rowCounts.names).toBeGreaterThan(0)
		expect(result.rowCounts.placeSearch).toBe(6)

		const slim = new DatabaseSync(output, { readOnly: true })

		try {
			const namesExists = slim.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'names'`).get()
			expect(namesExists).toBeUndefined()

			// place_search is a self-contained FTS5, so name MATCH still works with names gone.
			const hit = slim.prepare(`SELECT wof_id FROM place_search WHERE place_search MATCH 'Chicago'`).get() as
				| { wof_id: number }
				| undefined
			expect(hit?.wof_id).toBe(200)
		} finally {
			slim.close()
		}
	})

	test('skips empty input paths (callers pass "" for an unbuilt shard)', async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)

		// Both the demo plugin and build-demo-assets.ts pass `--in ""` when the custom postcode DB
		// isn't built yet. The empty path must be skipped, not treated as a missing file.
		const result = await buildSlimWofDatabase({ inputs: ["", source, ""], output, topLocalitiesPerCountry: 1 })
		expect(result.rowCounts.spr).toBe(5) // 1 country + 1 region + 1 locality + 2 postcodes
	})

	test("carries the coincident_roles relation, filtered to surviving spr ids (#402)", async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)
		// A dual-role relation: Illinois(101) ⊃ Springfield(201) [survives top-2] and ⊃ Mascoutah(202) [trimmed].
		const s = new DatabaseSync(source)
		s.exec(`CREATE TABLE coincident_roles (
			admin_id INTEGER NOT NULL, locality_id INTEGER NOT NULL, relationship_type TEXT NOT NULL,
			admin_placetype TEXT NOT NULL, distance_km REAL NOT NULL, locality_population INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (admin_id, locality_id))`)
		s.exec(`INSERT INTO coincident_roles VALUES (101, 201, 'capital-seat', 'region', 5.0, 114000)`)
		s.exec(`INSERT INTO coincident_roles VALUES (101, 202, 'capital-seat', 'region', 6.0, 8000)`)
		s.close()

		await buildSlimWofDatabase({ inputs: [source], output, topLocalitiesPerCountry: 2 }) // keeps Springfield, drops Mascoutah

		const slim = new DatabaseSync(output, { readOnly: true })

		try {
			const rows = slim.prepare(`SELECT admin_id, locality_id FROM coincident_roles ORDER BY locality_id`).all()
			// Only the surviving pair — Mascoutah's row is dropped because 202 was trimmed from spr.
			expect(rows).toEqual([{ admin_id: 101, locality_id: 201 }])
		} finally {
			slim.close()
		}
	})

	test("materializes place_abbr from language='abbr' names, filtered to surviving ids, surviving dropNames (#189)", async () => {
		const source = join(scratch, "src.db")
		const output = join(scratch, "slim.db")
		buildFixtureWof(source)
		const s = new DatabaseSync(source)
		s.exec(`INSERT INTO names (id, language, name) VALUES (101, 'abbr', 'IL')`) // Illinois (region) — survives
		s.exec(`INSERT INTO names (id, language, name) VALUES (202, 'abbr', 'MZ')`) // Mascoutah (locality) — trimmed
		s.close()

		// top-2 keeps Springfield, drops Mascoutah; dropNames removes the source names table afterward.
		await buildSlimWofDatabase({ inputs: [source], output, topLocalitiesPerCountry: 2, dropNames: true })

		const slim = new DatabaseSync(output, { readOnly: true })

		try {
			const rows = slim.prepare(`SELECT id, abbr FROM place_abbr ORDER BY abbr`).all()
			// Illinois keeps its abbr; the trimmed locality's is gone (names was pre-filtered to surviving
			// ids). And place_abbr persists even though dropNames removed the source `names` table.
			expect(rows).toEqual([{ id: 101, abbr: "IL" }])
			expect(slim.prepare(`SELECT 1 FROM sqlite_master WHERE name='names'`).get()).toBeUndefined()
		} finally {
			slim.close()
		}
	})
})
