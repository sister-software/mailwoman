/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Worker's tests run under the Workers runtime through Miniflare, with a local R2 bucket in place of
 *   `mailwoman-public`. Node builds a small candidate database here and passes its bytes as a binding, and each test
 *   puts them into the bucket. The root Vitest sweep excludes this workspace. CI runs it as its own step.
 */

import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { defineConfig } from "vitest/config"

/**
 * The candidate table's columns, as `WOFCandidateTableLookup` reads them, with three Springfields
 * and a padding table of 2,000 rows of 200 characters, about 100 pages of 4,096 bytes,
 * so a test with a small chunk size reads more than one chunk.
 */
const FIXTURE_SQL = `
	PRAGMA page_size = 4096;
	CREATE TABLE country_codes (id INTEGER PRIMARY KEY, code TEXT);
	INSERT INTO country_codes VALUES (1, 'US');
	CREATE TABLE placetype_codes (id INTEGER PRIMARY KEY, placetype TEXT);
	INSERT INTO placetype_codes VALUES (1, 'locality');
	CREATE TABLE padding (id INTEGER PRIMARY KEY, filler TEXT);
	WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
		INSERT INTO padding SELECT i, printf('%0200d', i) FROM n;
	CREATE TABLE candidate (
		name_key TEXT, country_id INTEGER, region_id INTEGER, placetype_id INTEGER, neg_rank REAL, spr_id INTEGER,
		name TEXT, latitude REAL, longitude REAL, min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
		population INTEGER, is_primary INTEGER
	);
	INSERT INTO candidate VALUES ('springfield', 1, 0, 1, -5.22, 85971363, 'Springfield', 37.21, -93.29, 37.1, -93.4, 37.3, -93.2, 169000, 1);
	INSERT INTO candidate VALUES ('springfield', 1, 0, 1, -5.06, 85950393, 'Springfield', 42.10, -72.59, 42.0, -72.7, 42.2, -72.5, 155000, 1);
	INSERT INTO candidate VALUES ('springfield', 1, 0, 1, -5.06, 85940195, 'Springfield', 39.80, -89.64, 39.7, -89.8, 39.9, -89.5, 114000, 1);
	CREATE INDEX candidate_name_key ON candidate (name_key);
`

async function buildFixture(): Promise<string> {
	await using directory = await temporaryDirectory("gazetteer-worker-fixture-")
	const path = directory.path("candidate.db")

	{
		using db = new DatabaseClient<CandidateDatabase>(path)

		db.exec(FIXTURE_SQL)
	}

	return (await readLocalBuffer(path)).toString("base64")
}

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			miniflare: {
				bindings: { CANDIDATE_FIXTURE_BASE64: await buildFixture() },
			},
		}),
	],
	test: {
		include: ["lib/**/*.test.ts"],
	},
})
