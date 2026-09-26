/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read the EA flood geodatabase as a stream of WGS84 features through ogr2ogr, which is build tooling
 *   only. The declared EPSG is asserted before any feature, every reprojected vertex is checked against
 *   the declared bounding box to catch a swapped axis order, and `OGR_GEOM_AREA` is compared with the
 *   encoded rings to check nesting and holes. Without the OSTN15 grid proj silently uses an approximate
 *   OSGB36 shift, so the identity read refuses the build.
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
	 * Layer to read, defaulting to the EA's published layer name.
	 */
	layer?: string
	/**
	 * Maximum number of features to read, set by fixture and smoke builds.
	 */
	limit?: number
	/**
	 * The EPSG code the source must declare.
	 */
	expectEPSG?: number
	/**
	 * The WGS84 extent every reprojected vertex must fall inside, defaulting to the EA collection's.
	 */
	declaredBBox?: readonly [number, number, number, number]
	/**
	 * Reads only features whose `OBJECTID` lies in `[objectIDFrom, objectIDTo]`, inclusive,
	 * because `OBJECTID` is the source's stable key and a range selects the same features on every run.
	 */
	objectIDFrom?: number
	objectIDTo?: number
}

/**
 * Number of coordinate decimals that ogr2ogr writes; nine is about 0.1 mm,
 * so rounding adds no measurable error to the area cross-check.
 */
const COORDINATE_PRECISION = 9

/**
 * Tolerance in degrees outside the declared extent, because the published extent is rounded
 * while an unprojected or axis-swapped read lands much farther away.
 */
const BBOX_MARGIN_DEGREES = 0.01

/**
 * Reads the layer's declared EPSG code and feature count before any feature.
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
 * Streams the layer as WGS84 features, checking each against the declared extent.
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
 * A source of flood features together with the source's declared metadata, accepted instead
 * of a path so fixture builds can supply hand-built geometry without GDAL or network access.
 */
export interface FloodFeatureSource {
	/**
	 * The feature count the source declares, which the build checks when it streams a different total.
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
 * Creates a feature source for the published geodatabase, reading the layer identity
 * immediately and streaming features on demand.
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
