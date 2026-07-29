/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the coverage-manifest drawer (survey candidate #2). Three obligations:
 *
 *   1. BYTE-IDENTITY of the measured record vs the code constants it supersedes — the safelist
 *        derived from {@link MEASURED_COUNTRY_COVERAGE} must equal `HARD_PLACE_COUNTRY_SAFELIST`, and
 *        {@link MEASURED_COUNTRY_BBOXES} must equal `COUNTRY_BBOX`, so a rebuilt artifact behaves
 *        exactly like the constants until a promote deliberately grows the record.
 *   2. ROUND-TRIP through a real candidate build: emit → read → `WOFCandidateTableLookup` exposes
 *        `artifactCoverage`; a legacy DB (no manifest) reads `undefined` (the constant-fallback signal).
 *   3. MEANING-OF-ZERO: measured-and-failed (FI) is a present row, distinguishable from
 *        never-measured (absent).
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { HARD_PLACE_COUNTRY_SAFELIST, hardCountryFor } from "@mailwoman/core/pipeline"
import { hardCountrySafelistFromCoverage } from "@mailwoman/core/resolver"
import { COUNTRY_BBOX } from "@mailwoman/resolver"
import { readGazetteerCoverageManifest, WOFCandidateTableLookup } from "@mailwoman/resolver-wof-sqlite"
import { buildCandidateTable } from "@mailwoman/resolver-wof-sqlite/build-candidate"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { emitCoverageManifest, MEASURED_COUNTRY_BBOXES, MEASURED_COUNTRY_COVERAGE } from "./coverage-manifest.ts"

let scratch: string

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "mailwoman-coverage-manifest-"))
})

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true }).catch(() => {})
})

/**
 * A minimal admin WOF with the tables `buildCandidateTable` reads (mirrors `build-candidate.test.ts`).
 */
function buildFixtureAdmin(path: string): void {
	const db = new DatabaseSync(path)
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
	db.close()
}

/**
 * Build a real (unsealed) candidate DB in the scratch dir and return its path.
 */
async function buildFixtureCandidate(): Promise<string> {
	const input = join(scratch, "admin.db")
	const output = join(scratch, "candidate.db")
	buildFixtureAdmin(input)
	await buildCandidateTable({ input, output })

	return output
}

describe("byte-identity of the measured record vs the code constants (the fallback contract)", () => {
	test("the derived safelist equals HARD_PLACE_COUNTRY_SAFELIST exactly", () => {
		const derived = hardCountrySafelistFromCoverage(MEASURED_COUNTRY_COVERAGE)

		expect([...derived].toSorted()).toEqual([...HARD_PLACE_COUNTRY_SAFELIST].toSorted())
	})

	test("hardCountryFor answers identically through the constant fallback and the derived safelist, for every measured country", () => {
		const derived = hardCountrySafelistFromCoverage(MEASURED_COUNTRY_COVERAGE)

		for (const fact of MEASURED_COUNTRY_COVERAGE) {
			expect(hardCountryFor(fact.country, 1, {}, true, derived)).toBe(
				hardCountryFor(fact.country, 1, {}, true, undefined)
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
		const candidateDb = await buildFixtureCandidate()
		await emitCoverageManifest({ dbPath: candidateDb })

		const db = new DatabaseSync(candidateDb, { readOnly: true })

		try {
			const manifest = readGazetteerCoverageManifest(db)

			expect(manifest).toBeDefined()
			expect([...manifest!.hardCountrySafelist].toSorted()).toEqual([...HARD_PLACE_COUNTRY_SAFELIST].toSorted())

			// Provenance survives: the GB row carries its panel size + receipt.
			const gb = manifest!.countryCoverage.get("GB")
			expect(gb?.hardFilterSafe).toBe(true)
			expect(gb?.hardResolveRate).toBeCloseTo(0.977, 3)
			expect(gb?.sampleSize).toBe(300)
			expect(gb?.source).toContain("#928")

			// AU recorded a verdict without a single-rate number — nullable columns round-trip as absent.
			const au = manifest!.countryCoverage.get("AU")
			expect(au?.hardFilterSafe).toBe(true)
			expect(au?.hardResolveRate).toBeUndefined()

			// Bboxes round-trip against the constant.
			expect(manifest!.countryBBoxes.size).toBe(Object.keys(COUNTRY_BBOX).length)
			const us = manifest!.countryBBoxes.get("US")
			expect([us?.latMin, us?.latMax, us?.lonMin, us?.lonMax]).toEqual([...COUNTRY_BBOX["US"]!])
		} finally {
			db.close()
		}
	})

	test("meaning-of-zero: measured-and-failed (FI) is present; never-measured (NZ) is absent", async () => {
		const candidateDb = await buildFixtureCandidate()
		await emitCoverageManifest({ dbPath: candidateDb })

		const db = new DatabaseSync(candidateDb, { readOnly: true })

		try {
			const manifest = readGazetteerCoverageManifest(db)!

			// FI: MEASURED and failed the gate — a first-class negative result, off the safelist.
			const fi = manifest.countryCoverage.get("FI")
			expect(fi).toBeDefined()
			expect(fi?.hardFilterSafe).toBe(false)
			expect(fi?.hardResolveRate).toBeCloseTo(0.695, 3)
			expect(manifest.hardCountrySafelist.has("FI")).toBe(false)

			// NZ: never measured — ABSENT, not "failed". The two states must be distinguishable.
			expect(manifest.countryCoverage.has("NZ")).toBe(false)
			expect(manifest.countryCoverage.has("FI")).not.toBe(manifest.countryCoverage.has("NZ"))
		} finally {
			db.close()
		}
	})

	test("WOFCandidateTableLookup exposes artifactCoverage after emission", async () => {
		const candidateDb = await buildFixtureCandidate()
		await emitCoverageManifest({ dbPath: candidateDb })

		const lookup = new WOFCandidateTableLookup({ databasePath: candidateDb })

		try {
			expect(lookup.artifactCoverage).toBeDefined()
			expect([...lookup.artifactCoverage!.hardCountrySafelist].toSorted()).toEqual(
				[...HARD_PLACE_COUNTRY_SAFELIST].toSorted()
			)
		} finally {
			lookup.close()
		}
	})

	test("a legacy candidate DB (no manifest tables) reads undefined — the constant-fallback signal", async () => {
		const candidateDb = await buildFixtureCandidate()

		const db = new DatabaseSync(candidateDb, { readOnly: true })

		try {
			expect(readGazetteerCoverageManifest(db)).toBeUndefined()
		} finally {
			db.close()
		}

		const lookup = new WOFCandidateTableLookup({ databasePath: candidateDb })

		try {
			expect(lookup.artifactCoverage).toBeUndefined()
		} finally {
			lookup.close()
		}
	})
})
