/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hillshade build: publish the DEM as terrain-RGB tiles, so MapLibre's `hillshade` layer shades it at draw
 *   time. The archive carries ENCODED ELEVATION, not a shaded picture.
 *
 *   WHY NOT A SHADED IMAGE. `gdaldem hillshade` answers a single greyscale band, and greyscale carries no colour for
 *   a style to tint: MapLibre's raster paint properties are brightness, contrast, saturation and hue-rotate, and on
 *   an image with no chroma the last two do nothing. That is why the Moon and Mars rendered as the same grey ball
 *   whatever their palettes said. Encoded elevation moves the colour decision into the style, where
 *   `hillshade-highlight-color`, `-shadow-color` and `-accent-color` give each body its own relief, and a re-tint
 *   costs an edit rather than a rebuild.
 *
 *   AVERAGE THE ELEVATIONS, NEVER THE ENCODED BYTES. Resampling happens before the encode, where the mean of four
 *   heights is a height. After the encode those bytes are a base-256 numeral: averaging the high byte of two
 *   neighbours yields an elevation that is neither of them, so the overview pyramid is built with `nearest`, which
 *   decimates to real samples.
 *
 *   The XYZ tile scheme is angular — the same lon/lat grid on any sphere — so the EPSG:4326 label only tells GDAL
 *   which grid to tile, and the whole-body extent is assigned beside it so a grid in the body's metres is not read
 *   as degrees. Unlike the shading it replaces, the encode is a per-pixel value transform that does not care about
 *   the grid, so it no longer matters whether the label comes first.
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
 * The terrarium encoding's zero point: a height of `-TERRARIUM_DATUM_METRES` encodes as byte zero. MapLibre reads
 * `height = (R * 256 + G + B / 256) - 32768`, so the envelope is ±32,768 m. Both bodies sit well inside it — MOLA spans
 * about −8,200 m to +21,200 m and LOLA about −9,100 m to +10,800 m — and the build refuses a DEM that does not, rather
 * than wrapping a height silently into a wrong one.
 */
const TERRARIUM_DATUM_METRES = 32_768

/**
 * `B` carries the fractional metre. The USGS mosaics are integer metres, so it is constant zero and the encoding keeps
 * its full 1 m precision without a third band computation.
 */
const TERRARIUM_FRACTIONAL_BAND = "0"

/**
 * Refuse a raster whose elevations do not fit terrarium's ±32,768 m envelope. A height outside it wraps to a different,
 * plausible-looking height rather than failing, which is the shape of defect a reader cannot see.
 */
async function assertWithinTerrariumEnvelope(rasterPath: string): Promise<void> {
	const { stdout } = await runFile("gdalinfo", ["-json", "-stats", rasterPath])
	const info = parseJSONStrict<{ bands?: Array<{ minimum?: number; maximum?: number }> }>(stdout)
	const [band] = info.bands ?? []

	if (band?.minimum === undefined || band.maximum === undefined) {
		throw new Error(`${rasterPath}: gdalinfo reports no band statistics, so the elevation range cannot be checked`)
	}

	if (band.minimum < -TERRARIUM_DATUM_METRES || band.maximum >= TERRARIUM_DATUM_METRES) {
		throw new Error(
			`${rasterPath}: elevations span ${band.minimum} m to ${band.maximum} m, outside terrarium's ±${TERRARIUM_DATUM_METRES} m envelope`
		)
	}
}

/**
 * Build a body's hillshade archive. Answers the exact tool invocations, in order, for the manifest.
 */
export async function buildHillshadePMTiles(options: HillshadeBuildOptions): Promise<{ commands: string[][] }> {
	// Refuses a source that does not span the whole body: the extent assigned below is the whole body's.
	await readDEMGrid(options.demPath, options.body)

	await using scratch = await temporaryDirectory("astrogeology-hillshade-")
	const resampled = String(resolvePath(scratch.path, "elevation-4326.tif"))
	const redBand = String(resolvePath(scratch.path, "terrarium-r.tif"))
	const greenBand = String(resolvePath(scratch.path, "terrarium-g.tif"))
	const blueBand = String(resolvePath(scratch.path, "terrarium-b.tif"))
	const bandsVRT = String(resolvePath(scratch.path, "terrarium.vrt"))
	const forTiling = String(resolvePath(scratch.path, "hillshade-4326.tif"))
	const mbtiles = String(resolvePath(scratch.path, "hillshade.mbtiles"))

	// 1. Resample the ELEVATIONS and declare the tiling grid, in one pass. Averaging is meaningful here and nowhere
	//    later: the mean of four heights is a height. The XYZ scheme is angular, so the EPSG:4326 label with the
	//    whole-body extent only tells GDAL which grid to tile. The resize to exactly the requested zoom's pixel grid
	//    is what fixes the tiling zoom, because the MBTiles driver picks it from the source resolution and nothing
	//    else: its MAXZOOM is a metadata value and ZOOM_LEVEL an open option, and under both the 118 m Moon mosaic
	//    landed at zoom 7 and 8 (907 MB and 2.98 GB) against a requested 6.
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
		"-co",
		"COMPRESS=DEFLATE",
		options.demPath,
		resampled,
	]

	await runFile("gdal_translate", declare)

	// Read the range off the RESAMPLED raster rather than the source: it is the data that gets encoded, and it is a
	// few hundred megapixels rather than the source's several gigabytes. A height outside the envelope would wrap to
	// a wrong one silently, so it is refused instead.
	await assertWithinTerrariumEnvelope(resampled)

	// 2. Encode terrarium: R is the high byte of the offset height, G the low byte, B the fractional metre. Each band
	//    is computed separately because `gdal_calc.py` writes one band per run, then the three are stacked.
	const offset = `(A.astype(numpy.float64) + ${TERRARIUM_DATUM_METRES})`

	const red = [
		"-A",
		resampled,
		"--outfile",
		redBand,
		"--calc",
		`numpy.floor(${offset} / 256)`,
		"--type",
		"Byte",
		"--quiet",
		"--overwrite",
	]

	const green = [
		"-A",
		resampled,
		"--outfile",
		greenBand,
		"--calc",
		`numpy.mod(numpy.floor(${offset}), 256)`,
		"--type",
		"Byte",
		"--quiet",
		"--overwrite",
	]

	const blue = [
		"-A",
		resampled,
		"--outfile",
		blueBand,
		"--calc",
		`A * 0 + ${TERRARIUM_FRACTIONAL_BAND}`,
		"--type",
		"Byte",
		"--quiet",
		"--overwrite",
	]

	await runFile("gdal_calc.py", red)
	await runFile("gdal_calc.py", green)
	await runFile("gdal_calc.py", blue)

	const stack = ["-separate", "-overwrite", bandsVRT, redBand, greenBand, blueBand]

	await runFile("gdalbuildvrt", stack)

	const materialize = ["-co", "COMPRESS=DEFLATE", bandsVRT, forTiling]

	await runFile("gdal_translate", materialize)

	// 3. MBTiles with PNG tiles at the source's zoom, then overviews down to zoom 0, then PMTiles. The driver's zoom
	//    estimate for a grid of exactly 256·2^z pixels sits a hair under z: measured on blank whole-globe rasters, AUTO
	//    and LOWER answered 5 for 16,384 pixels and LOWER answered 1 for 1,024, while UPPER answered 6 and 2. UPPER is
	//    the strategy that lands on the requested zoom.
	// MBTiles is a Web Mercator format, so this step REPROJECTS from the EPSG:4326 grid above — and a reprojection
	// resamples. `-r nearest` is stated rather than inherited: it is `gdal_translate`'s default today, and the encoded
	// bytes are a base-256 numeral that any interpolating kernel would turn into heights that are not samples of
	// anything. Verified by decoding the built archive at named places — Olympus Mons reads 20,009 m against the
	// source's 20,012 m, Hellas Planitia −6,044 m against −6,044 m.
	const tile = [
		"-of",
		"MBTILES",
		"-r",
		"nearest",
		"-co",
		"TILE_FORMAT=PNG",
		"-co",
		"ZOOM_LEVEL_STRATEGY=UPPER",
		forTiling,
		mbtiles,
	]

	await runFile("gdal_translate", tile)

	// The driver's zoom is read back rather than assumed; the resample above is what makes it the requested one.
	const zoom = await readMBTilesZoom(mbtiles)

	if (zoom !== options.maxZoom) {
		throw new Error(`${mbtiles}: GDAL tiled at zoom ${zoom}, not the requested ${options.maxZoom}`)
	}

	// Overviews run from that zoom down to 0, resampled NEAREST. The bytes are a base-256 numeral by now: averaging
	//    the high byte of two neighbours answers an elevation that is neither of them, and the error is a whole 256 m
	//    step wherever the two straddle a boundary. Decimation keeps every overview pixel a real sample.
	const overviews = ["-r", "nearest", mbtiles, ...Array.from({ length: zoom }, (_, index) => String(2 ** (index + 1)))]

	if (zoom > 0) {
		await runFile("gdaladdo", overviews)
	}

	const convert = ["convert", mbtiles, options.outPath]

	await runFile("pmtiles", convert)

	return {
		commands: [
			["gdal_translate", ...declare],
			["gdal_calc.py", ...red],
			["gdal_calc.py", ...green],
			["gdal_calc.py", ...blue],
			["gdalbuildvrt", ...stack],
			["gdal_translate", ...materialize],
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
