// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Overture part's offer file holds the part's rows and only them,
 *   under ODbL 1.0 with Overture's credit.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { isSealed } from "@mailwoman/sqlite/sealed/db"
import type { PathBuilderLike } from "path-ts"
import { describe, expect, test } from "vitest"

import { buildOverturePart, OVERTURE_PART_ATTRIBUTION } from "#tools/pipeline/collective-offer"

const DIVISION = OVERTURE_ID_BASE + 5

/**
 * A candidate holding one WOF place, Chicago, and one Overture division under it.
 */
function writeCandidate(path: PathBuilderLike, withMatchTable: boolean): void {
	using db = new DatabaseClient<Record<string, never>>(path)

	db.exec(`
		CREATE TABLE candidate (name_key TEXT NOT NULL, country_id INTEGER NOT NULL, spr_id INTEGER NOT NULL, name TEXT,
			PRIMARY KEY (name_key, country_id, spr_id)) WITHOUT ROWID;
		CREATE TABLE candidate_ancestor (spr_id INTEGER NOT NULL, depth INTEGER NOT NULL, parent_spr_id INTEGER NOT NULL,
			PRIMARY KEY (spr_id, depth)) WITHOUT ROWID;
		CREATE TABLE candidate_interval (spr_id INTEGER PRIMARY KEY, pre INTEGER NOT NULL, post INTEGER NOT NULL);
		CREATE TABLE country_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
		CREATE TABLE placetype_codes (id INTEGER PRIMARY KEY, placetype TEXT UNIQUE);
		INSERT INTO country_codes VALUES (0, 'US');
		INSERT INTO placetype_codes VALUES (0, 'locality');
		INSERT INTO candidate VALUES ('chicago', 0, 200, 'Chicago');
		INSERT INTO candidate VALUES ('oak park', 0, ${DIVISION}, 'Oak Park');
		INSERT INTO candidate_ancestor VALUES (200, 1, 101);
		INSERT INTO candidate_ancestor VALUES (${DIVISION}, 1, 101);
		INSERT INTO candidate_interval VALUES (200, 1, 2);
	`)

	if (withMatchTable) {
		db.exec(`
			CREATE TABLE overture_wof_match (overture_id INTEGER PRIMARY KEY, wof_id INTEGER NOT NULL, match_by TEXT NOT NULL);
			INSERT INTO overture_wof_match VALUES (${OVERTURE_ID_BASE + 6}, 200, 'wikidata');
		`)
	}
}

describe("buildOverturePart", () => {
	test("copies the part's rows and tables and nothing outside them, under ODbL 1.0", async () => {
		await using scratch = await temporaryDirectory("overture-part-")
		const candidate = scratch.path("candidate.db")
		const out = scratch.path("part.db")

		writeCandidate(candidate, true)

		const result = await buildOverturePart({
			candidateDB: candidate,
			out,
			overtureRelease: "2026-09-23.1",
			version: "2026-11-21a",
		})

		expect(result.rows).toMatchObject({
			candidate: 1,
			candidate_ancestor: 1,
			candidate_interval: 0,
			overture_wof_match: 1,
		})

		await expect(isSealed(out)).resolves.toBe(true)

		using db = new DatabaseClient<Record<string, never>>(out, { readOnly: true })

		expect(db.prepare("SELECT spr_id FROM candidate").all()).toEqual([{ spr_id: DIVISION }])

		const manifest = db.prepare("SELECT license, attribution, source_vintage FROM layer_manifest").get() as {
			license: string
			attribution: string
			source_vintage: string
		}

		expect(manifest.license).toBe("ODbL-1.0")
		expect(manifest.attribution).toContain(OVERTURE_PART_ATTRIBUTION)
		expect(manifest.source_vintage).toBe("overture-divisions=2026-09-23.1")
	})

	test("refuses a candidate built before the fold kept its Overture rows apart", async () => {
		await using scratch = await temporaryDirectory("overture-part-")
		const candidate = scratch.path("candidate.db")

		writeCandidate(candidate, false)

		await expect(
			buildOverturePart({ candidateDB: candidate, out: scratch.path("part.db"), overtureRelease: "x", version: "x" })
		).rejects.toThrow("has no overture_wof_match table")
	})
})
