/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read a survey area's published shapefiles as a stream of WGS84 delineations, through ogr2ogr.
 *
 *   OGR IS BUILD TOOLING, NEVER A SERVE DEPENDENCY (SCOPE invariant 6). It converts the authority's geometry
 *   into the structure the runtime probes, and nothing downstream of this module knows GDAL exists.
 *
 *   THE SOURCE IS ALREADY IN WGS84, AND CHECKING IT IS STILL THE CHECK. Each `.prj` is an ESRI WKT reading
 *   `GEOGCS["GCS_WGS_1984",…]`, which GDAL resolves to EPSG:4326 — so no reprojection is needed before H3.
 *   The authority code is asserted anyway before a single feature is read, and the reprojected stream is
 *   asserted against the layer's own declared extent, which is the check that catches a coordinate-order
 *   mistake the projection check cannot see.
 *
 *   THE DATUM GUARD RUNS EVEN THOUGH THE ANSWER IS THE IDENTITY, AND THAT IS THE POINT. PROJ substitutes a
 *   ballpark datum shift SILENTLY when the accurate grid is missing — measured on the flood layer at 3.4 m
 *   over an entire country, visible only as eight disagreements out of 59 against the authority's own
 *   service. For an EPSG:4326 source `projinfo` answers `Null geographic offset from WGS 84 to WGS 84, 0 m,
 *   World.` and the guard passes in one process. Skipping it on the reasoning that this source needs no
 *   shift is how the guard comes to be missing on the day a source arrives that does.
 *
 *   THE ID IS THE SHAPEFILE'S OWN FID, AND IT HAS TO BE, because SSURGO publishes no per-delineation key:
 *   `MUKEY` names the MAP UNIT and one map unit has many delineations — `IA153` holds 17,966 delineations
 *   across 152 map units. So `area_id` is `<areasymbol>:<fid>`, which is stable across runs and is what makes
 *   a bounded chunk name the same features every time.
 */

import { assertRingsInsideExtent, requireArealPolygons, type MultiPolygonRings } from "@mailwoman/spatial"
import { readOGRLayerIdentity } from "@mailwoman/spatial/tools/ogr"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"
import { basename, join } from "path-ts"

import { SSURGO_SOURCE_EPSG } from "#vocabulary"

/**
 * Coordinate decimals ogr2ogr writes into the stream. Nine is well past the source's own precision — the metadata
 * states compilation to base maps meeting National Map Accuracy Standards at 1 inch = 1,000 feet — and is chosen so the
 * round trip contributes nothing measurable to the area cross-check.
 */
const COORDINATE_PRECISION = 9

/**
 * How far outside the layer's declared extent a vertex may fall before the ingest refuses.
 *
 * A tenth of a degree is about 11 km — small enough that an unprojected or axis-swapped read, which lands whole
 * hemispheres away, still fails, and loose enough that a rounded declared extent is not brittle.
 */
const BBOX_MARGIN_DEGREES = 0.1

/**
 * The shapefile holding a survey area's map-unit polygons — the delineations this layer stores.
 */
export function mapUnitShapefile(spatialDirectory: string, areaSymbol: string): string {
	return join(spatialDirectory, `soilmu_a_${areaSymbol.toLowerCase()}.shp`)
}

/**
 * The shapefile holding a survey area's own OUTLINE. The footprint comes from HERE and never from the union of the
 * rated polygons — `NOTCOM` and access-denied map units are inside the footprint and carry no rating, so a footprint
 * derived from the rated set would report them as unmapped when the authority has declared exactly what they are.
 */
export function surveyAreaShapefile(spatialDirectory: string, areaSymbol: string): string {
	return join(spatialDirectory, `soilsa_a_${areaSymbol.toLowerCase()}.shp`)
}

/**
 * One map-unit delineation, reprojected to WGS84.
 */
export interface SoilDelineation {
	/**
	 * `<areasymbol>:<fid>`.
	 */
	areaID: string
	mukey: string
	areasymbol: string
	polygons: MultiPolygonRings
}

/**
 * What a shapefile says about itself, read before any feature is.
 */
export interface SoilSourceIdentity {
	epsg: number
	featureCount: number
	layer: string
	/**
	 * The layer's own declared extent, `[minLon, minLat, maxLon, maxLat]`.
	 */
	bbox: readonly [number, number, number, number]
}

export interface SoilIngestOptions {
	shapefilePath: string
	/**
	 * Layer inside it. Defaults to the shapefile's base name, which is what the ESRI driver reports.
	 */
	layer?: string
	/**
	 * The EPSG code the source must declare.
	 */
	expectEPSG?: number
	/**
	 * Read only the shapefile's own FIDs in `[fidFrom, fidTo]`, inclusive — what makes a bounded chunk possible.
	 */
	fidFrom?: number
	fidTo?: number
	/**
	 * Stop after this many features. The fixture and smoke rungs use it; a full build does not set it.
	 */
	limit?: number
}

/**
 * Read what the shapefile declares about itself, and refuse a projection this ingest was not written for.
 *
 * @throws {Error} When the layer is missing, declares no EPSG authority code, declares one other than `expectEPSG`, or
 *   reports no feature count.
 */
export async function readSoilSourceIdentity(options: SoilIngestOptions): Promise<SoilSourceIdentity> {
	const identity = await readOGRLayerIdentity({
		path: options.shapefilePath,
		layer: options.layer ?? basename(options.shapefilePath, ".shp"),
		expectEPSG: options.expectEPSG ?? SSURGO_SOURCE_EPSG,
		context: "soil ingest",
		requireExtent: true,
		messages: {
			noAuthorityCode: "the projection cannot be checked, and reading one datum's coordinates as another's is silent",
			epsgMismatch:
				"SSURGO publishes geographic WGS84, so a different code is a product change rather than a variation to absorb",
		},
	})

	return { epsg: identity.epsg, featureCount: identity.featureCount, layer: identity.layer, bbox: identity.extent! }
}

/**
 * The ingest's `SELECT`, with the FID range applied when one is asked for.
 */
function delineationSelectSQL(layer: string, options: SoilIngestOptions): string {
	const select = `SELECT FID AS fid, MUKEY AS mukey, AREASYMBOL AS areasymbol FROM "${layer}"`
	const bounds: string[] = []

	if (options.fidFrom !== undefined) {
		bounds.push(`FID >= ${options.fidFrom}`)
	}

	if (options.fidTo !== undefined) {
		bounds.push(`FID <= ${options.fidTo}`)
	}

	return bounds.length ? `${select} WHERE ${bounds.join(" AND ")}` : select
}

interface RawFeature {
	properties: { fid: number | string; mukey: number | string | null; areasymbol: string | null }
	geometry: { type: string; coordinates: unknown } | null
}

/**
 * Stream the map-unit delineations as WGS84 features.
 *
 * Every feature is checked against the declared extent as it passes. A swapped coordinate order survives a projection
 * check — both axes are still numbers in a plausible range — and shows up here immediately.
 *
 * @throws {Error} When ogr2ogr fails, when a feature carries no geometry or no `MUKEY`, or when a vertex falls outside
 *   the declared extent.
 */
export async function* readSoilDelineations(
	options: SoilIngestOptions & { bbox: readonly [number, number, number, number] }
): AsyncGenerator<SoilDelineation> {
	const layer = options.layer ?? basename(options.shapefilePath, ".shp")
	const [minLon, minLat, maxLon, maxLat] = options.bbox

	const args = [
		"-f",
		"GeoJSONSeq",
		"/vsistdout/",
		// The OUTPUT projection. `expectEPSG` is the assertion `readSoilSourceIdentity` makes about the SOURCE and is not
		// the same thing: the consumer reads WGS84, whatever the shapefile declares.
		"-t_srs",
		"EPSG:4326",
		"-lco",
		`COORDINATE_PRECISION=${COORDINATE_PRECISION}`,
		...(options.limit === undefined ? [] : ["-limit", String(options.limit)]),
		"-sql",
		delineationSelectSQL(layer, options),
		options.shapefilePath,
	]

	for await (const raw of ogr2ogrGeoJSONSeq<RawFeature>(args, "soil ingest")) {
		yield toDelineation(raw, { minLon, minLat, maxLon, maxLat })
	}
}

/**
 * Validate one raw GeoJSON feature and narrow it. Split out so the generator body stays a loop.
 */
function toDelineation(
	raw: RawFeature,
	extent: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): SoilDelineation {
	const { properties, geometry } = raw

	if (!geometry) {
		throw new Error(`soil ingest: delineation ${properties.fid} carries no geometry`)
	}

	if (properties.mukey === null || properties.mukey === "") {
		throw new Error(
			`soil ingest: delineation ${properties.fid} carries no MUKEY — a delineation with no map unit joins to nothing and would read downstream as unmapped ground`
		)
	}

	if (!properties.areasymbol) {
		throw new Error(`soil ingest: delineation ${properties.fid} carries no AREASYMBOL`)
	}

	const polygons = requireArealPolygons(geometry, `delineation ${properties.fid}`, "soil ingest")

	assertRingsInsideExtent(polygons, `delineation ${properties.fid}`, extent, BBOX_MARGIN_DEGREES, "soil ingest")

	return {
		areaID: `${properties.areasymbol}:${properties.fid}`,
		mukey: String(properties.mukey),
		areasymbol: properties.areasymbol,
		polygons,
	}
}

/**
 * Where a build's delineations come from, and what the source declares about itself.
 *
 * The builder takes ONE of these rather than a path, which is what makes the fixture rung possible: hand-built geometry
 * with no network and no GDAL still exercises the whole database half — the domain check, the cell classification, the
 * reduction, the coverage rows, the manifest and the seal.
 */
export interface SoilFeatureSource {
	areaSymbol: string
	/**
	 * What the source says it holds. The build compares its own streamed total against this, so a short read throws
	 * instead of building a smaller county.
	 */
	declaredFeatureCount: number
	layer: string
	epsg: number
	/**
	 * A description of where these delineations came from, for the receipt.
	 */
	origin: string
	delineations: () => AsyncIterable<SoilDelineation>
}

/**
 * One survey area's map-unit shapefile as a feature source — identity read up front, features streamed on demand.
 */
export async function createShapefileFeatureSource(
	options: SoilIngestOptions & { areaSymbol: string; declaredFeatureCount?: number }
): Promise<SoilFeatureSource> {
	const identity = await readSoilSourceIdentity(options)

	return {
		areaSymbol: options.areaSymbol,
		// A RANGE's own count is supplied by the caller, because `ogrinfo` reports the layer's total and nothing narrower.
		// The whole-file total is still checked: the builder sums what its chunks streamed and compares that.
		declaredFeatureCount:
			options.declaredFeatureCount ??
			// A `--limit` above the layer's real count reads every feature there is; the count the builder checks against
			// is then the layer's, not the limit's, or a complete read throws as a short one.
			(options.limit === undefined ? identity.featureCount : Math.min(options.limit, identity.featureCount)),
		layer: identity.layer,
		epsg: identity.epsg,
		origin: options.shapefilePath,
		delineations: () => readSoilDelineations({ ...options, bbox: identity.bbox }),
	}
}
