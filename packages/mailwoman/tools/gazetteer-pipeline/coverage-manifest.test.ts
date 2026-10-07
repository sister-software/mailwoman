/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the coverage-manifest drawer. The derived safelist and bboxes must match the code
 *   constants they supersede, so a rebuilt artifact behaves exactly like the constants until a
 *   promote grows the record. A round trip through a real candidate build exposes `artifactCoverage`,
 *   while a legacy database without manifest tables reads `undefined`, the constant-fallback signal.
 *   A measured-and-failed country is a present row that stays distinguishable from a never-measured
 *   one.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { HARD_PLACE_COUNTRY_SAFELIST, hardCountryFor } from "@mailwoman/core/pipeline"
import { hardCountrySafelistFromCoverage } from "@mailwoman/core/resolver"
import { COUNTRY_BBOX } from "@mailwoman/resolver"
import { readGazetteerCoverageManifest, WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build/candidate"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { emitCoverageManifest, MEASURED_COUNTRY_BBOXES, MEASURED_COUNTRY_COVERAGE } from "#gazetteer/coverage-manifest"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("mailwoman-coverage-manifest-")
})

afterEach(async () => {
	await scratch[Symbol.asyncDispose]()
})

/**
 * A minimal admin WOF with the tables `buildCandidateTable` reads (mirrors `build-candidate.test.ts`).
 */
function buildFixtureAdmin(path: PathBuilderLike): void {
	using db = new DatabaseClient<WOFDatabase>(path)

	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, name TEXT, placetype TEXT, country TEXT,
			latitude REAL, longitude REAL,
			min_latitude REAL, min_longitude REAL, max_latitude REAL, max_longitude REAL,
			is_current INTEGER, is_deprecated INTEGER
		);
		CREATE TABLE place_population (id INTEGER PRIMARY KEY, population INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT);
		CREATE TABLE place_abbr (id INTEGER PRIMARY KEY, abbr TEXT);
		CREATE TABLE ancestors (id INTEGER, ancestor_id INTEGER, ancestor_placetype TEXT);
		INSERT INTO spr VALUES (200, 'Chicago', 'locality', 'US', 41.88, -87.63, 41.6, -87.9, 42.0, -87.5, -1, 0);
		INSERT INTO place_population VALUES (200, 2700000);
	`)
}

/**
 * Build a real (unsealed) candidate database in the scratch directory and return its path.
 */
async function buildFixtureCandidate(): Promise<PathBuilderLike> {
	const input = scratch.path("admin.db")
	const output = scratch.path("candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output })

	return output
}

describe("byte-identity of the measured record vs the code constants (the fallback interface)", () => {
	test("the derived safelist equals HARD_PLACE_COUNTRY_SAFELIST exactly", () => {
		const derived = hardCountrySafelistFromCoverage(MEASURED_COUNTRY_COVERAGE)

		expect([...derived].toSorted()).toEqual([...HARD_PLACE_COUNTRY_SAFELIST].toSorted())
	})

	test("hardCountryFor answers identically through the constant fallback and the derived safelist, for every measured country", () => {
		const derived = hardCountrySafelistFromCoverage(MEASURED_COUNTRY_COVERAGE)

		for (const fact of MEASURED_COUNTRY_COVERAGE) {
			const placed = { country: fact.country, confidence: 1 }

			expect(hardCountryFor(placed, {}, { use: "filter", safelist: derived })).toBe(
				hardCountryFor(placed, {}, { use: "filter", safelist: null })
			)
		}
	})

	test("the measured bboxes equal COUNTRY_BBOX exactly (same countries, same numbers)", () => {
		expect(MEASURED_COUNTRY_BBOXES.map((f) => f.country).toSorted()).toEqual(Object.keys(COUNTRY_BBOX).toSorted())

		for (const fact of MEASURED_COUNTRY_BBOXES) {
			expect([fact.latMin, fact.latMax, fact.lonMin, fact.lonMax], fact.country).toEqual([
				...COUNTRY_BBOX[fact.country]!,
			])
		}
	})
})

describe("emit → read round-trip through a real candidate build", () => {
	test("the emitted manifest reads back with the derived safelist, rates, and bboxes intact", async () => {
		const candidateDB = await buildFixtureCandidate()
		await emitCoverageManifest({ dbPath: candidateDB })

		using db = new DatabaseClient<WOFDatabase>(candidateDB, { readOnly: true })

		const manifest = readGazetteerCoverageManifest(db)

		expect(manifest).toBeDefined()
		expect([...manifest!.hardCountrySafelist].toSorted()).toEqual([...HARD_PLACE_COUNTRY_SAFELIST].toSorted())

		const gb = manifest!.countryCoverage.get("GB")
		expect(gb?.hardFilterSafe).toBe(true)
		expect(gb?.hardResolveRate).toBeCloseTo(0.977, 3)
		expect(gb?.sampleSize).toBe(300)
		expect(gb?.source).toContain("#928")

		const au = manifest!.countryCoverage.get("AU")
		expect(au?.hardFilterSafe).toBe(true)
		expect(au?.hardResolveRate).toBeNull()

		expect(manifest!.countryBBoxes.size).toBe(Object.keys(COUNTRY_BBOX).length)
		const us = manifest!.countryBBoxes.get("US")
		expect([us?.latMin, us?.latMax, us?.lonMin, us?.lonMax]).toEqual([...COUNTRY_BBOX["US"]!])
	})

	test("meaning-of-zero: measured-and-failed (FI) is present; never-measured (NZ) is absent", async () => {
		const candidateDB = await buildFixtureCandidate()
		await emitCoverageManifest({ dbPath: candidateDB })

		using db = new DatabaseClient<WOFDatabase>(candidateDB, { readOnly: true })

		const manifest = readGazetteerCoverageManifest(db)!

		// FI is measured and failed the check, so it is a present row that stays off the safelist.
		const fi = manifest.countryCoverage.get("FI")
		expect(fi).toBeDefined()
		expect(fi?.hardFilterSafe).toBe(false)
		expect(fi?.hardResolveRate).toBeCloseTo(0.695, 3)
		expect(manifest.hardCountrySafelist.has("FI")).toBe(false)

		// NZ is never measured, so it is absent rather than failed.
		// The two states must be distinguishable.
		expect(manifest.countryCoverage.has("NZ")).toBe(false)
		expect(manifest.countryCoverage.has("FI")).not.toBe(manifest.countryCoverage.has("NZ"))
	})

	test("WOFCandidateTableLookup exposes artifactCoverage after emission", async () => {
		const candidateDB = await buildFixtureCandidate()
		await emitCoverageManifest({ dbPath: candidateDB })

		using lookup = new WOFCandidateTableLookup({ databasePath: candidateDB })

		expect(lookup.artifactCoverage).toBeDefined()

		expect([...lookup.artifactCoverage!.hardCountrySafelist].toSorted()).toEqual(
			[...HARD_PLACE_COUNTRY_SAFELIST].toSorted()
		)
	})

	test("a legacy candidate DB (no manifest tables) reads null — the constant-fallback signal", async () => {
		const candidateDB = await buildFixtureCandidate()

		using db = new DatabaseClient<WOFDatabase>(candidateDB, { readOnly: true })

		expect(readGazetteerCoverageManifest(db)).toBeNull()

		using lookup = new WOFCandidateTableLookup({ databasePath: candidateDB })

		expect(lookup.artifactCoverage).toBeNull()
	})
})
