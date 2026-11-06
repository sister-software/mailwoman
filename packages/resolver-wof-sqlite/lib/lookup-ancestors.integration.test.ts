// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * End-to-end test for WOFSQLitePlaceLookup.ancestors.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { WOFSQLitePlaceLookup } from "#lookup"
import type { WOFDatabase } from "#schema"

let db: DatabaseClient<WOFDatabase>
let lookup: WOFSQLitePlaceLookup

beforeEach(() => {
	db = DatabaseClient.temp<WOFDatabase>()

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE names (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, language TEXT, name TEXT);
		CREATE TABLE ancestors (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
	`)

	const spr = db.prepare(
		`INSERT INTO spr (id, parent_id, name, placetype, country, latitude, longitude,
			min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated)
			VALUES (?, NULL, ?, ?, 'DE', ?, ?, ?, ?, ?, ?, 1, 0)`
	)

	// Germany 900 ⊃ Berlin region 910 ⊃ Berlin locality 911.
	spr.run(900, "Germany", "country", 51.1, 10.4, 47.3, 5.9, 55.1, 15)
	spr.run(910, "Berlin", "region", 52.52, 13.4, 52.22, 13.1, 52.82, 13.7)
	spr.run(911, "Berlin", "locality", 52.52, 13.4, 52.42, 13.3, 52.62, 13.5)
	const anc = db.prepare(`INSERT INTO ancestors (id, ancestor_id, ancestor_placetype) VALUES (?, ?, ?)`)
	anc.run(911, 910, "region")
	anc.run(911, 900, "country")
	anc.run(910, 900, "country")

	lookup = new WOFSQLitePlaceLookup({ database: db, buildFTS: true })
})

afterEach(() => db.destroy())

describe("WOFSQLitePlaceLookup.ancestors", () => {
	test("returns the lineage nearest-first, joined with spr", () => {
		expect(lookup.ancestors(911)).toEqual([
			{ id: 910, placetype: "region", name: "Berlin" },
			{ id: 900, placetype: "country", name: "Germany" },
		])
	})

	test("returns [] for an id with no recorded ancestry", () => {
		expect(lookup.ancestors(99_999)).toHaveLength(0)
	})
})
