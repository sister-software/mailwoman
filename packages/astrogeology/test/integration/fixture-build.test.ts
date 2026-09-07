/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The whole build chain over tiny fixtures with no network: five Moon rows through normalization, NDJSON, tippecanoe
 *   and the metadata block. The tools (`tippecanoe`, `pmtiles`, GDAL) are the lab's; a missing one fails with its
 *   name in the error.
 */

import {
	applyPMTilesMetadata,
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
