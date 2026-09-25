/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the EA flood geodatabase as a stream of WGS84 features through ogr2ogr.
 *
 *   GDAL is build tooling only. Nothing downstream of this module depends on it.
 *
 *   The source is in British National Grid (EPSG:27700, metres). The ingest asserts the declared EPSG code
 *   before reading any feature, and it checks every reprojected vertex against the collection's declared
 *   bounding box. The bounding-box check catches a swapped axis order, which the EPSG check cannot see.
 *
 *   Each feature also carries `OGR_GEOM_AREA`, which GDAL computes in source metres before reprojection.
 *   Comparing it with the area of the encoded rings checks ring nesting and hole handling. See
 *   `ringAreaReadings` in `rings.ts`.
 *
 *   The OSGB36 to WGS84 shift is accurate only with the OSTN15 grid. Without the grid, proj silently uses
 *   an approximate offset, so the identity read refuses the build instead.
 */

import { declaredFeatureCount } from "@mailwoman/core/layers"
import { assertRingsInsideExtent, requireArealPolygons, type MultiPolygonRings } from "@mailwoman/spatial"
import { readOGRLayerIdentity } from "@mailwoman/spatial/tools/ogr"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"

import { EA_DECLARED_BBOX, EA_FLOOD_LAYER, EA_SOURCE_EPSG } from "#vocabulary"

/**
 * One source feature, reprojected to WGS84.
 */
export interface FloodSourceFeature {
	areaID: string
	zoneCode: string
	zoneSource: string | null
	origin: string | null
	/**
	 * GDAL's area of the source geometry, in square metres of the source projection.
	 */
	sourceAreaM2: number
	polygons: MultiPolygonRings
}

/**
 * Options for reading the flood geodatabase.
 */
export interface FloodIngestOptions {
	/**
	 * Path to the unzipped `.gdb` directory.
	 */
	geodatabasePath: string
	/**
	 * Layer to read.
	 * Defaults to the EA's published layer name.
	 */
	layer?: string
	/**
	 * Maximum number of features to read.
	 * Fixture and smoke builds set it.
	 */
	limit?: number
	/**
	 * The EPSG code the source must declare.
	 */
	expectEPSG?: number
	/**
	 * The WGS84 extent that every reprojected vertex must fall inside.
	 * Defaults to the EA collection's declared extent.
	 */
	declaredBBox?: readonly [number, number, number, number]
	/**
	 * Reads only features whose `OBJECTID` lies in `[objectIDFrom, objectIDTo]`, inclusive.
	 *
	 * The builder cannot classify the whole file in one process (see `ingest-chunk.ts`),
	 * so it reads ranges of `OBJECTID`.
	 * The ingest uses ID ranges instead of offsets because `OBJECTID` is the source's
	 * stable key, so a range selects the same features on every run.
	 */
	objectIDFrom?: number
	objectIDTo?: number
}

/**
 * Number of coordinate decimals that ogr2ogr writes.
 *
 * Nine decimals is about 0.1 mm, so rounding adds nothing measurable to the area cross-check.
 */
const COORDINATE_PRECISION = 9

/**
 * Tolerance in degrees outside the declared extent.
 *
 * The published extent is rounded, so an exact test would be brittle.
 * An unprojected or axis-swapped read lands much farther away and still fails.
 */
const BBOX_MARGIN_DEGREES = 0.01

/**
 * Reads the layer's declared EPSG code and feature count before any feature is read.
 *
 * @throws {Error} When the layer is missing or its declared EPSG code differs from `expectEPSG`.
 */
export async function readFloodSourceIdentity(
	options: FloodIngestOptions
): Promise<{ epsg: number; featureCount: number; layer: string }> {
	const identity = await readOGRLayerIdentity({
		path: options.geodatabasePath,
		layer: options.layer ?? EA_FLOOD_LAYER,
		expectEPSG: options.expectEPSG ?? EA_SOURCE_EPSG,
		context: "flood ingest",
		areaOfUse: "United Kingdom",
	})

	return { epsg: identity.epsg, featureCount: identity.featureCount, layer: identity.layer }
}

/**
 * Builds the ogr2ogr SQL query, including the optional `OBJECTID` range.
 */
function floodSelectSQL(layer: string, options: FloodIngestOptions): string {
	const select = `SELECT OBJECTID AS area_id, origin, flood_zone, flood_source, OGR_GEOM_AREA AS source_area_m2 FROM ${layer}`
	const bounds: string[] = []

	if (options.objectIDFrom !== undefined) {
		bounds.push(`OBJECTID >= ${options.objectIDFrom}`)
	}

	if (options.objectIDTo !== undefined) {
		bounds.push(`OBJECTID <= ${options.objectIDTo}`)
	}

	return bounds.length ? `${select} WHERE ${bounds.join(" AND ")}` : select
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
 * Streams the layer as WGS84 features and checks each one against the declared extent.
 *
 * @throws {Error} When ogr2ogr fails, when a feature lacks geometry or a zone value,
 * or when a reprojected vertex falls outside the declared extent.
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
		floodSelectSQL(layer, options),
		options.geodatabasePath,
	]

	for await (const raw of ogr2ogrGeoJSONSeq<RawFeature>(args, "flood ingest")) {
		yield toSourceFeature(raw, { minLon, minLat, maxLon, maxLat })
	}
}

/**
 * Validates one raw GeoJSON feature and converts it to a source feature.
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

	const polygons = requireArealPolygons(geometry, `feature ${properties.area_id}`, "flood ingest")

	assertRingsInsideExtent(polygons, `feature ${properties.area_id}`, extent, BBOX_MARGIN_DEGREES, "flood ingest")

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
 * A source of flood features together with the source's declared metadata.
 *
 * The builder accepts this interface instead of a path so that fixture builds can
 * supply hand-built geometry without GDAL or network access.
 */
export interface FloodFeatureSource {
	/**
	 * The feature count the source declares.
	 * The build throws when it streams a different total.
	 */
	declaredFeatureCount: number
	layer: string
	epsg: number
	/**
	 * A description of where the features came from, recorded in the build receipt.
	 */
	origin: string
	features: () => AsyncIterable<FloodSourceFeature>
}

/**
 * Creates a feature source for the published geodatabase.
 *
 * It reads the layer identity immediately and streams features on demand.
 */
export async function createGeodatabaseFeatureSource(
	options: FloodIngestOptions & { declaredFeatureCount?: number }
): Promise<FloodFeatureSource> {
	const identity = await readFloodSourceIdentity(options)

	return {
		// The caller supplies a range's count because `ogrinfo` reports only the layer total.
		// The builder still checks the layer total against the sum of its chunks.
		declaredFeatureCount: declaredFeatureCount({
			declared: options.declaredFeatureCount,
			limit: options.limit,
			layerCount: identity.featureCount,
		}),
		layer: identity.layer,
		epsg: identity.epsg,
		origin: options.geodatabasePath,
		features: () => readFloodSourceFeatures(options),
	}
}
