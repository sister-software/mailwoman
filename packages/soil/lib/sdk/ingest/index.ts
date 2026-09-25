/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { declaredFeatureCount } from "@mailwoman/core/layers"
import { assertRingsInsideExtent, requireArealPolygons, type MultiPolygonRings } from "@mailwoman/spatial"
import { readOGRLayerIdentity } from "@mailwoman/spatial/tools/ogr"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"
import { basename, PathBuilder, type PathBuilderLike } from "path-ts"

import { SSURGO_SOURCE_EPSG } from "#vocabulary"

const COORDINATE_PRECISION = 9

const BBOX_MARGIN_DEGREES = 0.1

/**
 * The shapefile holding a survey area's map-unit polygons — the delineations this layer stores.
 */
export function mapUnitShapefile(spatialDirectory: PathBuilderLike, areaSymbol: string): string {
	return PathBuilder.from(spatialDirectory)(`soilmu_a_${areaSymbol.toLowerCase()}.shp`).toString()
}

/**
 * Returns the path of the shapefile holding a survey area's outline.
 *
 * The footprint comes from this outline rather than from the union of rated polygons, because
 * unrated map units such as `notcom` lie inside the footprint and would otherwise read as unmapped.
 */
export function surveyAreaShapefile(spatialDirectory: PathBuilderLike, areaSymbol: string): PathBuilder {
	return PathBuilder.from(spatialDirectory)(`soilsa_a_${areaSymbol.toLowerCase()}.shp`)
}

/**
 * One map-unit delineation, reprojected to WGS84.
 */
export interface SoilDelineation {
	/**
	 * The delineation's identifier, formed as `<areasymbol>:<fid>`.
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
	 * The layer's declared extent as `[minLon, minLat, maxLon, maxLat]`.
	 */
	bbox: readonly [number, number, number, number]
}

/**
 * Options for reading one SSURGO map-unit shapefile, with optional FID bounds
 * and a feature limit for partial reads.
 */
export interface SoilIngestOptions {
	shapefilePath: string

	/**
	 * The layer inside the shapefile, defaulting to the file's base name,
	 * which is what the ESRI driver reports.
	 */
	layer?: string

	/**
	 * The EPSG code the source must declare, defaulting to the SSURGO source projection.
	 */
	expectEPSG?: number

	/**
	 * The lower bound of an inclusive `[fidFrom, fidTo]` range of the shapefile's own FIDs,
	 * which lets a build read a bounded chunk.
	 */
	fidFrom?: number
	fidTo?: number

	/**
	 * The maximum number of features to read, used by fixture and smoke runs but not by a full build.
	 */
	limit?: number
}

/**
 * Reads the projection, feature count, layer name and extent that a shapefile declares,
 * throwing when it declares a projection other than `expectEPSG`.
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
 * Streams a shapefile's map-unit delineations reprojected to WGS84, throwing on a feature
 * with no geometry or `mukey` or with a vertex outside the declared extent.
 *
 * The extent check catches swapped coordinate axes, which a projection check alone would not.
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
 * Supplies a soil build with its delineations and the source's declared identity.
 *
 * The builder takes this instead of a path, so fixtures can exercise the whole
 * database half without network access or GDAL.
 */
export interface SoilFeatureSource {
	areaSymbol: string

	/**
	 * The feature count the source declares, which the build compares with its
	 * streamed total so that a short read throws.
	 */
	declaredFeatureCount: number
	layer: string
	epsg: number

	/**
	 * A description of where the delineations came from, such as the shapefile path.
	 */
	origin: string
	delineations: () => AsyncIterable<SoilDelineation>
}

/**
 * Creates a {@link SoilFeatureSource} for one survey area's shapefile, reading its
 * identity immediately and streaming features on demand.
 */
export async function createShapefileFeatureSource(
	options: SoilIngestOptions & { areaSymbol: string; declaredFeatureCount?: number }
): Promise<SoilFeatureSource> {
	const identity = await readSoilSourceIdentity(options)

	return {
		areaSymbol: options.areaSymbol,

		declaredFeatureCount: declaredFeatureCount({
			declared: options.declaredFeatureCount,
			limit: options.limit,
			layerCount: identity.featureCount,
		}),
		layer: identity.layer,
		epsg: identity.epsg,
		origin: options.shapefilePath,
		delineations: () => readSoilDelineations({ ...options, bbox: identity.bbox }),
	}
}
