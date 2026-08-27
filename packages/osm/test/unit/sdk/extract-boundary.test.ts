/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit cover for {@link buildBoundarySQL} — the OGRSQL string builder. No `ogr2ogr` is spawned; the
 *   extraction itself needs a real `.osm.pbf` and GDAL on the path.
 */

import { buildBoundarySQL, extractOSMBoundary } from "@mailwoman/osm/sdk/extract-boundary"
import { expect, test } from "vitest"

test("buildBoundarySQL: pins boundary, admin_level and name", () => {
	expect(buildBoundarySQL({ name: "Berlin", adminLevel: "4" })).toBe(
		"SELECT osm_id, name, admin_level FROM multipolygons " +
			"WHERE boundary='administrative' AND admin_level='4' AND name='Berlin'"
	)
})

test("buildBoundarySQL: carries a name with diacritics through unchanged", () => {
	expect(buildBoundarySQL({ name: "Île-de-France", adminLevel: "4" })).toContain("name='Île-de-France'")
})

test("buildBoundarySQL: doubles an apostrophe rather than closing the literal", () => {
	expect(buildBoundarySQL({ name: "Provence-Alpes-Côte d'Azur", adminLevel: "4" })).toContain(
		"name='Provence-Alpes-Côte d''Azur'"
	)
})

test("buildBoundarySQL: rejects a hostile name", () => {
	expect(() => buildBoundarySQL({ name: "x'; DROP TABLE multipolygons; --", adminLevel: "4" })).toThrow(
		/place-name allowlist/
	)
})

test("buildBoundarySQL: rejects a non-numeric admin level", () => {
	expect(() => buildBoundarySQL({ name: "Berlin", adminLevel: "4 OR 1=1" })).toThrow(/1-2 digits/)
})

test("extractOSMBoundary: refuses a hostile query before ever spawning ogr2ogr", async () => {
	await expect(extractOSMBoundary("/nonexistent.pbf", { name: "x';--", adminLevel: "4" })).rejects.toThrow(
		/place-name allowlist/
	)
})
