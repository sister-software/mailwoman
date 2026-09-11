/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path agreement check, and its negative half.
 *
 *   POSITIVE HALF. A sample of points is answered from the sealed artifact and then re-asked of the EA's
 *   OGC API Features service — the same authority, a different distribution channel, and geometry this
 *   package has never touched. The point test is run again on the service's own rings, so what is compared
 *   is a verdict against a verdict rather than a file against itself. That is what makes it a check on OUR
 *   CONVERSION rather than on the authority.
 *
 *   NEGATIVE HALF, AND IT MATTERS AS MUCH. A sample of points in Wales and Scotland must come back
 *   `unknown` — no coverage row at all — and never Zone 1. Wales is a different authority under a
 *   four-zone TAN15 scheme that is not interchangeable with England's, and Scotland is a third; reporting
 *   either as the EA's low-probability zone would be the exact defect this layer was built to make
 *   impossible. The positive half alone would pass on an artifact that answered Zone 1 for the whole
 *   planet.
 *
 *   THE CHANNELS DIFFER IN COORDINATE PRECISION AND THAT IS WHY A BOUNDARY POINT IS NOT A FAILURE. The
 *   geodatabase publishes nine decimals through this package's ingest; the OGC service publishes six. Six
 *   decimals is about 10 cm, so a point within roughly a metre of a zone boundary can land on opposite
 *   sides of two renderings of the same edge. Those are reported as `boundary_tolerance` rather than as
 *   disagreements, with their distance to the nearest edge, and the count is part of the receipt.
 *
 *   THIS CHECK HAS ALREADY EARNED ITS KEEP, and what it caught is the reason to keep running it. A missing
 *   PROJ datum grid put the whole layer 3.4 m from where the authority puts it — coordinates that pass
 *   every structural check there is, because they are ordinary WGS84 numbers inside the declared extent.
 *   It showed up here and nowhere else, as eight disagreements out of 59, each a point that had fallen
 *   into a neighbouring sliver. With the grid installed the same sample reads 59/59. See
 *   `assessDatumTransformation` in `ingest.ts` for the guard that now refuses the build instead.
 */

import { geometryContains, nearestRingEdgeMetres } from "@mailwoman/spatial"

import { FloodReadingKind, FloodZoneLookup, type FloodZoneReading } from "#index"
import type { ServiceFeatureReader } from "#sdk/verify/service"

export { createEAServiceReader, type ServiceFeature, type ServiceFeatureReader } from "#sdk/verify/service"
export { sampleAgreementPoints } from "#sdk/verify/sample"

const BOUNDARY_TOLERANCE_METRES = 0.5

/**
 * One point, both verdicts, and whether they agree.
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
	 * The zone the service's own geometry assigns, or `null` where no service polygon contains the point. A polygon that
	 * contains the point but carries no zone label is NOT `null`: it is reported as `service_unlabelled`, because a
	 * service polygon with no label is a defect in the service's answer and reading it as absence would let it agree with
	 * an artifact that answers Zone 1 by absence.
	 */
	service: string | null
	outcome: "agree" | "disagree" | "boundary_tolerance" | "service_unlabelled"
	/**
	 * Metres from the point to the nearest EDGE of any polygon the service returned nearby.
	 *
	 * To the edge, not to the nearest vertex: a polygon's edges are long compared to this product's slivers, so a point
	 * can sit a centimetre from an edge and metres from every vertex of it. Measuring vertices makes the boundary
	 * tolerance far stricter than it reads, which is how a rendering difference gets reported as a conversion defect.
	 *
	 * Carried on every row rather than only the tolerated ones, because it is what separates a real defect from the two
	 * channels rendering the same edge differently — and a receipt that omits it forces a re-run. `undefined` means the
	 * service returned no polygon at all near the point.
	 */
	nearestEdgeMetres?: number
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
	 * True when the artifact answered `unknown` — the only acceptable reading outside England.
	 */
	passed: boolean
}

export interface VerifyFloodResult {
	agreement: AgreementRow[]
	agreed: number
	disagreed: number
	boundaryTolerance: number
	/**
	 * Points the service's geometry contains without labelling. Neither agreement nor disagreement: the service's answer
	 * is unreadable there, and the row is carried so the count is visible rather than folded into either side.
	 */
	serviceUnlabelled: number
	outside: OutsideRow[]
	outsidePassed: number
}

/**
 * Points outside England, named. Each is a place, not a bare pair of numbers: a coordinate a reader cannot name is a
 * coordinate nobody can check.
 *
 * Wales and Scotland are the cases that matter, because both border England and both publish flood maps of their own
 * under schemes that are not interchangeable with the EA's. Northern Ireland and the Republic are included because a
 * footprint accidentally clipped to "the British Isles" would pass a Wales-and-Scotland-only check.
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
	databasePath: string
	readServiceFeatures: ServiceFeatureReader
	/**
	 * Points to re-ask the service about. A caller samples them from the artifact — see {@link sampleAgreementPoints}.
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

			const nearEdge = service.nearestEdgeMetres !== undefined && service.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			// The distance rides on EVERY row, not only the tolerated ones: it is the first thing anyone wants when a
			// disagreement appears, and carrying it only where it was already acted on means re-running the check to see it.
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
				...(service.nearestEdgeMetres === undefined ? {} : { nearestEdgeMetres: service.nearestEdgeMetres }),
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
 * What zone the SERVICE's own geometry assigns at a point, decided here with the same even-odd rule the artifact's
 * reader uses — so what is compared is a verdict against a verdict. `zone` is `null` only when no returned polygon
 * contains the point; a containing polygon with no `flood_zone` sets `insideUnlabelled` instead, so the two readings
 * never share a value.
 */
async function readServiceZone(
	readServiceFeatures: ServiceFeatureReader,
	latitude: number,
	longitude: number
): Promise<{ zone: string | null; insideUnlabelled: boolean; nearestEdgeMetres?: number }> {
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

	return Number.isFinite(nearest) ? { zone, insideUnlabelled, nearestEdgeMetres: nearest } : { zone, insideUnlabelled }
}
