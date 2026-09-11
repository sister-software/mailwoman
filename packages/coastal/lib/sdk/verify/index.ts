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

import { geometryContains, nearestRingEdgeMetres } from "@mailwoman/spatial"

import { CoastalErosionLookup, CoastalReadingKind, type CoastalErosionReading } from "#index"
import type { ServiceFeatureReader } from "#sdk/verify/service"

export { createEAServiceReader, type ServiceFeature, type ServiceFeatureReader } from "#sdk/verify/service"
export { sampleAgreementPoints } from "#sdk/verify/sample"

/**
 * How close to a service-polygon edge a disagreement is attributed to the channels' differing coordinate precision.
 */
const BOUNDARY_TOLERANCE_METRES = 0.5

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
		lookup[Symbol.dispose]()
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

		const distance = nearestRingEdgeMetres(geometry, longitude, latitude)

		if (distance < nearest) {
			nearest = distance
		}

		if (!inside && geometryContains(geometry, longitude, latitude)) {
			inside = true
		}
	}

	return Number.isFinite(nearest) ? { inside, nearestEdgeMetres: nearest } : { inside }
}
