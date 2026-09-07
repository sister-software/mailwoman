/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The whole build chain over tiny fixtures with no network: five Moon rows through normalization, NDJSON, tippecanoe
 *   and the metadata block; a synthetic DEM through gdaldem, the MBTiles writer, overviews and PMTiles. The tools
 *   (`tippecanoe`, `pmtiles`, GDAL) are the lab's; a missing one fails with its name in the error.
 *
 *   `fixtures/dem-fixture.tif` was written once with GDAL's Python bindings: 1024×512 Int16 over the whole globe in
 *   EPSG:4326, DEFLATE-compressed, elevation `sin(row·π/8) · (row / 511) · 30000` metres. At the Moon's 30 km per row
 *   that is near-flat ground in the north and slopes near 45° in the south, so the hillshade shows relief and its two
 *   z1 halves differ; 1024 pixels across lands the MBTiles step at zoom 2, where overviews have something to average.
 */

import { buildHillshadePMTiles } from "@mailwoman/astrogeology/build/hillshade"
import {
	applyPMTilesMetadata,
	hillshadeMetadata,
	nomenclatureMetadata,
	readMailwomanMetadata,
} from "@mailwoman/astrogeology/build/metadata"
import {
	buildNomenclaturePMTiles,
	minZoomForDiameter,
	writeNomenclatureNDJSON,
} from "@mailwoman/astrogeology/build/nomenclature"
import { featureFromSourceRow, type NomenclatureSourceRow } from "@mailwoman/astrogeology/normalize"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { expect, test } from "vitest"

const fixturePath = (name: string): string => resolvePackagePath("@mailwoman/astrogeology", "test", "fixtures", name)

test("minZoomForDiameter declutters by size", () => {
	expect(minZoomForDiameter(610.13)).toBe(0)
	expect(minZoomForDiameter(154.084)).toBe(2)
	expect(minZoomForDiameter(85.29377)).toBe(4)
	expect(minZoomForDiameter(24.033133)).toBe(6)
	expect(minZoomForDiameter(4.6)).toBe(8)
	expect(minZoomForDiameter(0)).toBe(2)
	expect(minZoomForDiameter(undefined)).toBe(2)
})

test("the Moon fixture builds a nomenclature archive whose tiles carry the five features", async () => {
	await using scratch = await temporaryDirectory("astrogeology-test-")
	const ndjson = resolvePath(scratch.path, "moon.ndjson")
	const out = resolvePath(scratch.path, "moon.pmtiles")

	const rows = await Array.fromAsync(
		JSONSpliterator.fromAsync<NomenclatureSourceRow>(fixturePath("moon-nomenclature.ndjson"))
	)

	const features = rows.map((row) => featureFromSourceRow("moon", row))

	expect(features).toHaveLength(5)
	// Marco Polo P straddles the prime meridian: the box stays narrow after the 360 wrap.
	expect(features[0]?.bbox?.minLon).toBeCloseTo(-0.8023, 4)
	expect(features[0]?.bbox?.maxLon).toBeCloseTo(0.1643, 4)

	expect(await writeNomenclatureNDJSON(features, String(ndjson))).toBe(5)

	const { command } = await buildNomenclaturePMTiles({ body: "moon", ndjsonPath: String(ndjson), outPath: String(out) })

	expect(command[0]).toBe("tippecanoe")

	await applyPMTilesMetadata(String(out), nomenclatureMetadata("moon", "test"))

	const metadata = await readMailwomanMetadata(String(out))

	expect(metadata["mailwoman:body"]).toBe("moon")
	expect(metadata["mailwoman:schema"]).toBe("planetary-v1")
	expect(metadata["mailwoman:build_version"]).toBe("test")

	// Tycho at z4: the XYZ tile holding lon −11.2153, lat −43.2958 is x = 7, y = 10.
	const tile = await runFile("pmtiles", ["tile", String(out), "4", "7", "10"])

	expect(tile.stdout.length).toBeGreaterThan(0)
})

/**
 * `runFile` decodes a tool's output as UTF-8, so the PNG signature's first byte (0x89) reads as the replacement
 * character and the seven bytes after it survive verbatim; that is enough to tell a PNG from anything else.
 */
const PNG_SIGNATURE_AS_UTF8 = "�PNG\r\n\n"

test("the fixture DEM builds a hillshade archive of PNG tiles with relief", async () => {
	await using scratch = await temporaryDirectory("astrogeology-test-")
	const out = resolvePath(scratch.path, "hillshade.pmtiles")

	const { commands } = await buildHillshadePMTiles({
		body: "moon",
		demPath: fixturePath("dem-fixture.tif"),
		outPath: String(out),
		maxZoom: 2,
	})

	expect(commands.map((command) => command[0])).toEqual([
		"gdaldem",
		"gdal_translate",
		"gdal_translate",
		"gdaladdo",
		"pmtiles",
	])

	await applyPMTilesMetadata(String(out), hillshadeMetadata("moon", "test", "dem-fixture.tif"))
	expect((await readMailwomanMetadata(String(out)))["mailwoman:kind"]).toBe("planetary-hillshade")

	const root = await runFile("pmtiles", ["tile", String(out), "0", "0", "0"])

	expect(root.stdout.startsWith(PNG_SIGNATURE_AS_UTF8)).toBe(true)

	// The fixture's slope grows from north to south, so the two northern z1 tiles shade differently from the southern.
	const north = await runFile("pmtiles", ["tile", String(out), "1", "0", "0"])
	const south = await runFile("pmtiles", ["tile", String(out), "1", "0", "1"])

	expect(north.stdout.startsWith(PNG_SIGNATURE_AS_UTF8)).toBe(true)
	expect(north.stdout).not.toBe(south.stdout)
})
