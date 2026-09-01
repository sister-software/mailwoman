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
 *   are metres wrong and indistinguishable from correct ones. The identity read refuses the build rather
 *   than letting the whole layer shift.
 */

import { ogr2ogrGeoJSONSeq } from "@mailwoman/core/utils"
import { assertRingsInsideExtent, requireArealPolygons, type MultiPolygonRings } from "@mailwoman/spatial"
import { readOGRLayerIdentity } from "@mailwoman/spatial/tools/ogr"

import { EA_DECLARED_BBOX, EA_FLOOD_LAYER, EA_SOURCE_EPSG } from "#vocabulary"

/**
 * The ring types, and the PROJ guard, both re-exported from `@mailwoman/spatial`: neither is flood-specific, and a
 * second copy of the `projinfo` parse would be a second place for the ballpark check to stop refusing.
 */
export { assessDatumTransformation, type DatumTransformationVerdict } from "@mailwoman/spatial/projection-transform"
export type { MultiPolygonRings, PolygonRings } from "@mailwoman/spatial"

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
	/**
	 * Read only the authority's feature ids in `[objectIDFrom, objectIDTo]`, inclusive.
	 *
	 * This is what makes a bounded build possible: the classification cannot run over the whole file in one process (see
	 * `ingest-chunk.ts`), so the builder walks ranges of the authority's OWN ids. Ranges rather than an offset because
	 * `OBJECTID` is the source's stable key — a range names the same features on every run, which an offset into a result
	 * set does not.
	 */
	objectIDFrom?: number
	objectIDTo?: number
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
 * The ingest's `SELECT`, with the id range applied when one is asked for.
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
		floodSelectSQL(layer, options),
		options.geodatabasePath,
	]

	for await (const raw of ogr2ogrGeoJSONSeq<RawFeature>(args, "flood ingest")) {
		yield toSourceFeature(raw, { minLon, minLat, maxLon, maxLat })
	}
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
export async function createGeodatabaseFeatureSource(
	options: FloodIngestOptions & { declaredFeatureCount?: number }
): Promise<FloodFeatureSource> {
	const identity = await readFloodSourceIdentity(options)

	return {
		// A RANGE's own count is supplied by the caller, because `ogrinfo` reports the layer's total and nothing narrower.
		// The whole-file total is still checked: the builder sums what its chunks streamed and compares that.
		declaredFeatureCount: options.declaredFeatureCount ?? options.limit ?? identity.featureCount,
		layer: identity.layer,
		epsg: identity.epsg,
		origin: options.geodatabasePath,
		features: () => readFloodSourceFeatures(options),
	}
}
