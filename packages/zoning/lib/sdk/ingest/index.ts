/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Streams the Department's bulk zoning export through ogr2ogr as reprojected WGS84 features.
 *
 *   The stream uses CSV with WKT geometry because the source marks holes by ring orientation, and GDAL's
 *   GeoJSON writer rewinds every ring to RFC 7946 order, which turns holes into zoned areas. The source is
 *   in EPSG:2157, declared in a legacy top-level `crs` member that GDAL honours.
 */

import { declaredFeatureCount } from "@mailwoman/core/layers"
import { assertRingsInsideExtent, requireArealPolygons, type MultiPolygonRings } from "@mailwoman/spatial"
import { readOGRLayerIdentity } from "@mailwoman/spatial/tools/ogr"
import { spawnOGR2OGR } from "@mailwoman/spatial/tools/ogr-stream"
import { wellKnownGeometryToGeoJSON } from "@mailwoman/spatial/well-known-text"
import { CSVSpliterator } from "spliterator"

import { resolveRingRoles, type ResolvedRingRoles } from "#rings"
import { GZT_DECLARED_BBOX, GZT_SOURCE_EPSG } from "#vocabulary"

/**
 * One zoning feature, reprojected to WGS84 with its hole roles resolved.
 */
export interface ZoningSourceFeature {
	/**
	 * The authority's `objectid` as a string.
	 */
	areaID: string
	/**
	 * The `LA_CODE` value, verbatim.
	 * Fingal's unusual `Fl` code is kept as published.
	 */
	authorityCode: string
	authorityName: string
	planID: string
	planName: string
	planLevel: string
	planFrom: string | null
	planTo: string | null
	currentPlan: number
	/**
	 * The `ZONE_ORIG` value, verbatim.
	 *
	 * Case and trailing spaces are kept because some codes differ only by them.
	 */
	localCode: string
	localDescription: string | null
	localCodeURL: string | null
	/**
	 * The `ZONE_GZT` value, which is the Department's national generic type for this polygon.
	 */
	crosswalkCode: string | null
	crosswalkDescription: string | null
	/**
	 * The `SZO` value, which is the coarser national code, as published.
	 */
	crosswalkRollup: string | null
	/**
	 * The rings with hole roles resolved from their orientation, plus a record of that resolution.
	 */
	rings: ResolvedRingRoles
}

/**
 * Options for reading the bulk export.
 */
export interface ZoningIngestOptions {
	/**
	 * The path of the bulk GeoJSON export.
	 */
	exportPath: string
	/**
	 * The maximum number of features to read.
	 * Fixture and smoke runs use it.
	 */
	limit?: number
	/**
	 * The EPSG code that the source must declare.
	 * A different code means the product has changed.
	 */
	expectEPSG?: number
	/**
	 * The extent that every reprojected vertex must fall inside.
	 * The default is the Department's declared extent.
	 */
	declaredBBox?: readonly [number, number, number, number]
	/**
	 * The inclusive range of authority `objectid` values to read.
	 *
	 * The h3 wasm heap cannot be reset from JavaScript, so the build runs one child process per range.
	 * It uses `objectid` ranges because they select the same features on every run.
	 *
	 * Every range costs a full scan of the export, because the export is one GeoJSON document.
	 */
	objectIDFrom?: number
	objectIDTo?: number
	/**
	 * Restricts the read to one local authority's `LA_CODE`, for smoke runs.
	 */
	authorityCode?: string
}

/**
 * The metadata that the source declares, read before any feature.
 */
export interface ZoningSourceIdentity {
	epsg: number
	featureCount: number
	layer: string
	/**
	 * The source's attribute field names.
	 */
	fields: ReadonlySet<string>
}

/**
 * The number of coordinate decimals that ogr2ogr writes.
 * Nine decimals is far finer than the source's precision.
 */
const COORDINATE_PRECISION = 9

/**
 * The distance in degrees that a vertex may fall outside the declared extent.
 *
 * The published extent is rounded, so an exact test would fail on valid data.
 * An unprojected or axis-swapped read lands much farther away and still fails.
 */
const BBOX_MARGIN_DEGREES = 0.01

/**
 * The attribute columns that the ingest reads.
 * Every column is required.
 */
export const ZONING_SOURCE_FIELDS: ReadonlyArray<string> = [
	"OBJECTID",
	"LA_CODE",
	"LA_NAME",
	"PLAN_ID",
	"PLAN_NAME",
	"PLAN_LEVEL",
	"PLAN_FROM",
	"PLAN_TO",
	"CURRENT_PLAN",
	"ZONE_ORIG",
	"ZONE_DESC",
	"ZONE_LINK",
	"ZONE_GZT",
	"GZT_DESC",
	"SZO",
]

/**
 * Reads the source's declared projection, feature count and field list.
 *
 * @throws {Error} When the export is unreadable, when its declared EPSG code differs
 * from `expectEPSG`, or when it lacks a field that the ingest reads.
 */
export async function readZoningSourceIdentity(options: ZoningIngestOptions): Promise<ZoningSourceIdentity> {
	const identity = await readOGRLayerIdentity({
		path: options.exportPath,
		expectEPSG: options.expectEPSG ?? GZT_SOURCE_EPSG,
		context: "zoning ingest",
		areaOfUse: "Ireland",
	})

	const missing = ZONING_SOURCE_FIELDS.filter((field) => field !== "OBJECTID" && !identity.fields.has(field))

	// Given a missing column, `-select` makes ogr2ogr write an empty column without an error.
	// This check turns a source schema change into an error that lists the missing columns.
	if (missing.length) {
		throw new Error(
			`zoning ingest: ${options.exportPath} carries no ${missing.join(", ")} column(s) — ogr2ogr writes a missing column as empty rather than refusing, so a schema change would arrive as a stream of blank codes`
		)
	}

	return { epsg: identity.epsg, featureCount: identity.featureCount, layer: identity.layer, fields: identity.fields }
}

/**
 * Returns the `-where` arguments for a bounded chunk or a one-authority smoke run.
 */
function whereClause(options: ZoningIngestOptions): string[] {
	const bounds: string[] = []

	if (options.objectIDFrom !== undefined) {
		bounds.push(`OBJECTID >= ${options.objectIDFrom}`)
	}

	if (options.objectIDTo !== undefined) {
		bounds.push(`OBJECTID <= ${options.objectIDTo}`)
	}

	if (options.authorityCode !== undefined) {
		bounds.push(`LA_CODE = '${options.authorityCode.replaceAll("'", "''")}'`)
	}

	return bounds.length ? ["-where", bounds.join(" AND ")] : []
}

/**
 * Returns the value, or null when it is undefined or empty.
 */
function blankToNull(value: string | undefined): string | null {
	if (value === undefined) return null

	return value.length ? value : null
}

/**
 * Streams the export through ogr2ogr as reprojected WKT and checks every vertex against the declared extent.
 *
 * The extent check catches swapped coordinate axes, which the projection check misses.
 *
 * @throws {Error} When ogr2ogr fails, when a feature has no geometry or a blank local code, when
 * a reprojected vertex falls outside the declared extent, or when a feature's rings have no exterior.
 */
export async function* readZoningFeatures(options: ZoningIngestOptions): AsyncGenerator<ZoningSourceFeature> {
	const [minLon, minLat, maxLon, maxLat] = options.declaredBBox ?? GZT_DECLARED_BBOX

	const args = [
		"-f",
		"CSV",
		"/vsistdout/",
		"-t_srs",
		"EPSG:4326",
		"-lco",
		"GEOMETRY=AS_WKT",
		"-lco",
		"CREATE_CSVT=NO",
		"-lco",
		`COORDINATE_PRECISION=${COORDINATE_PRECISION}`,
		"-select",
		ZONING_SOURCE_FIELDS.join(","),
		...whereClause(options),
		...(options.limit === undefined ? [] : ["-limit", String(options.limit)]),
		options.exportPath,
	]

	const proc = spawnOGR2OGR(args, "zoning ingest")

	try {
		for await (const row of CSVSpliterator.fromAsync<Record<string, string>>(proc.stdout)) {
			const areaID = row.objectid ?? ""

			if (!areaID) {
				throw new Error("zoning ingest: a row carries no OBJECTID — the authority's own key is the artifact's key")
			}

			const wkt = row.wkt

			if (!wkt) {
				throw new Error(`zoning ingest: feature ${areaID} carries no geometry`)
			}

			const polygons = normalizePolygons(wkt, `feature ${areaID}`)

			assertRingsInsideExtent(
				polygons,
				`feature ${areaID}`,
				{ minLon, minLat, maxLon, maxLat },
				BBOX_MARGIN_DEGREES,
				"zoning ingest"
			)

			const localCode = row.zone_orig ?? ""

			// The authority never publishes a zone without a code, so a blank code is an error.
			if (!localCode.trim()) {
				throw new Error(
					`zoning ingest: feature ${areaID} carries a blank ZONE_ORIG — the authority's own code is the claim, so a blank is refused rather than stored`
				)
			}

			yield {
				areaID,
				authorityCode: row.la_code ?? "",
				authorityName: row.la_name ?? "",
				planID: row.plan_id ?? "",
				planName: row.plan_name ?? "",
				planLevel: row.plan_level ?? "",
				planFrom: blankToNull(row.plan_from),
				planTo: blankToNull(row.plan_to),
				currentPlan: Number(row.current_plan ?? 0),
				// The code stays untrimmed because some distinct codes differ only by case or a trailing space.
				localCode,
				localDescription: blankToNull(row.zone_desc),
				localCodeURL: blankToNull(row.zone_link),
				crosswalkCode: blankToNull(row.zone_gzt),
				crosswalkDescription: blankToNull(row.gzt_desc),
				crosswalkRollup: blankToNull(row.szo),
				rings: resolveRingRoles(polygons, areaID),
			}
		}
	} finally {
		proc.kill()
	}

	await proc.settled
}

/**
 * Parses one WKT geometry into `MultiPolygon` rings.
 *
 * @throws {Error} When the geometry is neither a `Polygon` nor a `MultiPolygon`.
 */
function normalizePolygons(wkt: string, label: string): MultiPolygonRings {
	const geometry = wellKnownGeometryToGeoJSON<{ type: string; coordinates: unknown }>(wkt)

	return requireArealPolygons(geometry, label, "zoning ingest")
}

/**
 * Supplies a zoning build with its features and the source's declared identity.
 *
 * The builder takes this instead of a path so that fixtures can run the database
 * build without network access or GDAL.
 */
export interface ZoningFeatureSource {
	/**
	 * The feature count that the source declares.
	 *
	 * The build throws when its streamed total differs from this count.
	 */
	declaredFeatureCount: number
	epsg: number
	/**
	 * A description of where the features came from, such as the export path.
	 */
	origin: string
	features: () => AsyncIterable<ZoningSourceFeature>
}

/**
 * Options for {@link createExportFeatureSource}.
 */
export interface ExportSourceOptions extends ZoningIngestOptions {
	declaredFeatureCount?: number
}

/**
 * Creates a {@link ZoningFeatureSource} for the bulk export.
 *
 * It reads the export's identity immediately and streams features when asked.
 */
export async function createExportFeatureSource(options: ExportSourceOptions): Promise<ZoningFeatureSource> {
	const identity = await readZoningSourceIdentity(options)

	return {
		// The caller supplies the count for a range or one authority, because
		// `ogrinfo` reports only the layer's total.
		declaredFeatureCount: declaredFeatureCount({
			declared: options.declaredFeatureCount,
			limit: options.limit,
			layerCount: identity.featureCount,
		}),
		epsg: identity.epsg,
		origin: options.exportPath,
		features: () => readZoningFeatures(options),
	}
}
