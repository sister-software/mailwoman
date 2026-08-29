/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path agreement check, and its negative half.
 *
 *   POSITIVE HALF. A sample of points is answered from the sealed artifact and then re-asked of the EA's OGC
 *   API Features service — the same authority, a different distribution channel, and geometry this package
 *   has never touched. The point test is run again on the service's own rings, so what is compared is a
 *   verdict against a verdict rather than a file against itself. That is what makes it a check on OUR
 *   CONVERSION rather than on the authority.
 *
 *   NEGATIVE HALF, AND IT MATTERS MORE HERE THAN IT DID FOR THE FLOOD LAYER. Inland English points and Welsh
 *   and Scottish coastal points must come back `unknown` with NO designation. Wales publishes NCERM on the
 *   PREVIOUS generation's vocabulary (three periods from a 2005 base, percentile bands) and Scotland's Dynamic
 *   Coast carries an explicit prohibition on property-level assessment — neither is interchangeable with
 *   England's — and an inland English point is the case this layer's whole coverage posture exists for. A
 *   positive-only check would pass on an artifact that reported the entire country as designated.
 *
 *   THE CHANNELS DIFFER IN COORDINATE PRECISION AND THAT IS WHY A BOUNDARY POINT IS NOT A FAILURE. The
 *   geodatabase publishes nine decimals through this package's ingest; the OGC service publishes six. Six
 *   decimals is about 10 cm, so a point within roughly a metre of a zone boundary can land on opposite sides
 *   of two renderings of the same edge. Those are reported as `boundary_tolerance` with their distance to the
 *   nearest edge, and the count is part of the receipt.
 *
 *   THE DISTANCE IS TO THE EDGE, NOT TO THE NEAREST VERTEX. A point a centimetre from a long edge can be
 *   metres from every vertex of it — the flood verify's one near-miss read 1.58 m to vertices and 0.009 m to
 *   edges, an overstatement of 175-fold — so measuring vertices makes the boundary tolerance far stricter than
 *   it reads, which is how a rendering difference gets reported as a conversion defect.
 */

import { interiorPointOfEncodedRings, pointInPolygonRings, segmentDistanceMetres } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { CoastalErosionLookup, CoastalReadingKind, type CoastalErosionReading } from "../index.ts"
import type { CoastalDatabase } from "../schema.ts"
import { NCERM_SCENARIOS_BY_KEY } from "../vocabulary.ts"
import { EA_NCERM_SPATIAL_BASE_URL, type EANCERMClient } from "./client.ts"

/**
 * One point, both verdicts, and whether they agree.
 */
export interface AgreementRow {
	label: string
	latitude: number
	longitude: number
	scenarioKey: string
	/**
	 * The artifact's answer.
	 */
	local: CoastalErosionReading
	/**
	 * Whether the service's own geometry places the point inside an erosion zone of that scenario.
	 */
	serviceInside: boolean
	outcome: "agree" | "disagree" | "boundary_tolerance"
	/**
	 * Metres from the point to the nearest EDGE of any polygon the service returned nearby.
	 *
	 * Carried on every row rather than only the tolerated ones, because it is what separates a real defect from the two
	 * channels rendering the same edge differently — and a receipt that omits it forces a re-run. `undefined` means the
	 * service returned no polygon at all near the point.
	 */
	nearestEdgeMetres?: number
}

/**
 * The negative half: a point this product's mapping does not reach.
 */
export interface OutsideRow {
	label: string
	latitude: number
	longitude: number
	kind: string
	designations: number
	/**
	 * True when the artifact answered `unknown` with no designation — the only acceptable reading here.
	 */
	passed: boolean
}

export interface VerifyCoastalResult {
	agreement: AgreementRow[]
	agreed: number
	disagreed: number
	boundaryTolerance: number
	outside: OutsideRow[]
	outsidePassed: number
}

/**
 * Points this product's mapping does not reach, named. Each is a place, not a bare pair of numbers: a coordinate a
 * reader cannot name is a coordinate nobody can check.
 *
 * TWO POPULATIONS, AND BOTH ARE required. The inland English points are the case this layer's coverage posture exists
 * for — a builder that generalized the flood rule would answer them confidently. The Welsh and Scottish coastal points
 * are the case the FLOOD layer's negative half exists for, and they are on the coast here rather than inland, so they
 * also confirm the artifact is clipped to the English product rather than to "the island".
 */
export const OUTSIDE_MAPPING_POINTS: ReadonlyArray<{ label: string; latitude: number; longitude: number }> = [
	{ label: "Birmingham city centre, inland England", latitude: 52.4796, longitude: -1.9026 },
	{ label: "Coventry, inland England", latitude: 52.4068, longitude: -1.5197 },
	{ label: "Sheffield, inland England", latitude: 53.3811, longitude: -1.4701 },
	{ label: "Oxford, inland England", latitude: 51.752, longitude: -1.2577 },
	{ label: "Aberystwyth seafront, Wales", latitude: 52.4153, longitude: -4.0872 },
	{ label: "Swansea Bay, Wales", latitude: 51.5942, longitude: -3.9973 },
	{ label: "St Andrews, Scotland", latitude: 56.3398, longitude: -2.7967 },
	{ label: "Portobello Beach, Scotland", latitude: 55.9552, longitude: -3.1128 },
]

/**
 * Half-width of the bbox the service is asked for, in degrees. About 11 m at this latitude — wide enough that a polygon
 * containing the point is certainly returned, narrow enough that the response stays small.
 */
const PROBE_HALF_WIDTH_DEGREES = 0.0001

/**
 * How close to a service-polygon edge a disagreement is attributed to the channels' differing coordinate precision
 * rather than to the conversion.
 *
 * The service publishes six decimals — about 11 cm of latitude, 7 cm of longitude at this latitude — while the
 * geodatabase publishes nine, so two renderings of the SAME edge can sit up to roughly 16 cm apart and a point between
 * them lands on opposite sides. Half a metre is threefold headroom over that and far below any real erosion band.
 */
const BOUNDARY_TOLERANCE_METRES = 0.5

/**
 * Features per service request. The probe bbox is metres wide, so this is a ceiling rather than a page size.
 */
const SERVICE_FEATURE_LIMIT = 200

/**
 * One feature as the service publishes it — the only shape the comparison reads.
 */
export interface ServiceFeature {
	properties?: Record<string, unknown>
	geometry?: { type: string; coordinates: unknown }
}

/**
 * The ONE call the verification makes against the service: the features it publishes near a point, in one scenario's
 * collection.
 *
 * A function rather than the client, and that is what makes the check's own logic testable. The comparison's value is
 * that it decides which of three outcomes a point gets; expressed against an HTTP client it could only ever be watched
 * on a live run, and a scripted reader lets those decisions be pinned. {@link createEAServiceReader} builds the real
 * one.
 */
export type ServiceFeatureReader = (
	latitude: number,
	longitude: number,
	scenarioKey: string
) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: an OGC API Features bbox query against the EA's own service, in the collection named
 * by the scenario asked about.
 *
 * The service answers a BBOX, not a point, so this returns what it published nearby and the containment decision is
 * made in {@link readServiceContainment} against those rings — comparing the artifact's verdict against a bare "the
 * service returned something here" would pass on any polygon within eleven metres.
 */
export function createEAServiceReader(client: Pick<EANCERMClient, "fetch">): ServiceFeatureReader {
	return async (latitude, longitude, scenarioKey) => {
		const scenario = NCERM_SCENARIOS_BY_KEY.get(scenarioKey)

		if (!scenario) {
			throw new Error(`coastal verify: ${JSON.stringify(scenarioKey)} is not one of the twelve published scenarios`)
		}

		const { data } = await client.fetch<{ features?: ServiceFeature[] }>({
			method: "GET",
			url: `${EA_NCERM_SPATIAL_BASE_URL}/ogc/features/v1/collections/${scenario.layer}/items`,
			params: {
				bbox: [
					longitude - PROBE_HALF_WIDTH_DEGREES,
					latitude - PROBE_HALF_WIDTH_DEGREES,
					longitude + PROBE_HALF_WIDTH_DEGREES,
					latitude + PROBE_HALF_WIDTH_DEGREES,
				].join(","),
				limit: SERVICE_FEATURE_LIMIT,
				f: "application/json",
			},
		})

		return data.features ?? []
	}
}

export interface VerifyCoastalOptions {
	databasePath: string
	readServiceFeatures: ServiceFeatureReader
	/**
	 * Points to re-ask the service about. A caller samples them from the artifact — see {@link sampleAgreementPoints}.
	 */
	points: ReadonlyArray<{ label: string; latitude: number; longitude: number; scenarioKey: string }>
	outsidePoints?: ReadonlyArray<{ label: string; latitude: number; longitude: number }>
	/**
	 * The scenario the negative half is asked under. Every scenario must answer `unknown` at these points; one is checked
	 * because the negative half is about the artifact's extent rather than about a scenario's semantics.
	 */
	outsideScenarioKey: string
	onProgress?: (message: string) => void
}

/**
 * Run both halves.
 */
export async function verifyCoastalDatabase(options: VerifyCoastalOptions): Promise<VerifyCoastalResult> {
	const lookup = new CoastalErosionLookup({ databasePath: options.databasePath })

	try {
		const agreement: AgreementRow[] = []

		for (const point of options.points) {
			const local = lookup.lookup(point.latitude, point.longitude, point.scenarioKey)

			const service = await readServiceContainment(
				options.readServiceFeatures,
				point.latitude,
				point.longitude,
				point.scenarioKey
			)

			const localInside = local.kind === CoastalReadingKind.Designated

			const nearEdge = service.nearestEdgeMetres !== undefined && service.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			agreement.push({
				...point,
				local,
				serviceInside: service.inside,
				outcome: localInside === service.inside ? "agree" : nearEdge ? "boundary_tolerance" : "disagree",
				...(service.nearestEdgeMetres === undefined ? {} : { nearestEdgeMetres: service.nearestEdgeMetres }),
			})

			options.onProgress?.(`${agreement.length}/${options.points.length} points compared`)
		}

		const outside: OutsideRow[] = []

		for (const point of options.outsidePoints ?? OUTSIDE_MAPPING_POINTS) {
			const reading = lookup.lookup(point.latitude, point.longitude, options.outsideScenarioKey)

			outside.push({
				...point,
				kind: reading.kind,
				designations: reading.designations.length,
				passed: reading.kind === CoastalReadingKind.Unknown && reading.designations.length === 0,
			})
		}

		return {
			agreement,
			agreed: agreement.filter((row) => row.outcome === "agree").length,
			disagreed: agreement.filter((row) => row.outcome === "disagree").length,
			boundaryTolerance: agreement.filter((row) => row.outcome === "boundary_tolerance").length,
			outside,
			outsidePassed: outside.filter((row) => row.passed).length,
		}
	} finally {
		lookup.close()
	}
}

/**
 * Whether the SERVICE's own geometry contains the point, decided here with the same even-odd rule the artifact's reader
 * uses — so what is compared is a verdict against a verdict.
 */
async function readServiceContainment(
	readServiceFeatures: ServiceFeatureReader,
	latitude: number,
	longitude: number,
	scenarioKey: string
): Promise<{ inside: boolean; nearestEdgeMetres?: number }> {
	const features = await readServiceFeatures(latitude, longitude, scenarioKey)

	let nearest = Infinity
	let inside = false

	for (const feature of features) {
		const geometry = feature.geometry

		if (!geometry) continue

		const polygons =
			geometry.type === "MultiPolygon"
				? (geometry.coordinates as number[][][][])
				: [geometry.coordinates as number[][][]]

		for (const rings of polygons) {
			for (const ring of rings) {
				for (let index = 1; index < ring.length; index++) {
					const distance = segmentDistanceMetres(longitude, latitude, ring[index - 1]!, ring[index]!)

					if (distance < nearest) {
						nearest = distance
					}
				}
			}

			if (!inside && pointInPolygonRings(longitude, latitude, rings as [number, number][][])) {
				inside = true
			}
		}
	}

	return Number.isFinite(nearest) ? { inside, nearestEdgeMetres: nearest } : { inside }
}

/**
 * Draw a reproducible sample of points from the artifact — interior points of stored polygons, across scenarios.
 *
 * SPREAD ACROSS SCENARIOS RATHER THAN DRAWN FROM ONE, because the twelve scenarios are twelve claims and a sample from
 * one would verify one twelfth of the artifact while reporting on all of it. The draw is a deterministic stride over
 * the primary key, not a random one, so a re-run compares the same points and a disagreement can be looked at rather
 * than re-rolled.
 *
 * THE KEYS ARE CHOSEN BEFORE ANY GEOMETRY IS READ. A `WHERE rowid % stride = 0` scan looks like the same thing and is
 * not: it walks the table itself, which means reading ring blobs to keep a few dozen of them. Selecting `area_id` alone
 * is an index-only walk over the primary key, and the rows it names are then fetched by key.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number; scenarioKey: string }> {
	const count = options.count ?? 48
	const database = new DatabaseClient<CoastalDatabase>(databasePath, { readOnly: true })

	try {
		const points: Array<{ label: string; latitude: number; longitude: number; scenarioKey: string }> = []

		const areaIDs = (
			database.prepare("SELECT area_id FROM coastal_zone_area ORDER BY area_id").all() as Array<{ area_id: string }>
		).map((row) => row.area_id)

		if (!areaIDs.length) return points

		const stride = Math.max(1, Math.floor(areaIDs.length / Math.max(1, count)))

		const selectArea = database.prepare(
			"SELECT area_id, scenario_key, min_lat, min_lon, max_lat, max_lon, rings FROM coastal_zone_area WHERE area_id = ?"
		)

		for (let index = 0; index < areaIDs.length && points.length < count; index += stride) {
			const area = selectArea.get(areaIDs[index]!) as
				| {
						area_id: string
						scenario_key: string
						min_lat: number
						min_lon: number
						max_lat: number
						max_lon: number
						rings: Uint8Array
				  }
				| undefined

			if (!area) continue

			const interior = interiorPointOfEncodedRings(area, 17)

			if (!interior) continue

			points.push({
				label: `${area.scenario_key} polygon ${area.area_id}`,
				scenarioKey: area.scenario_key,
				...interior,
			})
		}

		return points
	} finally {
		database.destroy()
	}
}
