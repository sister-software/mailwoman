/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Read the published file geodatabase as a stream of WGS84 features, through ogr2ogr — one scenario layer
 *   at a time.
 *
 *   OGR IS BUILD TOOLING, NEVER A SERVE DEPENDENCY (SCOPE invariant 6). It converts the authority's geometry
 *   into the structure the runtime probes, and nothing downstream of this module knows GDAL exists.
 *
 *   THE SOURCE IS NOT IN WGS84 AND SAYING SO IS THE CHECK. Every NCERM layer is published in OSGB36 /
 *   British National Grid — metres, easting/northing, EPSG:27700 — so a builder that read the coordinates as
 *   degrees would place every polygon off the west coast of Africa. The projection is asserted against each
 *   layer's declared authority code before a single feature is read, and the reprojected stream is asserted
 *   against the collection's own declared bounding box, which is the check that catches a coordinate-order
 *   mistake the projection check cannot see.
 *
 *   THE DATUM SHIFT NEEDS A GRID, AND ITS ABSENCE IS SILENT. OSGB36 to WGS84 is accurate to a metre only
 *   through the OSTN15 grid; without it PROJ substitutes a ballpark offset and produces coordinates that are
 *   metres wrong and indistinguishable from correct ones. On the sibling flood product that showed up only as
 *   eight disagreements out of 59 against the authority's own service.
 *   {@linkcode assertDatumTransformationAvailable} refuses the build rather than letting the whole layer
 *   shift.
 *
 *   `OGR_GEOM_AREA` RIDES ALONG AS THE INDEPENDENT AREA WITNESS. GDAL computes it on the SOURCE geometry in
 *   the source's own metres, before reprojection and before this package has touched a ring — so comparing it
 *   against an area computed from the encoded rings is a two-path check on ring nesting and hole handling,
 *   which are otherwise silent when wrong.
 *
 *   THE DISTANCE COLUMN IS NAMED PER LAYER AND IS ALIASED HERE. `nfi2055_0` on NFI/2055/0CC, `smp2105_95` on
 *   SMP/2105/95CC — twelve names for one quantity. The `SELECT` aliases whichever one this scenario declares
 *   to `distance_m`, so nothing downstream carries twelve branches, and a scenario whose column has been
 *   renamed fails as a SQL error naming the column rather than as a stream of null distances.
 */

import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"

import { parseJSONStrict } from "@mailwoman/core/objects"
import type { MultiPolygonRings, PolygonRings } from "@mailwoman/spatial"
import { assertDatumTransformationAvailable as assertDatumTransformation } from "@mailwoman/spatial/projection-transform"
import { JSONSpliterator } from "spliterator"

import {
	NCERM_DECLARED_BBOX,
	NCERM_SCENARIOS_BY_KEY,
	NCERM_SOURCE_EPSG,
	scenarioCarriesPolicy,
	type CoastalScenario,
} from "../vocabulary.ts"

const execFileAsync = promisify(execFile)

/**
 * The ring types and the PROJ guard, both re-exported from `@mailwoman/spatial`: neither is coastal-specific, and a
 * second copy of the `projinfo` parse would be a second place for the ballpark check to stop refusing.
 */
export { assessDatumTransformation, type DatumTransformationVerdict } from "@mailwoman/spatial/projection-transform"
export type { MultiPolygonRings, PolygonRings } from "@mailwoman/spatial"

/**
 * One erosion-zone feature, reprojected to WGS84.
 */
export interface CoastalSourceFeature {
	/**
	 * `<scenario key>:<OBJECTID>`.
	 */
	areaID: string
	scenario: CoastalScenario
	frontageID: number
	distanceM: number
	smpNo: number | null
	smpName: string | null
	smpPolicyUnit: string | null
	mtPolicy: string | null
	mtPolicyInterpretation: string | null
	ltPolicy: string | null
	ltPolicyInterpretation: string | null
	defenceType: string | null
	publishedYear: number | null
	maxOverlap: number | null
	/**
	 * GDAL's own area of the SOURCE geometry, in square metres of the source projection.
	 */
	sourceAreaM2: number
	polygons: MultiPolygonRings
}

/**
 * One ground-instability feature, reprojected to WGS84. A different hazard with a different schema.
 */
export interface CoastalInstabilityFeature {
	areaID: string
	kind: string
	location: string | null
	localAuthority: string | null
	smpNo: number | null
	smpName: string | null
	smpPolicyUnits: string | null
	rearScarpProbability: string | null
	sourceAreaM2: number
	polygons: MultiPolygonRings
}

/**
 * What the ingest was pointed at.
 */
export interface CoastalIngestOptions {
	/**
	 * Path to the unzipped `.gdb` directory.
	 */
	geodatabasePath: string
	/**
	 * Stop after this many features per layer — the fixtures and smoke rungs use it; a full build does not set it.
	 */
	limit?: number
	/**
	 * The EPSG code the source must declare. A source declaring anything else is a product change, not a variation to
	 * absorb.
	 */
	expectEPSG?: number
	/**
	 * The extent every reprojected vertex must land inside. Defaults to the erosion collections' own declaration, which
	 * contains the two ground-instability collections' tighter boxes.
	 */
	declaredBBox?: readonly [number, number, number, number]
	/**
	 * Read only the authority's feature ids in `[objectIDFrom, objectIDTo]`, inclusive.
	 *
	 * This is what makes a bounded build possible: h3's WASM heap cannot be reset from JavaScript, so the classification
	 * runs one child process per range of the authority's OWN ids. Ranges rather than an offset because `OBJECTID` is the
	 * source's stable key — a range names the same features on every run, which an offset into a result set does not.
	 * Each layer numbers its own `OBJECTID` from 1, so a range is per layer.
	 */
	objectIDFrom?: number
	objectIDTo?: number
}

/**
 * What one layer declares about itself — including the ATTRIBUTE FIELDS IT ACTUALLY HAS, because the fourteen published
 * layers do not share one schema.
 */
export interface CoastalLayerIdentity {
	epsg: number
	featureCount: number
	layer: string
	/**
	 * The layer's own attribute field names. A `SELECT` naming a column this set does not hold is refused by ogr2ogr
	 * outright, so the query is built from the set rather than from a schema read off a sibling layer.
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
 * What one layer declares about itself: its authority code and its feature count, read before any feature is.
 *
 * @throws {Error} When the layer is missing, or its declared EPSG is not `expectEPSG`.
 */
export async function readCoastalSourceIdentity(
	layer: string,
	options: CoastalIngestOptions
): Promise<CoastalLayerIdentity> {
	const expectEPSG = options.expectEPSG ?? NCERM_SOURCE_EPSG

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
			fields?: Array<{ name?: string }>
			geometryFields?: Array<{ coordinateSystem?: { projjson?: { id?: { code?: number } } } }>
		}>
	}>(stdout)

	const described = info.layers?.[0]

	if (!described || described.name !== layer) {
		throw new Error(`coastal ingest: ${options.geodatabasePath} does not carry a layer named ${JSON.stringify(layer)}`)
	}

	const code = described.geometryFields?.[0]?.coordinateSystem?.projjson?.id?.code

	if (typeof code !== "number") {
		throw new TypeError(
			`coastal ingest: ${layer} declares no EPSG authority code — the projection cannot be checked, and reading its metres as degrees is silent`
		)
	}

	if (code !== expectEPSG) {
		throw new Error(
			`coastal ingest: ${layer} declares EPSG:${code}, expected EPSG:${expectEPSG} — the source's projection changed, which is a product change rather than a variation to absorb`
		)
	}

	if (typeof described.featureCount !== "number") {
		throw new TypeError(`coastal ingest: ${layer} reports no feature count`)
	}

	await assertDatumTransformation(code, { context: "coastal ingest", areaOfUse: "United Kingdom" })

	const fields = new Set((described.fields ?? []).map((field) => field.name).filter((name) => name !== undefined))

	if (!fields.size) {
		throw new TypeError(
			`coastal ingest: ${layer} reports no attribute fields — an empty field list would make every optional column read as absent, which is a projection failure wearing a schema's clothes`
		)
	}

	return { epsg: code, featureCount: described.featureCount, layer, fields }
}

/**
 * The id-range predicate shared by both `SELECT` builders.
 */
function idBounds(options: CoastalIngestOptions): string {
	const bounds: string[] = []

	if (options.objectIDFrom !== undefined) {
		bounds.push(`OBJECTID >= ${options.objectIDFrom}`)
	}

	if (options.objectIDTo !== undefined) {
		bounds.push(`OBJECTID <= ${options.objectIDTo}`)
	}

	return bounds.length ? ` WHERE ${bounds.join(" AND ")}` : ""
}

/**
 * The attribute columns an erosion-zone layer is read for where it HAS them, and as literal `NULL` where it does not.
 *
 * THE FOURTEEN LAYERS DO NOT SHARE ONE SCHEMA, AND THE EXCEPTION IS A SINGLE COLUMN ON A SINGLE LAYER.
 * `NCERM_SMP_2105_0CC` carries no `smp_name`; the other eleven scenario layers and both ground-instability layers do. A
 * builder that read the schema from one layer — the survey read `NCERM_SMP_2105_95CC` — and generalized it fails on the
 * twelfth layer with `ERROR 1: Unrecognized field name smp_name`, 66,000 features into a run. Loud, and only because
 * ogr2ogr refuses an unknown column: a source that answered NULL instead would have shipped.
 *
 * The four policy columns are the SAME shape for a different reason: the six NFI layers omit them because under a
 * no-intervention scenario there is no policy to record, which is a documented property of the product rather than an
 * irregularity in it.
 *
 * The distance column is NOT in this set. Its absence is a product change and throws.
 */
const OPTIONAL_SCENARIO_FIELDS: ReadonlyArray<string> = [
	"smp_no",
	"smp_name",
	"smp_pu",
	"mt_smp",
	"mt_smp_int",
	"lt_smp",
	"lt_smp_int",
	"def_type",
	"published",
	"maxoverlap",
]

/**
 * The erosion-zone `SELECT` for one scenario, built against the layer's OWN field list.
 */
function scenarioSelectSQL(
	scenario: CoastalScenario,
	identity: CoastalLayerIdentity,
	options: CoastalIngestOptions
): string {
	// The policy asymmetry is REGULAR across the product — the six NFI layers omit all four columns and the six SMP
	// layers carry all four — so a layer that disagrees with its own scenario is a source-schema change rather than the
	// `smp_name` kind of irregularity, and it is worth hearing about rather than absorbing into a NULL.
	const carriesPolicy = identity.fields.has("mt_smp")

	if (carriesPolicy !== scenarioCarriesPolicy(scenario)) {
		throw new Error(
			`coastal ingest: ${scenario.layer} ${carriesPolicy ? "carries" : "carries no"} shoreline-management policy columns, ` +
				`and its ${scenario.management} scenario ${scenarioCarriesPolicy(scenario) ? "should carry them" : "should not"} — ` +
				"the product's policy asymmetry follows the management scenario, so a layer that disagrees with it changed"
		)
	}

	if (!identity.fields.has(scenario.distanceColumn)) {
		throw new Error(
			`coastal ingest: ${scenario.layer} carries no ${scenario.distanceColumn} column — the distance IS the reading, so its absence is a product change rather than a variation to absorb`
		)
	}

	if (!identity.fields.has("frontageid")) {
		throw new Error(`coastal ingest: ${scenario.layer} carries no frontageid column`)
	}

	const attributes = OPTIONAL_SCENARIO_FIELDS.map((field) =>
		identity.fields.has(field) ? field : `NULL AS ${field}`
	).join(", ")

	return (
		`SELECT OBJECTID AS object_id, frontageid, ${scenario.distanceColumn} AS distance_m, ${attributes}, ` +
		`OGR_GEOM_AREA AS source_area_m2 FROM ${scenario.layer}` +
		idBounds(options)
	)
}

/**
 * The attribute columns a ground-instability layer is read for, on the same terms as the scenario set above.
 */
const OPTIONAL_INSTABILITY_FIELDS: ReadonlyArray<string> = [
	"location",
	"local_auth",
	"smp_no",
	"smp_name",
	"smp_pu1",
	"smp_pu2",
	"smp_pu3",
	"smp_pu4",
	"smp_pu5",
	"rearscarpr",
]

/**
 * The ground-instability `SELECT`, built against the layer's OWN field list.
 */
function instabilitySelectSQL(layer: string, identity: CoastalLayerIdentity, options: CoastalIngestOptions): string {
	const attributes = OPTIONAL_INSTABILITY_FIELDS.map((field) =>
		identity.fields.has(field) ? field : `NULL AS ${field}`
	).join(", ")

	return (
		`SELECT OBJECTID AS object_id, ${attributes}, OGR_GEOM_AREA AS source_area_m2 FROM ${layer}` + idBounds(options)
	)
}

interface RawFeature {
	properties: Record<string, number | string | null>
	geometry: { type: string; coordinates: unknown } | null
}

/**
 * Stream one layer through ogr2ogr as GeoJSON, checking every vertex against the declared extent.
 *
 * A swapped coordinate order survives a projection check — both axes are still numbers in a plausible range — and shows
 * up here immediately, before 89,371 polygons are written to the wrong side of the planet.
 *
 * @throws {Error} When ogr2ogr fails, when a feature carries no geometry, or when a reprojected vertex falls outside
 *   the declared extent.
 */
async function* streamLayer(
	sql: string,
	options: CoastalIngestOptions,
	label: string
): AsyncGenerator<{ raw: RawFeature; polygons: MultiPolygonRings }> {
	const [minLon, minLat, maxLon, maxLat] = options.declaredBBox ?? NCERM_DECLARED_BBOX

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
		sql,
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
					`coastal ingest: ogr2ogr exited ${code} on ${label}${stderr.length ? ` — ${stderr.join("").trim()}` : ""}`
				)
			}

			resolve()
		})
	})

	try {
		for await (const raw of JSONSpliterator.fromAsync<RawFeature>(child.stdout)) {
			const id = String(raw.properties.object_id)

			if (!raw.geometry) {
				throw new Error(`coastal ingest: ${label} feature ${id} carries no geometry`)
			}

			const polygons = normalizePolygons(raw.geometry, `${label} feature ${id}`)

			assertInsideExtent(polygons, `${label} feature ${id}`, { minLon, minLat, maxLon, maxLat })

			yield { raw, polygons }
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill()
		}
	}

	await exited

	// A truncated stream reads as a short but well-formed feature list, which is exactly the partial result that must
	// throw rather than be reported as a smaller coastline.
	if (exitError) throw exitError
}

/**
 * Refuse a feature whose reprojected vertices fall outside the authority's own declared extent.
 */
function assertInsideExtent(
	polygons: MultiPolygonRings,
	label: string,
	extent: { minLon: number; minLat: number; maxLon: number; maxLat: number }
): void {
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
						`coastal ingest: ${label} has a vertex at ${lon}, ${lat}, outside the declared extent ` +
							`[${extent.minLon}, ${extent.minLat}, ${extent.maxLon}, ${extent.maxLat}] — the reprojection or the coordinate order is wrong`
					)
				}
			}
		}
	}
}

/**
 * A published value, as a string or null. `" "` is a real value in this product and is never folded to null.
 */
function textOf(value: number | string | null | undefined): string | null {
	return value === null || value === undefined ? null : String(value)
}

function numberOf(value: number | string | null | undefined): number | null {
	return value === null || value === undefined ? null : Number(value)
}

/**
 * Stream one scenario's erosion zones.
 */
export async function* readCoastalScenarioFeatures(
	scenario: CoastalScenario,
	options: CoastalIngestOptions,
	identity?: CoastalLayerIdentity
): AsyncGenerator<CoastalSourceFeature> {
	// The layer's own field list decides the `SELECT`, because the fourteen layers do not share one schema — see
	// `OPTIONAL_SCENARIO_FIELDS`. Read here when the caller has not already read it, which costs one `ogrinfo -so` per
	// layer against a build that streams thousands of features from it.
	const layerIdentity = identity ?? (await readCoastalSourceIdentity(scenario.layer, options))
	const sql = scenarioSelectSQL(scenario, layerIdentity, options)

	for await (const { raw, polygons } of streamLayer(sql, options, scenario.layer)) {
		const properties = raw.properties

		yield {
			areaID: `${scenario.key}:${String(properties.object_id)}`,
			scenario,
			frontageID: Number(properties.frontageid),
			// A missing distance is refused rather than defaulted: measured, neither of the two layers sampled carries a
			// null, and a zero written in place of one reads as "no erosion projected here".
			distanceM: assertFiniteDistance(properties.distance_m, scenario, String(properties.object_id)),
			smpNo: numberOf(properties.smp_no),
			smpName: textOf(properties.smp_name),
			smpPolicyUnit: textOf(properties.smp_pu),
			mtPolicy: textOf(properties.mt_smp),
			mtPolicyInterpretation: textOf(properties.mt_smp_int),
			ltPolicy: textOf(properties.lt_smp),
			ltPolicyInterpretation: textOf(properties.lt_smp_int),
			defenceType: textOf(properties.def_type),
			publishedYear: numberOf(properties.published),
			maxOverlap: numberOf(properties.maxoverlap),
			sourceAreaM2: Number(properties.source_area_m2 ?? 0),
			polygons,
		}
	}
}

/**
 * Refuse a null or non-finite erosion distance.
 *
 * @throws {TypeError} When the scenario's distance column holds no number for this feature.
 */
function assertFiniteDistance(
	value: number | string | null | undefined,
	scenario: CoastalScenario,
	id: string
): number {
	const distance = Number(value)

	if (value === null || value === undefined || !Number.isFinite(distance)) {
		throw new TypeError(
			`coastal ingest: ${scenario.layer} feature ${id} carries no ${scenario.distanceColumn} value — a missing distance defaulted to zero reads as "no erosion projected here"`
		)
	}

	return distance
}

/**
 * Stream one ground-instability layer.
 */
export async function* readCoastalInstabilityFeatures(
	layer: string,
	kind: string,
	options: CoastalIngestOptions
): AsyncGenerator<CoastalInstabilityFeature> {
	const identity = await readCoastalSourceIdentity(layer, options)

	for await (const { raw, polygons } of streamLayer(instabilitySelectSQL(layer, identity, options), options, layer)) {
		const properties = raw.properties

		const units = [properties.smp_pu1, properties.smp_pu2, properties.smp_pu3, properties.smp_pu4, properties.smp_pu5]
			.map((unit) => textOf(unit)?.trim() ?? "")
			.filter((unit) => unit.length > 0)

		yield {
			areaID: `${kind}:${String(properties.object_id)}`,
			kind,
			location: textOf(properties.location),
			localAuthority: textOf(properties.local_auth),
			smpNo: numberOf(properties.smp_no),
			smpName: textOf(properties.smp_name),
			smpPolicyUnits: units.length ? units.join(", ") : null,
			rearScarpProbability: textOf(properties.rearscarpr),
			sourceAreaM2: Number(properties.source_area_m2 ?? 0),
			polygons,
		}
	}
}

/**
 * Where a build's features come from, and what the source declares about itself.
 *
 * The builder takes ONE of these rather than a path, which is what makes the fixture rung possible: hand-built geometry
 * with no network and no GDAL still exercises the whole database half — the domain checks, the cell classification, the
 * coverage rows, the manifest and the seal. A fixture rung that could only run through ogr2ogr would test the
 * conversion on the machines that have it and nothing at all on the ones that do not.
 */
export interface CoastalFeatureSource {
	/**
	 * What the source says it holds, across every layer this source covers. The build compares its own streamed total
	 * against this, so a short read throws instead of building a shorter coastline.
	 */
	declaredFeatureCount: number
	epsg: number
	/**
	 * A description of where these features came from, for the receipt.
	 */
	origin: string
	/**
	 * The scenarios this source yields, in the order it yields them.
	 */
	scenarios: ReadonlyArray<CoastalScenario>
	erosionFeatures: () => AsyncIterable<CoastalSourceFeature>
	instabilityFeatures: () => AsyncIterable<CoastalInstabilityFeature>
}

export interface GeodatabaseSourceOptions extends CoastalIngestOptions {
	/**
	 * Which scenarios to read. Defaults to all twelve.
	 */
	scenarioKeys?: ReadonlyArray<string>
	/**
	 * Skip the two ground-instability layers. The chunked build reads them in their own pass.
	 */
	skipInstability?: boolean
	declaredFeatureCount?: number
}

/**
 * The published geodatabase as a feature source — identity read up front per layer, features streamed on demand.
 */
export async function createGeodatabaseFeatureSource(options: GeodatabaseSourceOptions): Promise<CoastalFeatureSource> {
	const scenarios = (options.scenarioKeys ?? [...NCERM_SCENARIOS_BY_KEY.keys()]).map((key) => {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(key)

		if (!scenario) {
			throw new Error(
				`coastal ingest: ${JSON.stringify(key)} is not one of the twelve published scenarios (${[...NCERM_SCENARIOS_BY_KEY.keys()].join(", ")})`
			)
		}

		return scenario
	})

	const instability = options.skipInstability
		? []
		: [
				{ layer: "NCERM_Ground_Instability_Zone", kind: "zone" },
				{ layer: "NCERM_Ground_Instability_Recession", kind: "recession" },
			]

	let declared = 0
	let epsg = NCERM_SOURCE_EPSG

	// Every layer's identity is read UP FRONT and kept, because the fourteen layers do not share one schema and the
	// `SELECT` for each is built from its own field list. Re-reading it per stream would work and would cost a second
	// `ogrinfo` per layer; keeping it makes the identity the source declared and the identity the query was built from
	// the same object.
	const identities = new Map<string, CoastalLayerIdentity>()

	for (const layer of [...scenarios.map((scenario) => scenario.layer), ...instability.map((entry) => entry.layer)]) {
		const identity = await readCoastalSourceIdentity(layer, options)

		identities.set(layer, identity)

		declared += options.limit === undefined ? identity.featureCount : Math.min(options.limit, identity.featureCount)
		epsg = identity.epsg
	}

	return {
		// A RANGE's own count is supplied by the caller, because `ogrinfo` reports a layer's total and nothing narrower.
		declaredFeatureCount: options.declaredFeatureCount ?? declared,
		epsg,
		origin: options.geodatabasePath,
		scenarios,
		async *erosionFeatures() {
			for (const scenario of scenarios) {
				yield* readCoastalScenarioFeatures(scenario, options, identities.get(scenario.layer))
			}
		},
		async *instabilityFeatures() {
			for (const entry of instability) {
				yield* readCoastalInstabilityFeatures(entry.layer, entry.kind, options)
			}
		},
	}
}

/**
 * Lift a `Polygon` to the `MultiPolygon` shape the rest of this package works in.
 *
 * @throws {Error} When the geometry is neither.
 */
function normalizePolygons(geometry: { type: string; coordinates: unknown }, label: string): MultiPolygonRings {
	if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPolygonRings

	if (geometry.type === "Polygon") return [geometry.coordinates as PolygonRings]

	throw new Error(`coastal ingest: ${label} is a ${geometry.type}, expected Polygon or MultiPolygon`)
}
