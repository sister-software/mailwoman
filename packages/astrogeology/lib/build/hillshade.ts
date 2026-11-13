// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The hillshade build: publish the DEM as terrain-RGB tiles, so MapLibre's
 *   `hillshade` layer shades it at draw time.
 *
 *   The archive stores encoded elevation.
 *   The style chooses the color ramp, so a re-tint requires a style edit instead of rebuilding the archive.
 *
 *   Average elevations before encoding.
 *   Each encoded byte is a base-256 numeral.
 *
 *   The mean of neighboring high bytes would produce an elevation that matches neither sample.
 *   The overview pyramid uses `nearest` to decimate real samples.
 *
 *   The XYZ tile scheme is angular and uses the same lon/lat grid on any sphere.
 *   The EPSG:4326 label tells GDAL which grid to tile.
 *
 *   The build assigns the whole-body extent beside it, so coordinates in the
 *   body's meters do not read as degrees.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { BODIES, type BuildableBodyID } from "#bodies"

/**
 * Fraction by which a source's width may differ from the body's circumference
 * (or 360°) and still count as a global mosaic.
 */
const GLOBAL_EXTENT_TOLERANCE = 0.005

/**
 * The whole-body extent every archive is tiled on, in `gdal_translate -a_ullr` order:
 * west, north, east, south.
 */
const WHOLE_BODY_ULLR = ["-180", "90", "180", "-90"] as const

/**
 * Pixels along a tile edge.
 *
 * At zoom z the whole-body grid is 2^z tiles wide and 2^(z−1) tall.
 */
const TILE_PIXELS = 256

interface DEMGrid {
	projectedMetres: boolean
	width: number
}

/**
 * The unit and width of a DEM's grid, from `gdalinfo`.
 *
 * A source that doesn't span the whole body is refused, because the extent
 * assigned below is the whole body's.
 */
async function readDEMGrid(demPath: PathBuilderLike, body: BuildableBodyID): Promise<DEMGrid> {
	const { stdout } = await runFile("gdalinfo", ["-json", demPath])

	const info = parseJSONStrict<{
		coordinateSystem?: { wkt?: string }
		cornerCoordinates?: { upperLeft?: [number, number]; lowerRight?: [number, number] }
	}>(stdout)

	const wkt = info.coordinateSystem?.wkt ?? ""
	const projectedMetres = wkt.startsWith("PROJCRS") && wkt.includes('LENGTHUNIT["metre"')
	const [west] = info.cornerCoordinates?.upperLeft ?? []
	const [east] = info.cornerCoordinates?.lowerRight ?? []

	if (!west || !east) throw new Error(`${demPath}: gdalinfo reports no corner coordinates`)

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
	demPath: PathBuilderLike
	outPath: PathBuilderLike
	/**
	 * The deepest zoom level the archive stores.
	 * Overviews run from it down to zoom 0.
	 */
	maxZoom: number
}

/**
 * The terrarium encoding's zero point: a height of `-TERRARIUM_DATUM_METRES` encodes as byte zero.
 *
 * MapLibre reads `height = (R * 256 + G + B / 256) - 32768`.
 * The representable range is ±32,768 m.
 *
 * The build accepts DEMs only within this range.
 * This keeps encoded heights within their valid values.
 */
const TERRARIUM_DATUM_METRES = 32_768

/**
 * `B` stores the fractional meter.
 *
 * The usgs mosaics are integer meters, so it is constant zero.
 */
const TERRARIUM_FRACTIONAL_BAND = "0"

/**
 * Refuse a raster whose elevations do not fit terrarium's ±32,768 m envelope, where an
 * out-of-range height would wrap to a plausible-looking wrong one rather than failing.
 */
async function assertWithinTerrariumEnvelope(rasterPath: string): Promise<void> {
	const { stdout } = await runFile("gdalinfo", ["-json", "-stats", rasterPath])

	const info = parseJSONStrict<{ bands?: Array<{ minimum?: number; maximum?: number }> }>(stdout)
	const [band] = info.bands ?? []

	if (!band?.minimum || !band.maximum) {
		throw new Error(`${rasterPath}: gdalinfo reports no band statistics, so the elevation range cannot be checked`)
	}

	if (band.minimum < -TERRARIUM_DATUM_METRES || band.maximum >= TERRARIUM_DATUM_METRES) {
		throw new Error(
			`${rasterPath}: elevations span ${band.minimum} m to ${band.maximum} m, outside terrarium's ±${TERRARIUM_DATUM_METRES} m envelope`
		)
	}
}

/**
 * The interpreters tried, in order, for one that can import GDAL's Python bindings.
 *
 * A distribution builds its `osgeo` bindings for one Python minor version.
 * `python3` can resolve to a newer minor version than the bindings were built for.
 *
 * An example is a `/usr/local/bin/python3` at 3.13 beside Ubuntu's 3.12 bindings.
 * The distribution's own interpreter is therefore the fallback.
 */
export const OSGEO_INTERPRETERS: readonly string[] = ["python3", "python3.12"]

/**
 * The module `gdal_calc.py` wraps.
 *
 * The build runs it with `-m` through a chosen interpreter.
 * That invocation bypasses the script's `#!` line.
 * That line runs whichever `python3` the system links.
 */
const GDAL_CALC_MODULE = "osgeo_utils.gdal_calc"

const interpreterByCandidates = new Map<string, Promise<string>>()

/**
 * The first of `candidates` that imports `osgeo`, probed with `-c 'import osgeo'` once per process.
 *
 * @throws When none imports it, listing each candidate with the last line of its error.
 */
export function resolveOSGeoInterpreter(candidates: readonly string[] = OSGEO_INTERPRETERS): Promise<string> {
	const key = candidates.join("\0")
	let resolved = interpreterByCandidates.get(key)

	if (!resolved) {
		resolved = probeOSGeoInterpreters(candidates)
		interpreterByCandidates.set(key, resolved)
		resolved.catch(() => interpreterByCandidates.delete(key))
	}

	return resolved
}

async function probeOSGeoInterpreters(candidates: readonly string[]): Promise<string> {
	const failures: string[] = []

	for (const candidate of candidates) {
		try {
			await runFile(candidate, ["-c", "import osgeo"])

			return candidate
		} catch (error) {
			const { stderr, message } = error as { stderr?: string; message?: string }
			const output = (stderr || message || String(error)).trim()

			// The last line of a Python traceback states the exception, such as `ModuleNotFoundError: …`.
			failures.push(`${candidate}: ${output.slice(output.lastIndexOf("\n") + 1)}`)
		}
	}

	throw new Error(`no interpreter imports GDAL's Python bindings (osgeo); tried ${failures.join("; ")}`)
}

/**
 * Build a body's hillshade archive, answering the exact tool invocations in order for the manifest.
 */
export async function buildHillshadePMTiles(
	options: HillshadeBuildOptions
): Promise<{ commands: PathBuilderLike[][] }> {
	await readDEMGrid(options.demPath, options.body)

	await using scratch = await temporaryDirectory("astrogeology-hillshade-")

	const resampled = resolvePath(scratch.path, "elevation-4326.tif")
	const redBand = resolvePath(scratch.path, "terrarium-r.tif")
	const greenBand = resolvePath(scratch.path, "terrarium-g.tif")
	const blueBand = resolvePath(scratch.path, "terrarium-b.tif")
	const bandsVRT = resolvePath(scratch.path, "terrarium.vrt")
	const forTiling = resolvePath(scratch.path, "hillshade-4326.tif")
	const mbtiles = resolvePath(scratch.path, "hillshade.mbtiles")

	// Average the elevations while resampling.
	// Later stages use encoded bytes, where averaging is meaningless.
	// The requested zoom's pixel grid sets the tiling zoom during resampling.
	// The MBTiles driver reads that zoom from the source resolution.
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

	// Read the range from the resampled raster because that's the data to encode.
	// The resampled raster is much smaller than the source.
	await assertWithinTerrariumEnvelope(resampled)

	// Encode terrarium: R is the high byte of the offset height, G the low byte, B the fractional meter.
	// `gdal_calc` writes one band per run, so the three are computed separately and stacked.
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

	const python = await resolveOSGeoInterpreter()
	const gdalCalc = [python, "-m", GDAL_CALC_MODULE]

	await runFile(python, [...gdalCalc.slice(1), ...red])
	await runFile(python, [...gdalCalc.slice(1), ...green])
	await runFile(python, [...gdalCalc.slice(1), ...blue])

	const stack = ["-separate", "-overwrite", bandsVRT, redBand, greenBand, blueBand]

	await runFile("gdalbuildvrt", stack)

	const materialize = ["-co", "COMPRESS=DEFLATE", bandsVRT, forTiling]

	await runFile("gdal_translate", materialize)

	// MBTiles is a Web Mercator format, so this step reprojects from the epsg:4326
	// grid above and a reprojection resamples.
	// `-r nearest` is stated rather than inherited: the encoded bytes are a base-256 numeral
	// that any interpolating kernel would turn into heights that are not samples of anything.
	// `ZOOM_LEVEL_STRATEGY=UPPER` lands on the requested zoom, where the driver's
	// estimate for a grid of exactly 256·2^z pixels sits a hair under z.
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

	const zoom = await readMBTilesZoom(mbtiles)

	if (zoom !== options.maxZoom) {
		throw new Error(`${mbtiles}: GDAL tiled at zoom ${zoom}, not the requested ${options.maxZoom}`)
	}

	// Overviews run from that zoom down to 0, resampled nearest: the bytes are a base-256 numeral
	// by now, so averaging two neighbors' high bytes answers an elevation that's neither of them.
	const overviews = ["-r", "nearest", mbtiles, ...Array.from({ length: zoom }, (_, index) => String(2 ** (index + 1)))]

	if (zoom > 0) {
		await runFile("gdaladdo", overviews)
	}

	const convert = ["convert", mbtiles, options.outPath]

	await runFile("pmtiles", convert)

	return {
		commands: [
			["gdal_translate", ...declare],
			[...gdalCalc, ...red],
			[...gdalCalc, ...green],
			[...gdalCalc, ...blue],
			["gdalbuildvrt", ...stack],
			["gdal_translate", ...materialize],
			["gdal_translate", ...tile],
			...(zoom > 0 ? [["gdaladdo", ...overviews]] : []),
			["pmtiles", ...convert],
		],
	}
}

async function readMBTilesZoom(mbtiles: string): Promise<number> {
	const { stdout } = await runFile("gdalinfo", ["-json", mbtiles])

	const info = parseJSONStrict<{ metadata?: { ""?: { ZOOM_LEVEL?: string } } }>(stdout)
	const zoom = Number(info.metadata?.[""]?.ZOOM_LEVEL)

	if (!Number.isInteger(zoom) || zoom < 0) {
		throw new Error(`${mbtiles}: gdalinfo reports no ZOOM_LEVEL for the MBTiles dataset`)
	}

	return zoom
}
