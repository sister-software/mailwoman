/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #920 — the GeoNames postal fold's two laws, as tests: (1) the name law (stored names match the
 *   sanitized-query token shape — spaced CZ and dashed PL forms measured broken/worse in the
 *   night-31 experiment), (2) medoid centroids (the member point, never an off-settlement mean —
 *   the p50-tax law).
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { describe, expect, it } from "vitest"

import { GEONAMES_POSTAL_ID_BASE, ingestGeonamesPostal, normalizePostcodeName } from "./geonames-postal.ts"

describe("normalizePostcodeName (the #920 name law)", () => {
	it("strips the spaced CZ/SK form to the query-token shape", () => {
		expect(normalizePostcodeName("110 00")).toBe("11000")
	})

	it("strips the dashed PL form", () => {
		expect(normalizePostcodeName("11-041")).toBe("11041")
	})

	it("keeps plain alphanumerics whole", () => {
		expect(normalizePostcodeName("8281")).toBe("8281")
		expect(normalizePostcodeName("AD500")).toBe("AD500")
	})
})

function fixtureDB(): DatabaseSync {
	const db = new DatabaseSync(":memory:")
	db.exec(`
		CREATE TABLE spr (
			id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL DEFAULT -1, name TEXT NOT NULL DEFAULT '',
			placetype TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
			latitude REAL NOT NULL DEFAULT 0, longitude REAL NOT NULL DEFAULT 0,
			min_latitude REAL NOT NULL DEFAULT 0, min_longitude REAL NOT NULL DEFAULT 0,
			max_latitude REAL NOT NULL DEFAULT 0, max_longitude REAL NOT NULL DEFAULT 0,
			is_current INTEGER NOT NULL DEFAULT 1, is_deprecated INTEGER NOT NULL DEFAULT 0,
			is_ceased INTEGER NOT NULL DEFAULT 0, is_superseded INTEGER NOT NULL DEFAULT 0,
			is_superseding INTEGER NOT NULL DEFAULT 0, lastmodified INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE names (id INTEGER NOT NULL, name TEXT, placetype TEXT, country TEXT, language TEXT, lastmodified INTEGER);
	`)

	return db
}

describe("ingestGeonamesPostal", () => {
	it("folds one medoid row per normalized code, with the display form as an alt name", () => {
		const dir = mkdtempSync(join(tmpdir(), "gn-postal-"))
		// Three members of "110 00": two clustered at ~50.08, one outlier pulling the mean north.
		// The medoid must be one of the REAL points (the cluster member nearest the mean), never
		// the mean itself.
		writeFileSync(
			join(dir, "CZ.txt"),
			[
				"CZ\t110 00\tPraha 1\tPraha\t10\t\t\t\t\t50.08\t14.42\t4",
				"CZ\t110 00\tPraha 1-x\tPraha\t10\t\t\t\t\t50.09\t14.43\t4",
				"CZ\t110 00\tOutlier\tPraha\t10\t\t\t\t\t50.30\t14.60\t4",
				"CZ\t500 02\tHradec\tKralovehradecky\t\t\t\t\t\t50.21\t15.83\t4",
			].join("\n"),
			"utf8"
		)
		const db = fixtureDB()
		const result = ingestGeonamesPostal(db, ["CZ"], dir)

		expect(result.inserted).toBe(2)
		expect(result.byCountry.CZ).toBe(2)

		const row = db.prepare("SELECT id, name, placetype, latitude, longitude FROM spr WHERE name = '11000'").get() as {
			id: number
			name: string
			placetype: string
			latitude: number
			longitude: number
		}

		expect(row.placetype).toBe("postalcode")
		expect(row.id).toBeGreaterThanOrEqual(GEONAMES_POSTAL_ID_BASE)
		// Medoid = a real member (50.09 is nearest the outlier-pulled mean), NOT the mean (~50.157).
		expect([50.08, 50.09, 50.3]).toContain(row.latitude)
		expect(row.latitude).toBe(50.09)

		const names = db
			.prepare("SELECT name FROM names WHERE id = ? ORDER BY name")
			.all(row.id)
			.map((r) => (r as { name: string }).name)

		expect(names).toEqual(["110 00", "11000"])
	})

	it("reports missing country files instead of throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "gn-postal-empty-"))
		const db = fixtureDB()
		const result = ingestGeonamesPostal(db, ["FI"], dir)

		expect(result.inserted).toBe(0)
		expect(result.missing).toEqual(["FI"])
	})
})
