/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read the published file geodatabase as a stream of WGS84 features, through ogr2ogr.
 *
 *   OGR IS BUILD TOOLING, NEVER A SERVE DEPENDENCY (SCOPE invariant 6). It converts the authority's
 *   geometry into the structure the runtime probes, and nothing downstream of this module knows GDAL
 *   exists.
 *
 *   THE SOURCE IS NOT IN WGS84 AND SAYING SO IS THE CHECK. `Flood_Zones_2_3_Rivers_and_Sea` is published
 *   in OSGB36 / British National Grid — metres, easting/northing, EPSG:27700 — so a builder that read the
 *   coordinates as degrees would place every polygon in the Gulf of Guinea. The projection is asserted
 *   against the source's declared authority code before a single feature is read, and the reprojected
 *   stream is asserted against the collection's own declared bounding box, which is the check that
 *   catches a coordinate-order mistake the projection check cannot see.
 *
 *   `OGR_GEOM_AREA` RIDES ALONG AS THE INDEPENDENT AREA WITNESS. GDAL computes it on the SOURCE geometry
 *   in the source's own metres, before reprojection and before this package has touched a ring — so
 *   comparing it against an area computed from the encoded rings is a two-path check on ring nesting and
 *   hole handling, which are otherwise silent when wrong. See `rings.ts`'s `ringAreaReadings`.
 *
 *   THE DATUM SHIFT NEEDS A GRID, AND ITS ABSENCE IS SILENT. OSGB36 to WGS84 is accurate to a metre only
 *   through the OSTN15 grid; without it PROJ substitutes a ballpark offset and produces coordinates that
 *   are metres wrong and indistinguishable from correct ones. {@linkcode assertDatumTransformationAvailable}
 *   refuses the build rather than letting the whole layer shift.
 */

import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { JSONSpliterator, TextSpliterator } from "spliterator"

import { EA_DECLARED_BBOX, EA_FLOOD_LAYER, EA_SOURCE_EPSG } from "../vocabulary.ts"

const execFileAsync = promisify(execFile)

/**
 * One polygon's rings: `[exterior, ...holes]`, each ring a list of `[lon, lat]` positions.
 */
export type PolygonRings = ReadonlyArray<ReadonlyArray<readonly number[]>>

/**
 * A feature's polygons — `MultiPolygon` coordinates, with a bare `Polygon` lifted into the same shape.
 */
export type MultiPolygonRings = ReadonlyArray<PolygonRings>

/**
 * One source feature, reprojected to WGS84.
 */
export interface FloodSourceFeature {
	areaID: string
	zoneCode: string
	zoneSource: string | null
	origin: string | null
	/**
	 * GDAL's own area of the SOURCE geometry, in square metres of the source projection.
	 */
	sourceAreaM2: number
	polygons: MultiPolygonRings
}

/**
 * What the ingest was pointed at.
 */
export interface FloodIngestOptions {
	/**
	 * Path to the unzipped `.gdb` directory.
	 */
	geodatabasePath: string
	/**
	 * Layer inside it. Defaults to the EA's published layer name.
	 */
	layer?: string
	/**
	 * Stop after this many features — the fixtures and smoke rungs use it; a full build does not set it.
	 */
	limit?: number
	/**
	 * The EPSG code the source must declare. A source declaring anything else is a product change, not a variation to
	 * absorb.
	 */
	expectEPSG?: number
	/**
	 * The extent every reprojected vertex must land inside. Defaults to the EA collection's own declaration.
	 */
	declaredBBox?: readonly [number, number, number, number]
}

/**
 * Coordinate decimals ogr2ogr writes into the stream. Nine is ~0.1 mm at this latitude — far past the source's own
 * precision, and chosen so the reprojection contributes nothing measurable to the area cross-check.
 */
const COORDINATE_PRECISION = 9

/**
 * How far outside the declared extent a vertex may fall before the ingest refuses.
 *
 * A declared extent is itself a rounded published value, so an exact test would be brittle; this margin is small enough
 * that an unprojected or axis-swapped read — which lands degrees or whole hemispheres away — still fails.
 */
const BBOX_MARGIN_DEGREES = 0.01

/**
 * What the source declares about itself: its authority code and its feature count, read before any feature is.
 *
 * @throws {Error} When the layer is missing, or its declared EPSG is not `expectEPSG`.
 */
export async function readFloodSourceIdentity(
	options: FloodIngestOptions
): Promise<{ epsg: number; featureCount: number; layer: string }> {
	const layer = options.layer ?? EA_FLOOD_LAYER
	const expectEPSG = options.expectEPSG ?? EA_SOURCE_EPSG

	const { stdout } = await execFileAsync(
		"ogrinfo",
		["-json", "-so", options.geodatabasePath, layer],
		// A file geodatabase's summary is small; the ceiling only guards against a pathological driver.
		{ maxBuffer: 32 * 1024 * 1024 }
	)

	const info = parseJSONStrict<{
		layers?: Array<{
			name?: string
			featureCount?: number
			geometryFields?: Array<{ coordinateSystem?: { projjson?: { id?: { code?: number } } } }>
		}>
	}>(stdout)

	const described = info.layers?.[0]

	if (!described || described.name !== layer) {
		throw new Error(`flood ingest: ${options.geodatabasePath} does not carry a layer named ${JSON.stringify(layer)}`)
	}

	const code = described.geometryFields?.[0]?.coordinateSystem?.projjson?.id?.code

	if (typeof code !== "number") {
		throw new TypeError(
			`flood ingest: ${layer} declares no EPSG authority code — the projection cannot be checked, and reading its metres as degrees is silent`
		)
	}

	if (code !== expectEPSG) {
		throw new Error(
			`flood ingest: ${layer} declares EPSG:${code}, expected EPSG:${expectEPSG} — the source's projection changed, which is a product change rather than a variation to absorb`
		)
	}

	if (typeof described.featureCount !== "number") {
		throw new TypeError(`flood ingest: ${layer} reports no feature count`)
	}

	await assertDatumTransformationAvailable(code)

	return { epsg: code, featureCount: described.featureCount, layer }
}

/**
 * PROJ falls back to a BALLPARK datum shift when the accurate grid is not on disk, and it does so SILENTLY.
 *
 * Measured on this product: with the OSGB36→WGS84 grid missing, ogr2ogr placed the first feature's first vertex at
 * `1.698151293, 52.648130027`; with `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` present it placed it at `1.698174628,
 * 52.648157259` — 3.4 m apart. Both look like perfectly ordinary WGS84 coordinates, both pass a bounding-box check, and
 * the whole layer is offset. It surfaced as eight disagreements out of 59 against the authority's own OGC service,
 * every one a point that fell into a NEIGHBOURING sliver: at this product's scale a 3 m shift changes the answer,
 * because 38.8% of its polygons are under 11 m across.
 *
 * `--config PROJ_NETWORK ON` does not reach PROJ through GDAL 3.8, and `PROJ_ONLY_BEST=ON` was observed not to refuse,
 * so neither is a usable guard. What is usable is asking PROJ what it would do: `projinfo` names the best candidate
 * operation and says when a grid is missing.
 *
 * @throws {Error} When the best available transformation is a ballpark one, or is missing a grid.
 */
export async function assertDatumTransformationAvailable(sourceEPSG: number): Promise<void> {
	const { stdout } = await execFileAsync("projinfo", ["-s", `EPSG:${sourceEPSG}`, "-t", "EPSG:4326", "--summary"])
	const verdict = assessDatumTransformation(stdout)

	if (verdict.usable) return

	throw new Error(
		`flood ingest: the best EPSG:${sourceEPSG} → EPSG:4326 transformation is unusable — ${verdict.reason} ` +
			`(${verdict.best ?? "projinfo named no candidate"}). PROJ falls back to a ballpark datum shift, which is metres ` +
			'wrong and looks exactly like a correct answer. Install the grid with `projsync --area-of-use "United Kingdom"` ' +
			"and re-run."
	)
}

/**
 * Read `projinfo --summary` output: which operation PROJ would choose, and whether it can actually run.
 *
 * Split from the spawn so the parse is testable against captured output. The two states this distinguishes were both
 * observed on the same machine — the same command printed `at least one grid missing` before the grid was installed and
 * did not after — and they are the difference between a metre-accurate layer and a 3 m-offset one.
 */
export function assessDatumTransformation(summary: string): { best?: string; usable: boolean; reason: string } {
	// The first line naming a candidate operation is the one PROJ will choose. Everything before it is a header, and the
	// `Note:` line about `--spatial-test` is not a candidate.
	const best = TextSpliterator.from(summary, { delimiter: "\n" })
		.map((line) => line.trim())
		.find((line) => line.includes(", ") && !line.startsWith("Note:") && !line.startsWith("Candidate operations"))

	if (!best) return { usable: false, reason: "projinfo named no candidate operation" }

	if (best.includes("grid missing")) return { best, usable: false, reason: "its grid is not installed" }

	if (best.toLowerCase().includes("ballpark")) return { best, usable: false, reason: "it is a ballpark offset" }

	return { best, usable: true, reason: "the best operation is available" }
}

interface RawFeature {
	properties: {
		area_id: number | string
		origin: string | null
		flood_zone: string | null
		flood_source: string | null
		source_area_m2: number | null
	}
	geometry: { type: string; coordinates: unknown } | null
}

/**
 * Stream the layer as WGS84 features.
 *
 * Every feature is checked against the declared extent as it passes. A swapped coordinate order survives a projection
 * check — both axes are still numbers in a plausible range — and shows up here immediately, before 813,627 polygons are
 * written to the wrong side of the planet.
 *
 * @throws {Error} When ogr2ogr fails, when a feature carries no geometry or no zone value, or when a reprojected vertex
 *   falls outside the declared extent.
 */
export async function* readFloodSourceFeatures(options: FloodIngestOptions): AsyncGenerator<FloodSourceFeature> {
	const layer = options.layer ?? EA_FLOOD_LAYER
	const [minLon, minLat, maxLon, maxLat] = options.declaredBBox ?? EA_DECLARED_BBOX

	const args = [
		"-f",
		"GeoJSONSeq",
		"/vsistdout/",
		"-t_srs",
		"EPSG:4326",
		"-lco",
		`COORDINATE_PRECISION=${COORDINATE_PRECISION}`,
		...(options.limit === undefined ? [] : ["-limit", String(options.limit)]),
		"-sql",
		`SELECT OBJECTID AS area_id, origin, flood_zone, flood_source, OGR_GEOM_AREA AS source_area_m2 FROM ${layer}`,
		options.geodatabasePath,
	]

	const child = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "pipe"] })
	const stderr: string[] = []

	child.stderr.setEncoding("utf8")

	child.stderr.on("data", (chunk: string) => {
		stderr.push(chunk)
	})

	let exitError: Error | undefined

	const exited = new Promise<void>((resolve) => {
		child.on("error", (error) => {
			exitError = error
			resolve()
		})

		child.on("close", (code) => {
			if (code !== 0) {
				exitError = new Error(
					`flood ingest: ogr2ogr exited ${code}${stderr.length ? ` — ${stderr.join("").trim()}` : ""}`
				)
			}

			resolve()
		})
	})

	try {
		for await (const raw of JSONSpliterator.fromAsync<RawFeature>(child.stdout)) {
			yield toSourceFeature(raw, { minLon, minLat, maxLon, maxLat })
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill()
		}
	}

	await exited

	// A truncated stream reads as a short but well-formed feature list, which is exactly the partial result that must
	// throw rather than be reported as a smaller England.
	if (exitError) throw exitError
}

/**
 * Validate one raw GeoJSON feature and narrow it. Split out so the generator body stays a loop.
 */
function toSourceFeature(
	raw: RawFeature,
	extent: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): FloodSourceFeature {
	const { properties, geometry } = raw

	if (!geometry) {
		throw new Error(`flood ingest: feature ${properties.area_id} carries no geometry`)
	}

	if (properties.flood_zone === null) {
		throw new Error(`flood ingest: feature ${properties.area_id} carries no flood_zone value`)
	}

	const polygons = normalizePolygons(geometry, String(properties.area_id))

	for (const rings of polygons) {
		for (const ring of rings) {
			for (const position of ring) {
				const lon = position[0]!
				const lat = position[1]!

				if (
					lon < extent.minLon - BBOX_MARGIN_DEGREES ||
					lon > extent.maxLon + BBOX_MARGIN_DEGREES ||
					lat < extent.minLat - BBOX_MARGIN_DEGREES ||
					lat > extent.maxLat + BBOX_MARGIN_DEGREES
				) {
					throw new Error(
						`flood ingest: feature ${properties.area_id} has a vertex at ${lon}, ${lat}, outside the declared extent ` +
							`[${extent.minLon}, ${extent.minLat}, ${extent.maxLon}, ${extent.maxLat}] — the reprojection or the coordinate order is wrong`
					)
				}
			}
		}
	}

	return {
		areaID: String(properties.area_id),
		zoneCode: properties.flood_zone,
		zoneSource: properties.flood_source,
		origin: properties.origin,
		sourceAreaM2: properties.source_area_m2 ?? 0,
		polygons,
	}
}

/**
 * Where a build's features come from, and what the source declares about itself.
 *
 * The builder takes ONE of these rather than a path, which is what makes the fixture rung possible: hand-built geometry
 * with no network and no GDAL still exercises the whole database half — the vocabulary check, the cell classification,
 * the coverage rows, the manifest and the seal. A fixture rung that could only run through ogr2ogr would test the
 * conversion on the machines that have it and nothing at all on the ones that do not.
 */
export interface FloodFeatureSource {
	/**
	 * What the source says it holds. The build compares its own streamed total against this, so a short read throws
	 * instead of building a smaller England.
	 */
	declaredFeatureCount: number
	layer: string
	epsg: number
	/**
	 * A description of where these features came from, for the receipt.
	 */
	origin: string
	features: () => AsyncIterable<FloodSourceFeature>
}

/**
 * The published geodatabase as a feature source — identity read up front, features streamed on demand.
 */
export async function createGeodatabaseFeatureSource(options: FloodIngestOptions): Promise<FloodFeatureSource> {
	const identity = await readFloodSourceIdentity(options)

	return {
		declaredFeatureCount: options.limit ?? identity.featureCount,
		layer: identity.layer,
		epsg: identity.epsg,
		origin: options.geodatabasePath,
		features: () => readFloodSourceFeatures(options),
	}
}

/**
 * Lift a `Polygon` to the `MultiPolygon` shape the rest of this package works in.
 *
 * @throws {Error} When the geometry is neither.
 */
function normalizePolygons(geometry: { type: string; coordinates: unknown }, areaID: string): MultiPolygonRings {
	if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPolygonRings

	if (geometry.type === "Polygon") return [geometry.coordinates as PolygonRings]

	throw new Error(`flood ingest: feature ${areaID} is a ${geometry.type}, expected Polygon or MultiPolygon`)
}
