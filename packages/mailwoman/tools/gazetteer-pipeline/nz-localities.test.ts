/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture-scale checks for the NZ locality database: the thin-group floor, sealed artifact, plus license terms.
 *   The artifact records its terms in `database_meta` and `layer_manifest`.
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/hash"
import { type layerschemadatabase, LayerTier, readLayerManifest } from "@mailwoman/core/layers"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, beforeAll, expect, test } from "vitest"

import { buildNZLocalitiesDatabase } from "#gazetteer/nz-localities"

let root: TemporaryDirectory

const HEADER = "LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH"

function row(lon: number, lat: number, city: string, district: string, index: number): string {
	return `${lon},${lat},${index},Beach Road,,${city},${district},Auckland,0932,${index},h${index}`
}

beforeAll(async () => {
	root = await temporaryDirectory("nz-localities-")

	const rows = [
		HEADER,
		// Five points make the floor, so Stanmore Bay earns a row.
		...[0, 1, 2, 3, 4].map((i) => row(174.71 + i / 1000, -36.51 - i / 1000, "Stanmore Bay", "Rodney", i)),
		// Two points sit under it, so this group is skipped and counted.
		row(174.9, -36.9, "Thin Place", "Rodney", 10),
		row(174.91, -36.91, "Thin Place", "Rodney", 11),
	]

	const csvPath = root.path("countrywide.csv")

	await writeLocalTextFile(`${rows.join("\n")}\n`, csvPath)
	await writeLocalTextFile(`${md5Hex(await readLocalBuffer(csvPath))}  countrywide.csv\n`, `${csvPath}.md5`)
})

afterAll(() => root[Symbol.asyncDispose]())

test("buildNZLocalitiesDatabase: the floor holds and the artifact states its terms in both tables", async () => {
	const out = root.path("localities-nz-linz.db")

	const result = await buildNZLocalitiesDatabase({ csvPath: root.path("countrywide.csv"), out })

	expect(result.inserted).toBe(1)
	expect(result.skippedGroups).toBe(1)

	using db = new DatabaseClient<layerschemadatabase>(out, { readOnly: true })

	const meta = db.prepare("SELECT value FROM database_meta WHERE key = 'license'").get() as { value: string }

	// The table has used this license text since the first build.
	// `readLicenseRecord` resolves it.
	expect(meta.value).toBe("CC-BY-4.0, attribution Land Information New Zealand")

	const manifest = await readLayerManifest(db)

	expect(manifest.name).toBe("localities-nz-linz")
	expect(manifest.tier).toBe(LayerTier.Shipped)
	expect(manifest.license).toBe("CC-BY-4.0")
	expect(manifest.attribution).toBe("Land Information New Zealand")
	expect(manifest.sourceVintage).toContain(result.sourceMD5)
	expect(manifest.spineKeys).toEqual({ wofID: "id" })
})
