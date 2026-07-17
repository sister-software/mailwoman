/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link SQLiteStreetNameLookup} (#727 phase-4c FR backend) against a fixture DB built
 *   with the contract fold (`foldStreetSurface`). Covers unscoped + scoped lookups, the fold
 *   contract (hyphen/apostrophe), positive-evidence fallback, and graceful degrade on a tableless db.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { foldStreetSurface } from "@mailwoman/resolver"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { SQLiteStreetNameLookup } from "./street-name-lookup.ts"

let dir: string
let dbPath: string
let emptyPath: string

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "mw-street-name-"))
	dbPath = join(dir, "street-centroids-fr.db")
	const seed = new DatabaseSync(dbPath)
	// The real shard shape: the geocoding `street_norm` PLUS the #727 phase-4c `name_key` (contract fold). The reader must
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
	seed.close()

	emptyPath = join(dir, "empty.db")
	const empty = new DatabaseSync(emptyPath)
	empty.exec("CREATE TABLE unrelated (x)")
	empty.close()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("SQLiteStreetNameLookup", () => {
	test("unscoped hit on an existing street name", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Corsier")).toBe(true)
		expect(lk.hasStreetName("Rue Guarnieri")).toBe(true)
		lk.close()
	})

	test("miss on a street not in the index (positive evidence only)", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Nonexistent")).toBe(false)
		lk.close()
	})

	test("fold contract: a hyphenated/apostrophe'd query matches the folded index entry", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Pillet-Will")).toBe(true) // hyphen → space, matches "rue pillet will"
		expect(lk.hasStreetName("Chemin d'En Galinier")).toBe(true) // apostrophe → space
		lk.close()
	})

	test("scoped lookup by locality hits when the pair exists", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Corsier", { locality: "Paris" })).toBe(true)
		lk.close()
	})

	test("scoped miss falls back to the unscoped probe (scope incompleteness ≠ absence)", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		// Right street, wrong locality → the scoped probe misses, but the unscoped fallback confirms the name exists.
		expect(lk.hasStreetName("Rue Corsier", { locality: "Lyon" })).toBe(true)
		lk.close()
	})

	test("scoped lookup by postcode", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("Rue Corsier", { postcode: "75001" })).toBe(true)
		lk.close()
	})

	test("empty street surface is a miss", () => {
		const lk = new SQLiteStreetNameLookup(dbPath)
		expect(lk.hasStreetName("")).toBe(false)
		expect(lk.hasStreetName("   ")).toBe(false)
		lk.close()
	})

	test("legacy shard (no name_key column) falls back to street_norm", () => {
		const legacyPath = join(dir, "legacy.db")
		const legacy = new DatabaseSync(legacyPath)
		legacy.exec("CREATE TABLE street_centroid (street_norm TEXT NOT NULL, postcode TEXT, locality_base TEXT NOT NULL)")
		legacy
			.prepare("INSERT INTO street_centroid (street_norm, postcode, locality_base) VALUES (?, ?, ?)")
			.run(foldStreetSurface("Rue Corsier"), "75001", foldStreetSurface("Paris"))
		legacy.close()
		const lk = new SQLiteStreetNameLookup(legacyPath)
		expect(lk.hasStreetName("Rue Corsier")).toBe(true)
		expect(lk.hasStreetName("Rue Nonexistent")).toBe(false)
		lk.close()
	})

	test("graceful degrade: a tableless db is a no-op miss, not a crash", () => {
		const lk = new SQLiteStreetNameLookup(emptyPath)
		expect(lk.hasStreetName("Rue Corsier")).toBe(false)
		lk.close()
	})

	test("countries defaults to FR, upper-cased, and is configurable", () => {
		expect(new SQLiteStreetNameLookup(dbPath).countries.has("FR")).toBe(true)
		const us = new SQLiteStreetNameLookup(dbPath, { countries: ["us"] })
		expect(us.countries.has("US")).toBe(true)
		expect(us.countries.has("FR")).toBe(false)
	})
})
