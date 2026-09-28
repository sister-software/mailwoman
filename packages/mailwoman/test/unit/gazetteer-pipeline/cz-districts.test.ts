/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale checks for Prague districts: name selection, A-feature preference, plus license terms.
 *   The artifact records its terms in `database_meta` and `layer_manifest`.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { type layerschemadatabase, LayerTier, readLayerManifest } from "@mailwoman/core/layers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildCZDistrictsDatabase } from "mailwoman/gazetteer-pipeline/cz-districts"
import { afterAll, beforeAll, expect, test } from "vitest"

let root: TemporaryDirectory

/**
 * A GeoNames places row: geonameid, name, asciiname, alternatenames, lat, lon, feature class, feature code.
 */
function row(id: number, name: string, lat: number, lon: number, featureClass: string, featureCode: string): string {
	return [id, name, name, "", lat, lon, featureClass, featureCode].join("\t")
}

beforeAll(async () => {
	root = await temporaryDirectory("cz-districts-")

	await writeLocalTextFile(
		[
			row(1, "Praha 1", 50.08, 14.42, "P", "PPLX"),
			// The administrative row for the same name wins over the populated-place duplicate.
			row(2, "Praha 1", 50.09, 14.43, "A", "ADM3"),
			row(3, "Praha 9", 50.11, 14.5, "A", "ADM3"),
			row(4, "Brno", 49.19, 16.6, "P", "PPLA"),
		].join("\n"),
		root.path("CZ.txt")
	)
})

afterAll(() => root[Symbol.asyncDispose]())

test("buildCZDistrictsDatabase: one row per district, and the artifact states its terms in both tables", async () => {
	const out = root.path("localities-cz-districts.db").toString()

	const result = await buildCZDistrictsDatabase({ sourcePath: root.path("CZ.txt").toString(), out })

	expect(result.inserted).toBe(2)

	using db = new DatabaseClient<layerschemadatabase>(out, { readOnly: true })

	const praha1 = db.prepare("SELECT latitude FROM spr WHERE name = 'Praha 1'").get() as { latitude: number }

	expect(praha1.latitude).toBe(50.09)

	const meta = db.prepare("SELECT value FROM database_meta WHERE key = 'license'").get() as { value: string }

	// The table has used this license text since the first build.
	// `readLicenseRecord` resolves it.
	expect(meta.value).toBe("CC-BY-4.0, attribution GeoNames")

	const manifest = await readLayerManifest(db)

	expect(manifest.name).toBe("localities-cz-districts")
	expect(manifest.tier).toBe(LayerTier.Shipped)
	expect(manifest.license).toBe("CC-BY-4.0")
	expect(manifest.attribution).toBe("GeoNames")
	expect(manifest.sourceVintage).toBe(`md5 ${result.sourceMD5}`)
	expect(manifest.spineKeys).toEqual({ wofID: "id" })
})
