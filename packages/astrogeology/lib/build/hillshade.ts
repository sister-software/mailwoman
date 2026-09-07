/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hillshade build: shade the DEM in its own grid with the body's metres per degree, declare the shaded image
 *   as EPSG:4326 so GDAL tiles it on the XYZ grid, write MBTiles with overviews down to zoom 0, convert to PMTiles.
 *
 *   SHADING HAPPENS BEFORE THE EPSG:4326 LABEL, AND THAT ORDER IS THE CORRECTNESS RULE. `gdaldem` needs the ratio of
 *   the height unit to the grid unit to turn a height difference into a slope. The USGS mosaics are equirectangular
 *   grids in the body's own metres, so that ratio is 1; a grid in degrees (the fixture) needs the body's metres per
 *   degree, 30,323 m on the Moon and 59,158 m on Mars, and Earth's 111,320 m would flatten every slope by three to
 *   four times. The build reads the grid's unit from the file rather than assuming either. The XYZ tile scheme is
 *   angular, the same lon/lat grid on any sphere, so once the image is shaded the Earth label costs nothing: it only
 *   tells GDAL which grid to tile, and the whole-body extent is assigned beside it so a grid in metres is not read as
 *   degrees.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { BODIES, type BuildableBodyID } from "#bodies"

/**
 * How far a source's width may differ from the body's circumference (or from 360°) and still count as a global mosaic.
 */
const GLOBAL_EXTENT_TOLERANCE = 0.005

/**
 * The whole-body extent every archive is tiled on, as `gdal_translate -a_ullr` takes it: west, north, east, south.
 */
const WHOLE_BODY_ULLR = ["-180", "90", "180", "-90"] as const

/**
 * Pixels along a tile edge; at zoom z the whole-body grid is 2^z tiles wide and 2^(z−1) tall in EPSG:4326.
 */
const TILE_PIXELS = 256

interface DEMGrid {
	/**
	 * True when the grid's coordinates are the body's metres (a projected CRS); false for degrees.
	 */
	projectedMetres: boolean
	width: number
}

/**
 * The unit and width of a DEM's grid, from `gdalinfo`. A source that does not span the whole body is refused: the
 * extent assigned below is the whole body's.
 */
async function readDEMGrid(demPath: string, body: BuildableBodyID): Promise<DEMGrid> {
	const { stdout } = await runFile("gdalinfo", ["-json", demPath])

	const info = parseJSONStrict<{
		coordinateSystem?: { wkt?: string }
		cornerCoordinates?: { upperLeft?: [number, number]; lowerRight?: [number, number] }
	}>(stdout)

	const wkt = info.coordinateSystem?.wkt ?? ""
	const projectedMetres = wkt.startsWith("PROJCRS") && wkt.includes('LENGTHUNIT["metre"')
	const [west] = info.cornerCoordinates?.upperLeft ?? []
	const [east] = info.cornerCoordinates?.lowerRight ?? []

	if (west === undefined || east === undefined) throw new Error(`${demPath}: gdalinfo reports no corner coordinates`)

	const width = east - west
	const expected = projectedMetres ? 2 * Math.PI * BODIES[body].meanRadiusKm * 1000 : 360

	if (Math.abs(width - expected) / expected > GLOBAL_EXTENT_TOLERANCE) {
		throw new Error(
			`${demPath}: the grid spans ${width.toFixed(0)} ${projectedMetres ? "m" : "°"}, not the whole body (${expected.toFixed(0)}); the build assigns the whole-body extent and cannot tile a partial mosaic`
		)
	}

	return { projectedMetres, width }
}

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
	const grid = await readDEMGrid(options.demPath, options.body)

	await using scratch = await temporaryDirectory("astrogeology-hillshade-")
	const shaded = String(resolvePath(scratch.path, "hillshade.tif"))
	const forTiling = String(resolvePath(scratch.path, "hillshade-4326.tif"))
	const mbtiles = String(resolvePath(scratch.path, "hillshade.mbtiles"))

	// 1. Shade in the source grid. `-s` is the height unit over the grid unit: 1 on a grid in the body's metres, the
	//    body's metres per degree on a grid in degrees.
	const shade = [
		"hillshade",
		options.demPath,
		shaded,
		"-s",
		grid.projectedMetres ? "1" : String(body.metresPerDegree),
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
	//    with the whole-body extent makes GDAL tile it on that grid; the metres are Earth's, which is why shading
	//    happened before this step. The image is resampled here to exactly the requested zoom's pixel grid, because
	//    the MBTiles driver picks the tiling zoom from the source resolution and nothing else: its MAXZOOM is a
	//    metadata value and ZOOM_LEVEL an open option, and under both the 118 m Moon mosaic landed at zoom 7 and 8
	//    (907 MB and 2.98 GB) against a requested 6.
	const width = TILE_PIXELS * 2 ** options.maxZoom

	const declare = [
		"-a_srs",
		"EPSG:4326",
		"-a_ullr",
		...WHOLE_BODY_ULLR,
		"-outsize",
		String(width),
		String(width / 2),
		"-r",
		"average",
		shaded,
		forTiling,
	]

	await runFile("gdal_translate", declare)

	// 3. MBTiles with PNG tiles at the source's zoom, then overviews down to zoom 0, then PMTiles. AUTO takes the
	//    closest zoom, which the resample made exact; LOWER would step one below an exact match.
	const tile = ["-of", "MBTILES", "-co", "TILE_FORMAT=PNG", "-co", "ZOOM_LEVEL_STRATEGY=AUTO", forTiling, mbtiles]

	await runFile("gdal_translate", tile)

	// The driver's zoom is read back rather than assumed; the resample above is what makes it the requested one.
	const zoom = await readMBTilesZoom(mbtiles)

	if (zoom !== options.maxZoom) {
		throw new Error(`${mbtiles}: GDAL tiled at zoom ${zoom}, not the requested ${options.maxZoom}`)
	}

	// Overviews run from that zoom down to 0; a source that lands at 0 has nothing to average.
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
