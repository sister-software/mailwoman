/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read the Department's bulk export as a stream of WGS84 features, through ogr2ogr.
 *
 *   OGR IS BUILD TOOLING, NEVER A SERVE DEPENDENCY (SCOPE invariant 6). It converts the authority's geometry
 *   into the structure the runtime probes, and nothing downstream of this module knows GDAL exists.
 *
 *   THE STREAM IS WKT, NOT GEOJSON, AND THAT IS A CORRECTNESS CHOICE RATHER THAN A TASTE ONE. This service
 *   encodes hole roles by ring ORIENTATION — clockwise exterior, the inverse of RFC 7946 — and puts each ring
 *   in its own `MultiPolygon` part on the features that carry holes that way. GDAL's GeoJSON writer enforces
 *   the RFC 7946 winding unconditionally: `-lco RFC7946=NO` is not a GeoJSONSeq option, and
 *   `--config OGR_ORGANIZE_POLYGONS SKIP` changes nothing. Measured on the largest feature in the country,
 *   Meath's `RA - Rural Area`: through GeoJSONSeq it arrives as 107 counter-clockwise rings totalling
 *   2,371.9 km², through CSV/WKT as the source's own 5 clockwise and 102 counter-clockwise totalling
 *   2,223.1 km² against the Department's published 2,232.1 km². The GeoJSON path has silently turned 102
 *   holes into 102 zoned areas.
 *
 *   AND THE TRANSPORT IS NOT THE SLOW HALF. Measured on this lab over the whole national export: ogr2ogr
 *   reprojects to 224,066,621 bytes of WKT CSV in 13.2 s, and `CSVSpliterator` plus the WKT parse reads
 *   85,330 rows, 93,483 rings and 6,327,256 positions back out of it in 2.2 s.
 *
 *   THE SOURCE IS NOT IN WGS84 AND SAYING SO IS THE CHECK. The bulk export is IRENET95 / Irish Transverse
 *   Mercator — metres, easting/northing, EPSG:2157 — declared in a top-level `crs` member RFC 7946 removed
 *   from the format. GDAL honours the legacy member; a strict reader ignores it and places Ireland's zoning
 *   at latitude 735,435. So the projection is asserted against the source's declared authority code before a
 *   single feature is read, and every reprojected vertex is asserted inside the Department's own declared
 *   extent — which is the check that catches a coordinate-order mistake the projection check cannot see.
 *
 *   THE DATUM SHIFT NEEDS A GRID, AND ITS ABSENCE IS SILENT. PROJ substitutes a ballpark offset when the
 *   accurate transformation is unavailable and produces coordinates that are metres wrong and
 *   indistinguishable from correct ones. {@linkcode assertDatumTransformationAvailable} asks `projinfo` what
 *   PROJ would choose and refuses a ballpark; for this source it names
 *   `Inverse of Irish Transverse Mercator + IRENET95 to WGS 84 (1), 1 m`.
 *
 *   THE PUBLISHER'S OWN AREA COLUMN IS NOT IN THE ARCHIVE. `Shape__Area` is a service field and the export
 *   drops it, so the area cross-check reads it from the live service instead — which makes it a genuine
 *   two-path check rather than the archive agreeing with itself. See `sdk/client.ts`.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { runFile, spawnProcess } from "@mailwoman/core/process"
import { arealPolygons, assertRingsInsideExtent } from "@mailwoman/spatial"
import { assertDatumTransformationAvailable as assertDatumTransformation } from "@mailwoman/spatial/projection-transform"
import { wellKnownGeometryToGeoJSON } from "@mailwoman/spatial/sdk/well-known-text"
import { CSVSpliterator } from "spliterator"

import { resolveRingRoles, type MultiPolygonRings, type ResolvedRingRoles } from "#rings"
import { GZT_DECLARED_BBOX, GZT_SOURCE_EPSG } from "#vocabulary"

/**
 * The ring types and the PROJ guard, both re-exported from `@mailwoman/spatial`: neither is zoning-specific, and a
 * second copy of the `projinfo` parse would be a second place for the ballpark check to stop refusing.
 */
export { assessDatumTransformation, type DatumTransformationVerdict } from "@mailwoman/spatial/projection-transform"
export type { MultiPolygonRings, PolygonRings } from "#rings"

/**
 * One zoning feature, reprojected to WGS84 with its hole roles resolved.
 */
export interface ZoningSourceFeature {
	/**
	 * The authority's own `OBJECTID`, as a string.
	 */
	areaID: string
	/**
	 * `LA_CODE`, verbatim — `Fl` for Fingal, and never repaired.
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
	 * `ZONE_ORIG`, verbatim, including case and any trailing space.
	 */
	localCode: string
	localDescription: string | null
	localCodeURL: string | null
	/**
	 * `ZONE_GZT` — the Department's national generic type for THIS polygon.
	 */
	crosswalkCode: string | null
	crosswalkDescription: string | null
	/**
	 * `SZO` — the coarser national code, as published.
	 */
	crosswalkRollup: string | null
	/**
	 * The rings, with hole roles resolved from orientation, plus the receipt of that resolution.
	 */
	rings: ResolvedRingRoles
}

/**
 * What the ingest was pointed at.
 */
export interface ZoningIngestOptions {
	/**
	 * Path to the bulk GeoJSON export.
	 */
	exportPath: string
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
	 * The extent every reprojected vertex must land inside. Defaults to the Department's own declaration.
	 */
	declaredBBox?: readonly [number, number, number, number]
	/**
	 * Read only the authority's feature ids in `[objectIDFrom, objectIDTo]`, inclusive.
	 *
	 * This is what makes a bounded build possible: h3's WASM heap cannot be reset from JavaScript, so the classification
	 * runs one child process per range of the authority's OWN ids. Ranges rather than an offset because `OBJECTID` is the
	 * source's stable key — a range names the same features on every run, which an offset into a result set does not.
	 *
	 * A NARROWER RANGE COSTS A WHOLE PASS. The source is one GeoJSON document rather than an indexed store, so ogr2ogr
	 * scans all 247 MB for every range. The national set fits inside one chunk at the default bound, so that cost is not
	 * paid on a full build.
	 */
	objectIDFrom?: number
	objectIDTo?: number
	/**
	 * Restrict to one local authority's own `LA_CODE` — the smoke rung.
	 */
	authorityCode?: string
}

/**
 * What the source declares about itself, read before any feature is.
 */
export interface ZoningSourceIdentity {
	epsg: number
	featureCount: number
	layer: string
	/**
	 * The source's own attribute field names. A `-select` naming a column this set does not hold makes ogr2ogr write an
	 * empty column rather than refuse, so the query is built from the set rather than from a schema read off a sibling
	 * publication.
	 */
	fields: ReadonlySet<string>
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
 * The attribute columns the ingest reads. Every one is required: this product publishes a single schema, and a column
 * that vanished would be a product change rather than a variation to absorb.
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
 * What the source declares about itself: its authority code, its feature count and its field list.
 *
 * @throws {Error} When the export is unreadable, its declared EPSG is not `expectEPSG`, or it is missing a field the
 *   ingest reads.
 */
export async function readZoningSourceIdentity(options: ZoningIngestOptions): Promise<ZoningSourceIdentity> {
	const expectEPSG = options.expectEPSG ?? GZT_SOURCE_EPSG

	const { stdout } = await runFile(
		"ogrinfo",
		["-json", "-so", options.exportPath],
		// The summary is small; the ceiling only guards against a pathological driver.
		{ maxBuffer: 32 * 1024 * 1024 }
	)

	const info = parseJSONStrict<{
		layers?: Array<{
			name?: string
			featureCount?: number
			fields?: Array<{ name?: string }>
			geometryFields?: Array<{ coordinateSystem?: { projjson?: { id?: { code?: number } } } }>
		}>
	}>(stdout)

	const described = info.layers?.[0]

	if (!described?.name) {
		throw new Error(`zoning ingest: ${options.exportPath} carries no readable layer`)
	}

	const code = described.geometryFields?.[0]?.coordinateSystem?.projjson?.id?.code

	if (typeof code !== "number") {
		throw new TypeError(
			`zoning ingest: ${options.exportPath} declares no EPSG authority code — the projection cannot be checked, and reading its metres as degrees is silent`
		)
	}

	if (code !== expectEPSG) {
		throw new Error(
			`zoning ingest: ${options.exportPath} declares EPSG:${code}, expected EPSG:${expectEPSG} — the source's projection changed, which is a product change rather than a variation to absorb`
		)
	}

	if (typeof described.featureCount !== "number") {
		throw new TypeError(`zoning ingest: ${options.exportPath} reports no feature count`)
	}

	await assertDatumTransformation(code, { context: "zoning ingest", areaOfUse: "Ireland" })

	const fields = new Set((described.fields ?? []).map((field) => field.name).filter((name) => name !== undefined))
	const missing = ZONING_SOURCE_FIELDS.filter((field) => field !== "OBJECTID" && !fields.has(field))

	// `-select` on a missing column makes ogr2ogr write an EMPTY column rather than refuse, so a schema change would
	// arrive as a stream of nulls: every local code blank, every plan unnamed, and a well-formed artifact describing
	// nothing. Refused here instead, by name.
	if (missing.length) {
		throw new Error(
			`zoning ingest: ${options.exportPath} carries no ${missing.join(", ")} column(s) — ogr2ogr writes a missing column as empty rather than refusing, so a schema change would arrive as a stream of blank codes`
		)
	}

	return { epsg: code, featureCount: described.featureCount, layer: described.name, fields }
}

/**
 * The `-where` predicate for a bounded chunk or a one-authority smoke run.
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
 * A published value, as a string or null. An EMPTY STRING IS NOT NULL HERE for the local code, which is the one column
 * this layer exists to repeat: a blank one is refused by the ingest rather than stored.
 */
function textOf(value: string | undefined): string | null {
	if (value === undefined) return null

	return value.length ? value : null
}

/**
 * Stream the export through ogr2ogr as reprojected WKT, checking every vertex against the declared extent.
 *
 * A swapped coordinate order survives a projection check — both axes are still numbers in a plausible range — and shows
 * up here immediately, before 85,330 polygons are written to the wrong side of the planet.
 *
 * @throws {Error} When ogr2ogr fails, when a feature carries no geometry, when a reprojected vertex falls outside the
 *   declared extent, or when a feature's rings cannot be resolved into at least one exterior.
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

	const child = spawnProcess("ogr2ogr", args, { stdio: ["ignore", "pipe", "pipe"] })
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
					`zoning ingest: ogr2ogr exited ${code}${stderr.length ? ` — ${stderr.join("").trim()}` : ""}`
				)
			}

			resolve()
		})
	})

	try {
		for await (const row of CSVSpliterator.fromAsync<Record<string, string>>(child.stdout, {
			mode: "object",
			// Opt-in end-to-end quoting: the WKT column carries commas and spaces on every row, so a reader without it
			// mis-splits every feature into hundreds of columns.
			enableQuoteHandling: true,
		})) {
			const areaID = row.OBJECTID ?? ""

			if (!areaID) {
				throw new Error("zoning ingest: a row carries no OBJECTID — the authority's own key is the artifact's key")
			}

			const wkt = row.WKT

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

			const localCode = row.ZONE_ORIG ?? ""

			// The local code is what this layer exists to repeat, so a blank one is refused rather than stored: it would read
			// as a zone the authority named nothing, which is not a reading the authority ever makes.
			if (!localCode.trim()) {
				throw new Error(
					`zoning ingest: feature ${areaID} carries a blank ZONE_ORIG — the authority's own code is the claim, so a blank is refused rather than stored`
				)
			}

			yield {
				areaID,
				authorityCode: row.LA_CODE ?? "",
				authorityName: row.LA_NAME ?? "",
				planID: row.PLAN_ID ?? "",
				planName: row.PLAN_NAME ?? "",
				planLevel: row.PLAN_LEVEL ?? "",
				planFrom: textOf(row.PLAN_FROM),
				planTo: textOf(row.PLAN_TO),
				currentPlan: Number(row.CURRENT_PLAN ?? 0),
				// VERBATIM, and deliberately un-trimmed: `Proposed Residential ` carries a trailing space in the source, and
				// five of the 581 distinct strings collide with another only on case or that space.
				localCode,
				localDescription: textOf(row.ZONE_DESC),
				localCodeURL: textOf(row.ZONE_LINK),
				crosswalkCode: textOf(row.ZONE_GZT),
				crosswalkDescription: textOf(row.GZT_DESC),
				crosswalkRollup: textOf(row.SZO),
				rings: resolveRingRoles(polygons, areaID),
			}
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill()
		}
	}

	await exited

	// A truncated stream reads as a short but well-formed feature list, which is exactly the partial result that must throw
	// rather than be reported as a smaller country.
	if (exitError) throw exitError
}

/**
 * Parse one WKT geometry into the ring shape the rest of this package works in.
 *
 * @throws {Error} When the geometry is neither a `Polygon` nor a `MultiPolygon`.
 */
function normalizePolygons(wkt: string, label: string): MultiPolygonRings {
	const geometry = wellKnownGeometryToGeoJSON<{ type: string; coordinates: unknown }>(wkt)
	const polygons = arealPolygons(geometry)

	if (polygons) return polygons

	throw new Error(`zoning ingest: ${label} is a ${geometry.type}, expected Polygon or MultiPolygon`)
}

/**
 * Where a build's features come from, and what the source declares about itself.
 *
 * The builder takes ONE of these rather than a path, which is what makes the fixture rung possible: hand-built geometry
 * with no network and no GDAL still exercises the whole database half — the domain checks, the ring-role resolution,
 * the cell classification, the coverage rows, the manifest and the seal. A fixture rung that could only run through
 * ogr2ogr would test the conversion on the machines that have it and nothing at all on the ones that do not.
 */
export interface ZoningFeatureSource {
	/**
	 * What the source says it holds. The build compares its own streamed total against this, so a short read throws
	 * instead of building a smaller country.
	 */
	declaredFeatureCount: number
	epsg: number
	/**
	 * A description of where these features came from, for the receipt.
	 */
	origin: string
	features: () => AsyncIterable<ZoningSourceFeature>
}

export interface ExportSourceOptions extends ZoningIngestOptions {
	declaredFeatureCount?: number
}

/**
 * The bulk export as a feature source — identity read up front, features streamed on demand.
 */
export async function createExportFeatureSource(options: ExportSourceOptions): Promise<ZoningFeatureSource> {
	const identity = await readZoningSourceIdentity(options)

	return {
		// A RANGE's or an authority's own count is supplied by the caller, because `ogrinfo` reports a layer's total and
		// nothing narrower.
		declaredFeatureCount:
			options.declaredFeatureCount ??
			(options.limit === undefined ? identity.featureCount : Math.min(options.limit, identity.featureCount)),
		epsg: identity.epsg,
		origin: options.exportPath,
		features: () => readZoningFeatures(options),
	}
}
