/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale guard for the GeoNames-postal tail reproducer. The real gate is per-country row-count
 *   parity against the frozen 946 MB artifact (see the module docstring); this holds the three things
 *   that gate cannot express cheaply — the #920 name law survives a rebuild, a country with no dump is
 *   REPORTED rather than silently zeroed, and the provenance `meta` table actually reaches the sealed
 *   artifact carrying source md5s.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { afterAll, beforeAll, expect, test } from "vitest"

import { buildPostcodeGeonamesTail, DEFAULT_GEONAMES_TAIL_COUNTRIES } from "./geonames-tail.ts"

let root: string
let postalDir: string

/**
 * A GeoNames postal row: country, postcode, place, admin1, code1, admin2, code2, admin3, code3, lat, lon, accuracy.
 */
function row(cc: string, postcode: string, place: string, lat: number, lon: number): string {
	return [cc, postcode, place, "R", "R1", "", "", "", "", String(lat), String(lon), "6"].join("\t")
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "geonames-tail-"))
	postalDir = join(root, "geonames-postal")
	mkdirSync(postalDir, { recursive: true })

	// CZ: one code written in the SPACED display form, across three settlements — exercises both #920
	// laws at once (normalization to `11000`, and a medoid that must land ON one of the three points).
	writeFileSync(
		join(postalDir, "CZ.txt"),
		[
			row("CZ", "110 00", "Praha 1", 50.1, 14.1),
			row("CZ", "110 00", "Stare Mesto", 50.2, 14.2),
			row("CZ", "110 00", "Josefov", 50.4, 14.4),
			row("CZ", "120 00", "Vinohrady", 50.07, 14.44),
		].join("\n") + "\n"
	)

	// PL: the dashed display form.
	writeFileSync(join(postalDir, "PL.txt"), row("PL", "11-041", "Olsztyn", 53.8, 20.4) + "\n")
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

test("buildPostcodeGeonamesTail: #920 laws survive a rebuild, and a missing dump is reported", async () => {
	const out = join(root, "tail.db")

	const result = await buildPostcodeGeonamesTail({
		countries: ["CZ", "PL", "ZZ"],
		postalDir,
		out,
		now: new Date("2026-08-05T00:00:00.000Z"),
	})

	expect(result.inserted).toBe(3)
	expect(result.byCountry).toEqual({ CZ: 2, PL: 1 })
	// The meaning-of-zero rule: a country with no dump is a NAMED absence, not a zero row.
	expect(result.missing).toEqual(["ZZ"])
	expect(result.sources.map((s) => s.country)).toEqual(["CZ", "PL"])
	expect(result.sources.every((s) => /^[0-9a-f]{32}$/.test(s.md5))).toBe(true)
	// Sealed 0444 — the artifact is read-only from the moment it exists (mode bits, not accessSync:
	// root ignores the permission and would pass a W_OK probe on a sealed file).
	expect(statSync(out).mode & 0o222).toBe(0)

	const db = new DatabaseSync(out, { readOnly: true })

	// Name law: `spr.name` is the sanitized-query token shape; the display form is an alt `names` row.
	const names = db.prepare("SELECT name FROM spr WHERE country='CZ' ORDER BY name").all() as Array<{ name: string }>
	expect(names.map((n) => n.name)).toEqual(["11000", "12000"])

	const alt = db.prepare("SELECT COUNT(*) AS n FROM names WHERE name = '110 00'").get() as { n: number }
	expect(alt.n).toBe(1)

	const spaced = db.prepare("SELECT COUNT(*) AS n FROM spr WHERE name = '110 00'").get() as { n: number }
	expect(spaced.n).toBe(0)

	// Medoid law: the centroid is one of the three member points — here 50.2/14.2, the one nearest the
	// (50.2333, 14.2333) mean, which is itself not a member. A mean-of-members build would store the
	// mean and put the postcode on no settlement at all.
	const cz = db.prepare("SELECT latitude, longitude FROM spr WHERE country='CZ' AND name='11000'").get() as {
		latitude: number
		longitude: number
	}

	expect([
		[50.1, 14.1],
		[50.2, 14.2],
		[50.4, 14.4],
	]).toContainEqual([cz.latitude, cz.longitude])

	// Every place is searchable and has an ancestors self-row (the parent-constraint subquery reads it).
	const fts = db.prepare("SELECT COUNT(*) AS n FROM place_search").get() as { n: number }
	expect(fts.n).toBe(3)
	const anc = db.prepare("SELECT COUNT(*) AS n FROM ancestors").get() as { n: number }
	expect(anc.n).toBe(3)

	// Provenance travels IN the artifact — the licence obligation the frozen shard never carried.
	const meta = new Map(
		(db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((r) => [
			r.key,
			r.value,
		])
	)

	expect(meta.get("built_at")).toBe("2026-08-05T00:00:00.000Z")
	expect(meta.get("countries")).toBe("CZ,PL,ZZ")
	expect(meta.get("license")).toContain("CC-BY 4.0")
	expect(meta.get("license_gb")).toContain("Open Government Licence v3")
	expect(parseJSONStrict<unknown[]>(meta.get("source_files")!)).toHaveLength(2)

	db.close()
})

test("DEFAULT_GEONAMES_TAIL_COUNTRIES: the frozen artifact's ten, in its ingest order", () => {
	// Order is recovered from the frozen shard's per-country spr.id ranges and is what makes a rebuild
	// id-comparable to it. GB last, and PRESENT — the docstrings that said eight or nine were wrong.
	expect([...DEFAULT_GEONAMES_TAIL_COUNTRIES]).toEqual(["FI", "CZ", "SK", "SI", "DK", "NO", "HR", "PL", "SE", "GB"])
})
