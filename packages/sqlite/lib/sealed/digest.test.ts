// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { DatabaseClient } from "#client"
import { databaseContentDigest } from "#sealed/digest"

interface Place {
	id: number
	name: string
	country: string
	latitude: number
}

/**
 * The fixture database's tables, as the DDL in {@linkcode build} creates them.
 */
interface PlaceDatabase {
	spr: Place
	names: { id: number; name: string; country: string }
	layer_manifest: { name: string; version: string; created_at: string; build_sha: string }
}

/**
 * The one-table database the storage-type test writes.
 */
interface ValueDatabase {
	t: { id: bigint; v: number }
}

const PLACES: Place[] = [
	{ id: 101_713_359, name: "Akron", country: "US", latitude: 41.078013 },
	{ id: 9_895_000_000, name: "Five Points", country: "US", latitude: 41.084779 },
	{ id: 9_000_000_001_466, name: "Greshica-Musaj", country: "AL", latitude: 40.1 },
]

/**
 * An in-memory database holding the given places, written in the given order,
 * with a keyless names table, an FTS index and a build-stamped manifest.
 */
function build(places: readonly Place[], createdAt: string): DatabaseClient<PlaceDatabase> {
	const db = new DatabaseClient<PlaceDatabase>(":memory:")

	db.exec(`
		CREATE TABLE spr (id INTEGER PRIMARY KEY, name TEXT, country TEXT, latitude REAL);
		CREATE TABLE names (id INTEGER NOT NULL, name TEXT NOT NULL, country TEXT);
		CREATE VIRTUAL TABLE place_search USING fts5(name);
		CREATE TABLE layer_manifest (name TEXT PRIMARY KEY, version TEXT, created_at TEXT, build_sha TEXT);
	`)

	const spr = db.prepare("INSERT INTO spr VALUES (?, ?, ?, ?)")
	const names = db.prepare("INSERT INTO names VALUES (?, ?, ?)")
	const search = db.prepare("INSERT INTO place_search (rowid, name) VALUES (?, ?)")

	for (const place of places) {
		spr.run(place.id, place.name, place.country, place.latitude)
		names.run(place.id, place.name.toLowerCase(), place.country)
		search.run(place.id, place.name)
	}

	db.prepare("INSERT INTO layer_manifest VALUES ('admin', '1', ?, ?)").run(createdAt, `sha-${createdAt}`)

	return db
}

describe("databaseContentDigest", () => {
	it("is equal for two databases holding the same rows written in different orders at different times", () => {
		using forward = build(PLACES, "2026-11-13T15:12:00.000Z")
		using reversed = build(PLACES.toReversed(), "2026-11-14T01:00:00.000Z")

		expect(databaseContentDigest(reversed)).toEqual(databaseContentDigest(forward))
	})

	it("changes when one value changes, and only that table's digest moves", () => {
		using before = build(PLACES, "2026-11-13T15:12:00.000Z")

		using after = build(
			PLACES.map((place) => (place.id === 9_000_000_001_466 ? { ...place, name: "Greshica-Liçaj" } : place)),
			"2026-11-13T15:12:00.000Z"
		)

		const a = databaseContentDigest(before)
		const b = databaseContentDigest(after)

		expect(b.root).not.toBe(a.root)
		expect(b.tables["layer_manifest"]).toEqual(a.tables["layer_manifest"])
		expect(b.tables["spr"]!.digest).not.toBe(a.tables["spr"]!.digest)
	})

	it("splits a table by country, so a change shows only in the country it touched", () => {
		using before = build(PLACES, "2026-11-13T15:12:00.000Z")

		using after = build(
			PLACES.map((place) => (place.country === "AL" ? { ...place, latitude: 40.2 } : place)),
			"2026-11-13T15:12:00.000Z"
		)

		const a = databaseContentDigest(before, { countryColumn: "country" })
		const b = databaseContentDigest(after, { countryColumn: "country" })

		expect(b.tables["spr"]!.byCountry!["US"]).toBe(a.tables["spr"]!.byCountry!["US"])
		expect(b.tables["spr"]!.byCountry!["AL"]).not.toBe(a.tables["spr"]!.byCountry!["AL"])
	})

	it("tells the integer 1 from the real 1.0, and reads ids past 2^53 exactly", () => {
		using integer = new DatabaseClient<ValueDatabase>(":memory:")
		using real = new DatabaseClient<ValueDatabase>(":memory:")

		for (const db of [integer, real]) {
			db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v)")
		}

		integer.prepare("INSERT INTO t VALUES (9007199254740993, 1)").run()
		real.prepare("INSERT INTO t VALUES (9007199254740993, 1.0)").run()

		expect(databaseContentDigest(real).root).not.toBe(databaseContentDigest(integer).root)
		expect(Object.keys(databaseContentDigest(integer).tables)).toEqual(["t"])
	})

	it("reads the FTS index through its rows and leaves its shadow tables out", () => {
		using db = build(PLACES, "2026-11-13T15:12:00.000Z")

		expect(Object.keys(databaseContentDigest(db).tables).toSorted()).toEqual([
			"layer_manifest",
			"names",
			"place_search",
			"spr",
		])
	})
})
