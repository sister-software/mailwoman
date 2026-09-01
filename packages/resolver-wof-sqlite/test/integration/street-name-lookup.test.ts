/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link SQLiteStreetNameLookup} (#727 phase-4c FR backend) against a fixture DB built
 *   with the contract fold (`foldStreetSurface`). Covers unscoped + scoped lookups, the fold
 *   contract (hyphen/apostrophe), positive-evidence fallback, and graceful degrade on a tableless db.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { foldStreetSurface } from "@mailwoman/resolver"
import type { StreetCentroidDatabase } from "@mailwoman/resolver-wof-sqlite/street-centroid-schema"
import { SQLiteStreetNameLookup } from "@mailwoman/resolver-wof-sqlite/street-name-lookup"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

let dir: TemporaryDirectory
let dbPath: string
let emptyPath: string

beforeAll(async () => {
	dir = await temporaryDirectory("mw-street-name-")
	dbPath = dir.resolve("street-centroids-fr.db")
	using seed = new DatabaseClient<StreetCentroidDatabase>(dbPath)

	// The real extract shape: the geocoding `street_norm` PLUS the #727 phase-4c `name_key` (contract fold). The reader must
	// prefer `name_key`; each row carries a DELIBERATELY WRONG street_norm, so a passing lookup proves it read name_key.
	seed.exec(
		"CREATE TABLE street_centroid (street_norm TEXT NOT NULL, postcode TEXT, locality_base TEXT NOT NULL, name_key TEXT NOT NULL)"
	)

	const ins = seed.prepare(
		"INSERT INTO street_centroid (street_norm, postcode, locality_base, name_key) VALUES (?, ?, ?, ?)"
	)

	const rows: Array<[string, string, string]> = [
		["Rue Corsier", "75001", "Paris"],
		["Rue Pillet-Will", "75009", "Paris"],
		["Chemin d'En Galinier", "31000", "Toulouse"],
		["Rue Guarnieri", "13001", "Marseille"],
	]

	for (const [raw, pc, loc] of rows) {
		ins.run("ZZ-wrong-street-norm", pc, foldStreetSurface(loc), foldStreetSurface(raw))
	}

	emptyPath = dir.resolve("empty.db")
	using empty = new DatabaseClient<StreetCentroidDatabase>(emptyPath)
	empty.exec("CREATE TABLE unrelated (x)")
})

afterAll(() => dir[Symbol.asyncDispose]())

describe("SQLiteStreetNameLookup", () => {
	test("unscoped hit on an existing street name", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Corsier")).toBe(true)
		expect(lk.hasStreetName("Rue Guarnieri")).toBe(true)
	})

	test("miss on a street not in the index (positive evidence only)", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Nonexistent")).toBe(false)
	})

	test("fold contract: a hyphenated/apostrophe'd query matches the folded index entry", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Pillet-Will")).toBe(true) // hyphen → space, matches "rue pillet will"
		expect(lk.hasStreetName("Chemin d'En Galinier")).toBe(true)
	})

	test("scoped lookup by locality hits when the pair exists", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Corsier", { locality: "Paris" })).toBe(true)
	})

	test("scoped miss falls back to the unscoped probe (scope incompleteness ≠ absence)", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		// Right street, wrong locality → the scoped probe misses, but the unscoped fallback confirms the name exists.
		expect(lk.hasStreetName("Rue Corsier", { locality: "Lyon" })).toBe(true)
	})

	test("scoped lookup by postcode", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Corsier", { postcode: "75001" })).toBe(true)
	})

	test("empty street surface is a miss", () => {
		using lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("")).toBe(false)
		expect(lk.hasStreetName("   ")).toBe(false)
	})

	test("legacy extract (no name_key column) falls back to street_norm", () => {
		const legacyPath = dir.resolve("legacy.db")
		using legacy = new DatabaseClient<StreetCentroidDatabase>(legacyPath)
		legacy.exec("CREATE TABLE street_centroid (street_norm TEXT NOT NULL, postcode TEXT, locality_base TEXT NOT NULL)")

		legacy
			.prepare("INSERT INTO street_centroid (street_norm, postcode, locality_base) VALUES (?, ?, ?)")
			.run(foldStreetSurface("Rue Corsier"), "75001", foldStreetSurface("Paris"))

		using lk = new SQLiteStreetNameLookup(legacyPath)
		expect(lk.hasStreetName("Rue Corsier")).toBe(true)
		expect(lk.hasStreetName("Rue Nonexistent")).toBe(false)
	})

	test("graceful degrade: a tableless db is a no-op miss, not a crash", () => {
		using lk = new SQLiteStreetNameLookup(emptyPath)
		expect(lk.hasStreetName("Rue Corsier")).toBe(false)
	})

	test("countries defaults to FR, upper-cased, and is configurable", () => {
		using fr = new SQLiteStreetNameLookup(dbPath)
		expect(fr.countries.has("FR")).toBe(true)

		using us = new SQLiteStreetNameLookup(dbPath, { countries: ["us"] })
		expect(us.countries.has("US")).toBe(true)
		expect(us.countries.has("FR")).toBe(false)
	})
})
