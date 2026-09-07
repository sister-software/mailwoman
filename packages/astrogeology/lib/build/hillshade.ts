/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hillshade build: shade the DEM in its own grid with the body's metres per degree, declare the shaded image
 *   as EPSG:4326 so GDAL tiles it on the XYZ grid, write MBTiles with overviews down to zoom 0, convert to PMTiles.
 *
 *   SHADING HAPPENS BEFORE THE EPSG:4326 LABEL, AND THAT ORDER IS THE CORRECTNESS RULE. `gdaldem` needs to know how
 *   many metres a degree spans to turn a height difference into a slope; on the Moon that is 30,323 m, on Mars
 *   59,158 m, and Earth's 111,320 m would flatten every slope by three to four times. The XYZ tile scheme is angular,
 *   the same lon/lat grid on any sphere, so once the image is shaded the Earth label costs nothing: it only tells GDAL
 *   which grid to cut.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { BODIES, type BuildableBodyID } from "#bodies"

export interface HillshadeBuildOptions {
	body: BuildableBodyID
	demPath: string
	outPath: string
	/**
	 * The deepest zoom the archive carries; overviews run from it down to zoom 0.
	 */
	maxZoom: number
}

/**
 * Sun azimuth and altitude for the shading, the cartographic convention (light from the north-west, 45° up).
 */
const SUN_AZIMUTH_DEGREES = 315
const SUN_ALTITUDE_DEGREES = 45

/**
 * Vertical exaggeration; 1 keeps the DEM's own relief.
 */
const VERTICAL_EXAGGERATION = 1

/**
 * Build a body's hillshade archive. Answers the exact tool invocations, in order, for the manifest.
 */
export async function buildHillshadePMTiles(options: HillshadeBuildOptions): Promise<{ commands: string[][] }> {
	const body = BODIES[options.body]

	await using scratch = await temporaryDirectory("astrogeology-hillshade-")
	const shaded = String(resolvePath(scratch.path, "hillshade.tif"))
	const forTiling = String(resolvePath(scratch.path, "hillshade-4326.tif"))
	const mbtiles = String(resolvePath(scratch.path, "hillshade.mbtiles"))

	// 1. Shade in the source grid, where a degree is the body's arc length; `-s` is metres per degree on this body.
	const shade = [
		"hillshade",
		options.demPath,
		shaded,
		"-s",
		String(body.metresPerDegree),
		"-z",
		String(VERTICAL_EXAGGERATION),
		"-az",
		String(SUN_AZIMUTH_DEGREES),
		"-alt",
		String(SUN_ALTITUDE_DEGREES),
		"-compute_edges",
		"-co",
		"COMPRESS=DEFLATE",
	]

	await runFile("gdaldem", shade)

	// 2. The XYZ tile scheme is angular: the same lon/lat grid on any sphere. Declaring the shaded image as EPSG:4326
	//    makes GDAL tile it on that grid; the metres are Earth's, which is why shading happened before this step.
	const declare = ["-a_srs", "EPSG:4326", shaded, forTiling]

	await runFile("gdal_translate", declare)

	// 3. MBTiles with PNG tiles at the deepest zoom, then overviews down to zoom 0, then PMTiles.
	const tile = [
		"-of",
		"MBTILES",
		"-co",
		"TILE_FORMAT=PNG",
		"-co",
		"ZOOM_LEVEL_STRATEGY=LOWER",
		"-co",
		`MAXZOOM=${options.maxZoom}`,
		forTiling,
		mbtiles,
	]

	await runFile("gdal_translate", tile)

	// GDAL lands the tiles at the zoom the source resolution supports, capped by MAXZOOM; overviews run from that zoom
	// down to 0, and a source that lands at 0 has nothing to average.
	const zoom = await readMBTilesZoom(mbtiles)
	const overviews = ["-r", "average", mbtiles, ...Array.from({ length: zoom }, (_, index) => String(2 ** (index + 1)))]

	if (zoom > 0) {
		await runFile("gdaladdo", overviews)
	}

	const convert = ["convert", mbtiles, options.outPath]

	await runFile("pmtiles", convert)

	return {
		commands: [
			["gdaldem", ...shade],
			["gdal_translate", ...declare],
			["gdal_translate", ...tile],
			...(zoom > 0 ? [["gdaladdo", ...overviews]] : []),
			["pmtiles", ...convert],
		],
	}
}

/**
 * The zoom level an MBTiles dataset was written at, from GDAL's `ZOOM_LEVEL` metadata item.
 */
async function readMBTilesZoom(mbtiles: string): Promise<number> {
	const { stdout } = await runFile("gdalinfo", ["-json", mbtiles])
	const info = parseJSONStrict<{ metadata?: { ""?: { ZOOM_LEVEL?: string } } }>(stdout)
	const zoom = Number(info.metadata?.[""]?.ZOOM_LEVEL)

	if (!Number.isInteger(zoom) || zoom < 0) {
		throw new Error(`${mbtiles}: gdalinfo reports no ZOOM_LEVEL for the MBTiles dataset`)
	}

	return zoom
}
