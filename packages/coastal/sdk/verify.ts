/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares two paths and checks locations outside the layer's coverage.
 *
 *   The positive half samples points from the sealed artifact and asks the EA's OGC API Features service about them.
 *   The service provides geometry through a separate distribution channel. This package has not touched that
 *   geometry. The point test runs again on the service's rings, so the comparison uses two verdicts from the same
 *   authority. This measures our conversion against the authority's published geometry.
 *
 *   The negative half checks two groups: inland English points plus Welsh and Scottish coastal points. Every point
 *   must return `unknown` with no designation. Wales publishes NCERM in the previous generation's vocabulary: three
 *   periods from a 2005 base and percentile bands. Scotland's Dynamic Coast explicitly prohibits property-level
 *   assessment. Neither system uses England's vocabulary. The inland English points test this layer's coverage
 *   boundary. A positive-only check could pass an artifact that reports the entire country as designated.
 *
 *   The channels use different coordinate precision, so a boundary-point disagreement can reflect rendering rather
 *   than a conversion defect. The geodatabase publishes nine decimals through this package's ingest. The OGC service
 *   publishes six decimals, or about 10 cm. A point within roughly a metre of a zone boundary can fall on opposite
 *   sides of the two rendered edges. The check reports these as `boundary_tolerance` with distance to the nearest
 *   edge. The receipt includes their count.
 *
 *   The distance measures to the edge rather than to the nearest vertex. A point a centimetre from a long edge can be
 *   metres from every vertex. In one flood-verify near-miss, vertex distance was 1.58 m and edge distance was 0.009 m.
 *   The vertex measurement overstated distance by 175 times. Vertex-only measurements would make the boundary tolerance
 *   stricter than its stated value and report a rendering difference as a conversion defect.
 */

import { geometryContains, nearestRingEdgeMetres } from "@mailwoman/spatial"
import type { PathBuilderLike } from "path-ts"

import { CoastalErosionLookup, CoastalReadingKind, type CoastalErosionReading } from "#index"
import type { ServiceFeatureReader } from "#sdk/verify/service"

export { createEAServiceReader, type ServiceFeature, type ServiceFeatureReader } from "#sdk/verify/service"
export { sampleAgreementPoints } from "#sdk/verify/sample"

/**
 * How close to a service-polygon edge a disagreement is attributed to the
 * channels' differing coordinate precision.
 */
const BOUNDARY_TOLERANCE_METRES = 0.5

/**
 * Records one point and both verdicts.
 * It also records whether they agree.
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
	 * Metres from the point to the nearest edge of any polygon the service returned nearby.
	 *
	 * Every row stores this distance.
	 * It separates a real defect from a difference caused by the two channels
	 * rendering the same edge differently.
	 *
	 * A receipt without the distance forces a re-run.
	 * `undefined` means the service returned no polygon at all near the point.
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
	 * True when the artifact answered `unknown` with no designation.
	 * The only acceptable reading here.
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
 * Points outside this product's mapped coverage.
 *
 * Each is a place rather than a bare pair of numbers: a coordinate a reader cannot
 * name is a coordinate with no source for validation.
 *
 * The check requires points from two populations.
 * The inland English points are the case this layer's coverage posture exists for.
 *
 * A builder that generalized the flood rule would answer them confidently.
 *
 * The Welsh and Scottish points are coastal because this layer checks a coastal hazard.
 * The flood layer's negative half uses inland points.
 *
 * These coastal points also confirm that the artifact is clipped to the English product
 * instead of the whole island.
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
	databasePath: PathBuilderLike
	readServiceFeatures: ServiceFeatureReader
	/**
	 * Points to re-ask the service about.
	 *
	 * A caller samples them from the artifact — see {@link sampleAgreementPoints}.
	 */
	points: ReadonlyArray<{ label: string; latitude: number; longitude: number; scenarioKey: string }>
	outsidePoints?: ReadonlyArray<{ label: string; latitude: number; longitude: number }>
	/**
	 * The scenario the negative half is asked under.
	 *
	 * Every scenario must answer `unknown` at these points.
	 * One is checked because the negative half is about the artifact's extent
	 * rather than about a scenario's semantics.
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
 * Whether the service's own geometry contains the point, decided here with the
 * same even-odd rule the artifact's reader uses.
 * So what is compared is a verdict against a verdict.
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
