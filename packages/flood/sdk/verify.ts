/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The check compares two paths. A separate half verifies locations outside coverage.
 *
 *   The positive half samples points from the sealed artifact and asks the Environment Agency's OGC API Features
 *   service about them. The service returns geometry through a separate distribution channel. This package has not
 *   touched that geometry. The check runs the point test on the service's rings, then compares the two verdicts from
 *   the same authority. This measures our conversion against the authority's published geometry.
 *
 *   The negative half has equal importance. Sample points in Wales and Scotland must return `unknown` with no
 *   coverage row. They must never return Zone 1. Wales uses a different authority and a four-zone TAN15 scheme. That
 *   scheme differs from England's. Scotland uses a third system. A report of either location as the EA's
 *   low-probability zone would violate this layer's coverage contract. The positive half by itself could pass an artifact
 *   that answered Zone 1 for the whole
 *   planet.
 *
 *   the channels differ IN coordinate precision and that is why A boundary point is not A failure. The
 *   geodatabase publishes nine decimals through this package's ingest. the OGC service publishes six. Six
 *   decimals differ by about 10 cm. A point within roughly a meter of a zone boundary can land on opposite sides of
 *   two renderings of the same edge. The check reports these cases as `boundary_tolerance` with their distance to the
 *   nearest edge. The receipt includes their count.
 *
 *   The check has already found a projection defect. That result is a reason to keep running it. A missing
 *   proj datum grid put the whole layer 3.4 m from where the authority puts it — coordinates that pass
 *   every structural check there is, because they are ordinary WGS84 numbers inside the declared extent.
 *   It showed up here and nowhere else, as eight disagreements out of 59, each a point that had fallen
 *   into a neighboring sliver. With the grid installed the same sample reads 59/59. See
 *   `assessDatumTransformation` in `ingest.ts` for the guard that now refuses the build instead.
 */

import { geometryContains, nearestRingEdgeMetres } from "@mailwoman/spatial"
import type { PathBuilderLike } from "path-ts"

import { FloodReadingKind, FloodZoneLookup, type FloodZoneReading } from "#index"
import type { ServiceFeatureReader } from "#sdk/verify/service"

export { createEAServiceReader, type ServiceFeature, type ServiceFeatureReader } from "#sdk/verify/service"
export { sampleAgreementPoints } from "#sdk/verify/sample"

const BOUNDARY_TOLERANCE_METRES = 0.5

/**
 * Records one point and both verdicts.
 * It also records whether they agree.
 */
export interface AgreementRow {
	label: string
	latitude: number
	longitude: number
	/**
	 * The artifact's answer.
	 */
	local: FloodZoneReading
	/**
	 * The zone the service's own geometry assigns, or `null` where no service polygon contains the point.
	 *
	 * A polygon that contains the point but has no zone label is not `null`:
	 * it is reported as `service_unlabelled`, because a service polygon with no label
	 * is a defect in the service's answer and reading it as absence would
	 * let it agree with an artifact that answers Zone 1 by absence.
	 */
	service: string | null
	outcome: "agree" | "disagree" | "boundary_tolerance" | "service_unlabelled"
	/**
	 * Meters from the point to the nearest edge of any polygon the service returned nearby.
	 *
	 * Measures to the edge rather than the nearest vertex.
	 * Polygon edges are long compared with this product's slivers.
	 *
	 * A point can sit a centimeter from an edge and meters from every vertex.
	 * Vertex distance makes the boundary tolerance stricter than its stated value
	 * and can report a rendering difference as a conversion defect.
	 *
	 * Every row includes this distance.
	 * It separates a real defect from a difference caused by the two channels
	 * rendering the same edge differently.
	 *
	 * A receipt without the distance forces a re-run.
	 * `null` means the service returned no polygon at all near the point.
	 */
	nearestEdgeMetres: number | null
}

/**
 * The negative half: a point the authority's statement does not reach.
 */
export interface OutsideRow {
	label: string
	latitude: number
	longitude: number
	kind: FloodReadingKind
	/**
	 * True when the artifact answered `unknown`.
	 * The only acceptable reading outside England.
	 */
	passed: boolean
}

export interface VerifyFloodResult {
	agreement: AgreementRow[]
	agreed: number
	disagreed: number
	boundaryTolerance: number
	/**
	 * Points the service's geometry contains without labeling.
	 *
	 * The service's answer is unreadable at these points.
	 * The result records each row so the count remains visible instead of being
	 * folded into agreement or disagreement.
	 */
	serviceUnlabelled: number
	outside: OutsideRow[]
	outsidePassed: number
}

/**
 * Identifiers for points outside England.
 *
 * Each is a place rather than a bare pair of numbers: a coordinate a reader a
 * coordinate without a reference source cannot be checked.
 *
 * Wales and Scotland are the cases that matter, because both border England and both publish
 * flood maps of their own under schemes that are not interchangeable with the EA's.
 * Northern Ireland and the Republic are included because a footprint accidentally
 * clipped to "the British Isles" would pass a Wales-and-Scotland-only check.
 */
export const OUTSIDE_ENGLAND_POINTS: ReadonlyArray<{ label: string; latitude: number; longitude: number }> = [
	{ label: "Cardiff, Wales", latitude: 51.4816, longitude: -3.1791 },
	{ label: "Swansea, Wales", latitude: 51.6214, longitude: -3.9436 },
	{ label: "Wrexham, Wales", latitude: 53.0466, longitude: -2.9931 },
	{ label: "Edinburgh, Scotland", latitude: 55.9533, longitude: -3.1883 },
	{ label: "Glasgow, Scotland", latitude: 55.8642, longitude: -4.2518 },
	{ label: "Dumfries, Scotland", latitude: 55.0709, longitude: -3.6033 },
	{ label: "Belfast, Northern Ireland", latitude: 54.5973, longitude: -5.9301 },
	{ label: "Dublin, Ireland", latitude: 53.3498, longitude: -6.2603 },
]

export interface VerifyFloodOptions {
	databasePath: PathBuilderLike
	readServiceFeatures: ServiceFeatureReader
	/**
	 * Points to re-ask the service about.
	 *
	 * A caller samples them from the artifact — see {@link sampleAgreementPoints}.
	 */
	points: ReadonlyArray<{ label: string; latitude: number; longitude: number }>
	outsidePoints?: ReadonlyArray<{ label: string; latitude: number; longitude: number }>
	onProgress?: (message: string) => void
}

/**
 * Run both halves.
 */
export async function verifyFloodDatabase(options: VerifyFloodOptions): Promise<VerifyFloodResult> {
	const lookup = new FloodZoneLookup({ databasePath: options.databasePath })

	try {
		const agreement: AgreementRow[] = []

		for (const point of options.points) {
			const local = lookup.lookup(point.latitude, point.longitude)
			const service = await readServiceZone(options.readServiceFeatures, point.latitude, point.longitude)

			const localZone = local.kind === FloodReadingKind.Designated ? (local.zoneCode ?? null) : null

			const nearEdge = service.nearestEdgeMetres !== null && service.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			// Every row includes the distance.
			// Readers can inspect it when a disagreement appears without rerunning the check.
			agreement.push({
				...point,
				local,
				service: service.zone,
				outcome: service.insideUnlabelled
					? "service_unlabelled"
					: localZone === service.zone
						? "agree"
						: nearEdge
							? "boundary_tolerance"
							: "disagree",
				nearestEdgeMetres: service.nearestEdgeMetres,
			})

			options.onProgress?.(`${agreement.length}/${options.points.length} points compared`)
		}

		const outside: OutsideRow[] = []

		for (const point of options.outsidePoints ?? OUTSIDE_ENGLAND_POINTS) {
			const reading = lookup.lookup(point.latitude, point.longitude)

			outside.push({ ...point, kind: reading.kind, passed: reading.kind === FloodReadingKind.Unknown })
		}

		return {
			agreement,
			agreed: agreement.filter((row) => row.outcome === "agree").length,
			disagreed: agreement.filter((row) => row.outcome === "disagree").length,
			boundaryTolerance: agreement.filter((row) => row.outcome === "boundary_tolerance").length,
			serviceUnlabelled: agreement.filter((row) => row.outcome === "service_unlabelled").length,
			outside,
			outsidePassed: outside.filter((row) => row.passed).length,
		}
	} finally {
		lookup[Symbol.dispose]()
	}
}

/**
 * What zone the service's own geometry assigns at a point, decided here with the
 * same even-odd rule the artifact's reader uses.
 * So what is compared is a verdict against a verdict.
 *
 * `zone` is `null` only when no returned polygon contains the point.
 * A containing polygon with no `flood_zone` sets `insideUnlabelled` instead,
 * so the two readings never share a value.
 */
async function readServiceZone(
	readServiceFeatures: ServiceFeatureReader,
	latitude: number,
	longitude: number
): Promise<{ zone: string | null; insideUnlabelled: boolean; nearestEdgeMetres: number | null }> {
	const features = await readServiceFeatures(latitude, longitude)

	let nearest = Infinity
	let zone: string | null = null
	let insideUnlabelled = false

	for (const feature of features) {
		const geometry = feature.geometry

		if (!geometry) continue

		const distance = nearestRingEdgeMetres(geometry, longitude, latitude)

		if (distance < nearest) {
			nearest = distance
		}

		if (zone === null && geometryContains(geometry, longitude, latitude)) {
			const label = feature.properties?.flood_zone

			if (typeof label === "string" && label.length) {
				zone = label
				insideUnlabelled = false
			} else {
				insideUnlabelled = true
			}
		}
	}

	return { zone, insideUnlabelled, nearestEdgeMetres: Number.isFinite(nearest) ? nearest : null }
}
