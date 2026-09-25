/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Streams the NCERM file geodatabase as WGS84 features through ogr2ogr, one layer at a time.
 *
 *   Every NCERM layer is published in British National Grid (EPSG:27700, metres). Each layer's declared EPSG code
 *   is checked before any feature is read. The OSTN15 datum grid check also runs inside `readOGRLayerIdentity`.
 *   Every reprojected vertex is then checked against the declared bounding box, which catches a swapped axis
 *   order that the EPSG check cannot see.
 *
 *   The `OGR_GEOM_AREA` column is computed by gdal in source metres before reprojection. Callers compare it with
 *   the area of the encoded rings to check ring nesting and hole handling.
 *
 *   Each scenario layer uses its own name for the distance column. The query aliases it to `distance_m`.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { limitedFeatureCount } from "@mailwoman/core/layers"
import { assertRingsInsideExtent, requireArealPolygons, type MultiPolygonRings } from "@mailwoman/spatial"
import { readOGRLayerIdentity } from "@mailwoman/spatial/tools/ogr"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"

import {
	NCERM_DECLARED_BBOX,
	NCERM_SCENARIOS_BY_KEY,
	NCERM_SOURCE_EPSG,
	scenarioCarriesPolicy,
	type CoastalScenario,
} from "#vocabulary"

/**
 * One erosion-zone feature, reprojected to WGS84.
 */
export interface CoastalSourceFeature {
	/**
	 * The feature ID, formatted as `<scenario key>:<objectid>`.
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
	 * Gdal's area of the source geometry, in square metres of the source projection.
	 */
	sourceAreaM2: number
	polygons: MultiPolygonRings
}

/**
 * One ground-instability feature, reprojected to WGS84.
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
 * Options for reading the geodatabase.
 */
export interface CoastalIngestOptions {
	/**
	 * Path to the unzipped `.gdb` directory.
	 */
	geodatabasePath: string
	/**
	 * Maximum features to read per layer.
	 * Fixtures and smoke builds set it.
	 */
	limit?: number
	/**
	 * The EPSG code every layer must declare.
	 */
	expectEPSG?: number
	/**
	 * The WGS84 extent that every reprojected vertex must fall inside.
	 *
	 * The default is the erosion collections' declared box, which contains both ground-instability boxes.
	 */
	declaredBBox?: readonly [number, number, number, number]
	/**
	 * The first `OBJECTID` to read, inclusive.
	 *
	 * The chunked build runs one child process per ID range because the h3 wasm
	 * heap cannot be reset from JavaScript.
	 * `OBJECTID` is stable across runs, so a range selects the same features every time.
	 *
	 * Each layer numbers its IDs from 1, so a range applies per layer.
	 */
	objectIDFrom?: number
	objectIDTo?: number
}

/**
 * A layer's EPSG code, feature count and attribute field names.
 */
export interface CoastalLayerIdentity {
	epsg: number
	featureCount: number
	layer: string
	/**
	 * The layer's attribute field names.
	 *
	 * The fourteen layers do not share one schema, and ogr2ogr rejects a `select`
	 * that asks for a missing column.
	 * The query builders therefore use this set.
	 */
	fields: ReadonlySet<string>
}

/**
 * Coordinate decimals that ogr2ogr writes.
 *
 * Nine decimals is about 0.1 mm, which keeps rounding out of the area cross-check.
 */
const COORDINATE_PRECISION = 9

/**
 * The tolerance, in degrees, outside the declared extent.
 *
 * The published extent is rounded, so an exact test would be brittle.
 * An unprojected or axis-swapped read lands whole degrees away and still fails.
 */
const BBOX_MARGIN_DEGREES = 0.01

/**
 * Reads one layer's EPSG code, feature count and field names before any feature is streamed.
 *
 * @throws {Error} When the layer is missing, or its declared EPSG code is not `expectEPSG`.
 */
export async function readCoastalSourceIdentity(
	layer: string,
	options: CoastalIngestOptions
): Promise<CoastalLayerIdentity> {
	const identity = await readOGRLayerIdentity({
		path: options.geodatabasePath,
		layer,
		expectEPSG: options.expectEPSG ?? NCERM_SOURCE_EPSG,
		context: "coastal ingest",
		areaOfUse: "United Kingdom",
		requireFields: true,
		messages: {
			emptyFields:
				"an empty field list would make every optional column read as absent, which is a projection failure wearing a schema's clothes",
		},
	})

	return { epsg: identity.epsg, featureCount: identity.featureCount, layer: identity.layer, fields: identity.fields }
}

/**
 * Builds the `OBJECTID` range clause for both query builders.
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
 * Erosion-zone columns that a layer may lack.
 * A missing column is selected as literal `NULL`.
 *
 * `NCERM_SMP_2105_0CC` lacks `smp_name`.
 * The six NFI layers lack the four policy columns because a no-intervention scenario has no policy.
 *
 * The distance column is required and is therefore absent from this list.
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
 * Builds the erosion-zone query for one scenario from the layer's field list.
 */
function scenarioSelectSQL(
	scenario: CoastalScenario,
	identity: CoastalLayerIdentity,
	options: CoastalIngestOptions
): string {
	// Policy columns must match the management scenario.
	// A mismatch means the source schema changed.
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
 * Ground-instability columns that a layer may lack.
 * A missing column is selected as literal `NULL`.
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
 * Builds the ground-instability query from the layer's field list.
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
 * Streams one layer through ogr2ogr as GeoJSON and checks every vertex against the declared extent.
 *
 * @throws {Error} When ogr2ogr fails, when a feature has no geometry, or
 * when a reprojected vertex falls outside the declared extent.
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

	for await (const raw of ogr2ogrGeoJSONSeq<RawFeature>(args, `coastal ingest (${label})`)) {
		const id = String(raw.properties.object_id)

		if (!raw.geometry) {
			throw new Error(`coastal ingest: ${label} feature ${id} carries no geometry`)
		}

		const polygons = requireArealPolygons(raw.geometry, `${label} feature ${id}`, "coastal ingest")

		assertRingsInsideExtent(
			polygons,
			`${label} feature ${id}`,
			{ minLon, minLat, maxLon, maxLat },
			BBOX_MARGIN_DEGREES,
			"coastal ingest"
		)

		yield { raw, polygons }
	}
}

/**
 * Converts a published value to a string or null.
 *
 * A single space is a real value in this product, so blank strings are kept.
 */
function verbatimText(value: number | string | null | undefined): string | null {
	return value === null || value === undefined ? null : String(value)
}

function numberOf(value: number | string | null | undefined): number | null {
	return value === null || value === undefined ? null : Number(value)
}

/**
 * Streams one scenario's erosion zones.
 *
 * The layer identity is read here when the caller does not pass one.
 */
export async function* readCoastalScenarioFeatures(
	scenario: CoastalScenario,
	options: CoastalIngestOptions,
	identity?: CoastalLayerIdentity
): AsyncGenerator<CoastalSourceFeature> {
	const layerIdentity = identity ?? (await readCoastalSourceIdentity(scenario.layer, options))
	const sql = scenarioSelectSQL(scenario, layerIdentity, options)

	for await (const { raw, polygons } of streamLayer(sql, options, scenario.layer)) {
		const properties = raw.properties

		yield {
			areaID: `${scenario.key}:${String(properties.object_id)}`,
			scenario,
			frontageID: Number(properties.frontageid),
			// A default of zero would read as "no erosion projected", so a missing distance throws.
			distanceM: assertFiniteDistance(properties.distance_m, scenario, String(properties.object_id)),
			smpNo: numberOf(properties.smp_no),
			smpName: verbatimText(properties.smp_name),
			smpPolicyUnit: verbatimText(properties.smp_pu),
			mtPolicy: verbatimText(properties.mt_smp),
			mtPolicyInterpretation: verbatimText(properties.mt_smp_int),
			ltPolicy: verbatimText(properties.lt_smp),
			ltPolicyInterpretation: verbatimText(properties.lt_smp_int),
			defenceType: verbatimText(properties.def_type),
			publishedYear: numberOf(properties.published),
			maxOverlap: numberOf(properties.maxoverlap),
			sourceAreaM2: Number(properties.source_area_m2 ?? 0),
			polygons,
		}
	}
}

/**
 * Returns the erosion distance as a finite number.
 *
 * @throws {TypeError} When the distance is null or non-finite.
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
 * Streams one ground-instability layer.
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
			.map((unit) => verbatimText(unit)?.trim() ?? "")
			.filter((unit) => unit.length)

		yield {
			areaID: `${kind}:${String(properties.object_id)}`,
			kind,
			location: verbatimText(properties.location),
			localAuthority: verbatimText(properties.local_auth),
			smpNo: numberOf(properties.smp_no),
			smpName: verbatimText(properties.smp_name),
			smpPolicyUnits: units.length ? units.join(", ") : null,
			rearScarpProbability: verbatimText(properties.rearscarpr),
			sourceAreaM2: Number(properties.source_area_m2 ?? 0),
			polygons,
		}
	}
}

/**
 * A source of features for a coastal build, with the counts the source declares.
 *
 * The builder accepts this interface so that fixture builds can supply hand-built geometry without gdal.
 */
export interface CoastalFeatureSource {
	/**
	 * The feature count the source declares across all its layers.
	 *
	 * The build compares its streamed total with this value and throws on a short read.
	 */
	declaredFeatureCount: number
	epsg: number
	/**
	 * A description of the feature origin for the build receipt.
	 */
	origin: string
	/**
	 * The scenarios this source yields, in yield order.
	 */
	scenarios: ReadonlyArray<CoastalScenario>
	erosionFeatures: () => AsyncIterable<CoastalSourceFeature>
	instabilityFeatures: () => AsyncIterable<CoastalInstabilityFeature>
}

/**
 * Options for {@linkcode createGeodatabaseFeatureSource}.
 */
export interface GeodatabaseSourceOptions extends CoastalIngestOptions {
	/**
	 * The scenario keys to read.
	 * The default is all twelve scenarios.
	 */
	scenarioKeys?: ReadonlyArray<string>
	/**
	 * Skips the two ground-instability layers.
	 * The chunked build reads them in a separate pass.
	 */
	skipInstability?: boolean
	/**
	 * Overrides the declared count.
	 *
	 * An ID-range build sets it because `ogrinfo` reports only whole-layer totals.
	 */
	declaredFeatureCount?: number
}

/**
 * Creates a feature source over the published geodatabase.
 *
 * Every layer's identity is read up front.
 * Features are streamed on demand.
 */
export async function createGeodatabaseFeatureSource(options: GeodatabaseSourceOptions): Promise<CoastalFeatureSource> {
	const scenarios = (options.scenarioKeys ?? [...NCERM_SCENARIOS_BY_KEY.keys()]).map((key) => {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(key)

		if (!scenario) {
			throw new Error(
				`coastal ingest: ${stringifyJSON(key)} is not one of the twelve published scenarios (${[...NCERM_SCENARIOS_BY_KEY.keys()].join(", ")})`
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

	// Scenario streams reuse these identities, so each layer costs one `ogrinfo` call.
	const identities = new Map<string, CoastalLayerIdentity>()

	for (const layer of [...scenarios.map((scenario) => scenario.layer), ...instability.map((entry) => entry.layer)]) {
		const identity = await readCoastalSourceIdentity(layer, options)

		identities.set(layer, identity)

		declared += limitedFeatureCount(identity.featureCount, options.limit)
		epsg = identity.epsg
	}

	return {
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
