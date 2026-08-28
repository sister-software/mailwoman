/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path agreement check, and its negative half.
 *
 *   POSITIVE HALF. A sample of points is answered from the sealed artifact and then re-asked of Soil Data
 *   Access — the same authority, a different distribution channel, and geometry this package has never
 *   touched. What is compared is the MAP UNIT the two channels put at the point, which is the thing a
 *   conversion can get wrong; comparing the derived capability class instead would let a wrong delineation
 *   agree by accident whenever two neighbouring map units happen to share a class.
 *
 *   NEGATIVE HALF, AND IT MATTERS AS MUCH. A sample of points in states with no rows must come back
 *   `unknown` — no coverage row at all — and never a low-capability reading. The positive half alone would
 *   pass on an artifact that answered class 8 for the whole planet.
 *
 *   A DISAGREEMENT NEAR A DELINEATION EDGE IS NOT A DEFECT, AND THE DISTANCE IS MEASURED TO THE EDGE RATHER
 *   THAN TO THE NEAREST VERTEX. A point a centimetre from a long edge can be metres from every vertex of it
 *   — the flood layer's one near-miss read 1.58 m to vertices and 0.009 m to edges, a 9 mm difference
 *   overstated 175-fold. Measuring vertices makes the boundary tolerance far stricter than it reads, which
 *   is how a rendering difference gets reported as a conversion defect.
 *
 *   THE ARTIFACT'S OWN ANSWER IS THE CELL SUMMARY, AND THE POINT'S MAP UNIT IS UNDER IT. So the comparison
 *   reads `soil_map_unit_area` directly — the truth table — rather than the reduction: the reduction is a
 *   per-cell distribution and has no single map unit to compare. That makes this a check on the CONVERSION,
 *   which is what it is for; the reduction is checked by the fixtures and by the share-sum invariant.
 */

import { DatabaseSync } from "node:sqlite"

import { decodeRings, pointInEncodedRings, segmentDistanceMetres } from "@mailwoman/spatial"

import { SoilCapabilityLookup, SoilReadingKind } from "../index.ts"
import type { SoilDataAccessClient } from "./client.ts"

/**
 * One point, both verdicts, and whether they agree.
 */
export interface SoilAgreementRow {
	label: string
	latitude: number
	longitude: number
	/**
	 * The map unit the artifact's own geometry puts here.
	 */
	localMukey: string | null
	/**
	 * The map unit Soil Data Access puts here.
	 */
	serviceMukey: string | null
	outcome: "agree" | "disagree" | "boundary_tolerance"
	/**
	 * Metres from the point to the nearest EDGE of the delineation the artifact matched.
	 *
	 * Carried on every row rather than only the tolerated ones, because it is what separates a real defect from two
	 * channels rendering the same edge differently — and a receipt that omits it forces a re-run.
	 */
	nearestEdgeMetres?: number
}

/**
 * The negative half: a point the authority's published surveys do not reach.
 */
export interface SoilOutsideRow {
	label: string
	latitude: number
	longitude: number
	kind: SoilReadingKind
	/**
	 * True when the artifact answered `unknown` — the only acceptable reading outside the built survey areas.
	 */
	passed: boolean
}

export interface VerifySoilResult {
	agreement: SoilAgreementRow[]
	agreed: number
	disagreed: number
	boundaryTolerance: number
	outside: SoilOutsideRow[]
	outsidePassed: number
}

/**
 * Points outside the pilot region, named. Each is a place, not a bare pair of numbers: a coordinate a reader cannot
 * name is a coordinate nobody can check.
 *
 * Every neighbouring state is included, because the failure this half catches is a footprint that leaked past the
 * survey-area outlines — and a footprint accidentally clipped to "the Midwest" would pass a one-state check. Two of
 * these sit close to the Iowa border on purpose: the outline test is conservative, so a near-border point must read
 * unknown rather than borrow Iowa's coverage.
 */
export const OUTSIDE_PILOT_POINTS: ReadonlyArray<{ label: string; latitude: number; longitude: number }> = [
	{ label: "Lincoln, Nebraska", latitude: 40.8136, longitude: -96.7026 },
	{ label: "Omaha, Nebraska (Iowa border)", latitude: 41.2565, longitude: -95.9345 },
	{ label: "Minneapolis, Minnesota", latitude: 44.9778, longitude: -93.265 },
	{ label: "Albert Lea, Minnesota (Iowa border)", latitude: 43.6478, longitude: -93.3683 },
	{ label: "Madison, Wisconsin", latitude: 43.0731, longitude: -89.4012 },
	{ label: "Rockford, Illinois", latitude: 42.2711, longitude: -89.094 },
	{ label: "Kansas City, Missouri", latitude: 39.0997, longitude: -94.5786 },
	{ label: "Sioux Falls, South Dakota", latitude: 43.5446, longitude: -96.7311 },
]

/**
 * How close to a delineation edge a disagreement is attributed to the channels' differing rendering rather than to the
 * conversion.
 *
 * One metre. The published shapefile carries nine decimals through this package's ingest and Soil Data Access renders
 * its own geometry independently; NRCS's own positional-accuracy statement says the difference between a boundary's
 * field location and its digitized location "is unknown", so this tolerance is about the two RENDERINGS agreeing rather
 * than about ground truth. One metre is far below the median delineation, which is 24,863 m² — about 158 m across.
 */
const BOUNDARY_TOLERANCE_METRES = 1

export interface VerifySoilOptions {
	databasePath: string
	client: Pick<SoilDataAccessClient, "mukeyAtPoint">
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
export async function verifySoilDatabase(options: VerifySoilOptions): Promise<VerifySoilResult> {
	const database = new DatabaseSync(options.databasePath, { readOnly: true })
	const lookup = new SoilCapabilityLookup({ databasePath: options.databasePath })

	try {
		const agreement: SoilAgreementRow[] = []

		for (const point of options.points) {
			const local = localDelineationAt(database, point.latitude, point.longitude)
			const serviceMukey = (await options.client.mukeyAtPoint(point.latitude, point.longitude)) ?? null

			const nearEdge = local.nearestEdgeMetres !== undefined && local.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			agreement.push({
				...point,
				localMukey: local.mukey,
				serviceMukey,
				outcome: local.mukey === serviceMukey ? "agree" : nearEdge ? "boundary_tolerance" : "disagree",
				...(local.nearestEdgeMetres === undefined ? {} : { nearestEdgeMetres: local.nearestEdgeMetres }),
			})

			options.onProgress?.(`${agreement.length}/${options.points.length} points compared`)
		}

		const outside: SoilOutsideRow[] = []

		for (const point of options.outsidePoints ?? OUTSIDE_PILOT_POINTS) {
			const reading = lookup.lookup(point.latitude, point.longitude)

			outside.push({ ...point, kind: reading.kind, passed: reading.kind === SoilReadingKind.Unknown })
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
		database.close()
	}
}

/**
 * Which map unit the ARTIFACT's own geometry puts at a point, and how far the point is from that delineation's nearest
 * edge.
 *
 * The bounding box is the prefilter; the ray cast decides. The edge distance is measured against the matched
 * delineation, or — where none matched — against every delineation whose box contains the point, so a near-miss is
 * still reported with a distance rather than with nothing.
 */
function localDelineationAt(
	database: DatabaseSync,
	latitude: number,
	longitude: number
): { mukey: string | null; nearestEdgeMetres?: number } {
	const candidates = database
		.prepare(
			"SELECT mukey, rings FROM soil_map_unit_area WHERE min_lat <= ? AND max_lat >= ? AND min_lon <= ? AND max_lon >= ?"
		)
		.all(latitude, latitude, longitude, longitude) as Array<{ mukey: string; rings: Uint8Array }>

	let mukey: string | null = null
	let nearest = Infinity

	for (const candidate of candidates) {
		const distance = nearestEdgeDistance(candidate.rings, longitude, latitude)

		if (distance < nearest) {
			nearest = distance
		}

		if (mukey === null && pointInEncodedRings(candidate.rings, longitude, latitude)) {
			mukey = candidate.mukey
		}
	}

	return Number.isFinite(nearest) ? { mukey, nearestEdgeMetres: nearest } : { mukey }
}

/**
 * Metres from a point to the nearest edge of an encoded ring set.
 *
 * Decoding here rather than walking the blob directly: this runs a few hundred times in a verification, not per
 * geocode, and the decoded form is what makes the segment walk readable.
 */
function nearestEdgeDistance(blob: Uint8Array, lon: number, lat: number): number {
	const { polygons } = decodeRings(blob)

	let nearest = Infinity

	for (const rings of polygons) {
		for (const ring of rings) {
			for (let index = 2; index < ring.length; index += 2) {
				const distance = segmentDistanceMetres(
					lon,
					lat,
					[ring[index - 2]!, ring[index - 1]!],
					[ring[index]!, ring[index + 1]!]
				)

				if (distance < nearest) {
					nearest = distance
				}
			}
		}
	}

	return nearest
}

/**
 * Draw a reproducible sample of points from the artifact.
 *
 * The draw is a deterministic stride over the primary key, not a random one, so a re-run compares the same points and a
 * disagreement can be looked at rather than re-rolled.
 *
 * THE KEYS ARE CHOSEN BEFORE ANY GEOMETRY IS READ. A `WHERE rowid % stride = 0` scan looks like the same thing and is
 * not: it walks the table itself, which means reading every ring blob to keep a few dozen. Selecting `area_id` alone is
 * an index-only walk over the primary key, and the rows it names are then fetched by key.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number }> {
	const count = options.count ?? 60
	const database = new DatabaseSync(databasePath, { readOnly: true })

	try {
		const areaIDs = (
			database.prepare("SELECT area_id FROM soil_map_unit_area ORDER BY area_id").all() as Array<{ area_id: string }>
		).map((row) => row.area_id)

		const stride = Math.max(1, Math.floor(areaIDs.length / Math.max(1, count)))

		const selectArea = database.prepare(
			"SELECT area_id, mukey, min_lat, min_lon, max_lat, max_lon, rings FROM soil_map_unit_area WHERE area_id = ?"
		)

		const points: Array<{ label: string; latitude: number; longitude: number }> = []

		for (let index = 0; index < areaIDs.length && points.length < count; index += stride) {
			const area = selectArea.get(areaIDs[index]!) as
				| {
						area_id: string
						mukey: string
						min_lat: number
						min_lon: number
						max_lat: number
						max_lon: number
						rings: Uint8Array
				  }
				| undefined

			if (!area) continue

			const interior = interiorPointOf(area)

			if (!interior) continue

			points.push({ label: `map unit ${area.mukey} delineation ${area.area_id}`, ...interior })
		}

		return points
	} finally {
		database.close()
	}
}

/**
 * A point inside one stored delineation.
 *
 * The bbox centre is tried first and is inside for the overwhelming majority of these; where it is not — a crescent, a
 * polygon with a hole through its middle — a small deterministic grid over the bbox is scanned. A delineation no grid
 * point lands inside is skipped rather than approximated, because a sample point that is not actually inside the
 * polygon turns the agreement check into a check on the sampler.
 */
function interiorPointOf(area: {
	min_lat: number
	min_lon: number
	max_lat: number
	max_lon: number
	rings: Uint8Array
}): { latitude: number; longitude: number } | undefined {
	const centreLat = (area.min_lat + area.max_lat) / 2
	const centreLon = (area.min_lon + area.max_lon) / 2

	if (pointInEncodedRings(area.rings, centreLon, centreLat)) {
		return { latitude: centreLat, longitude: centreLon }
	}

	const steps = 7

	for (let row = 1; row < steps; row++) {
		for (let column = 1; column < steps; column++) {
			const latitude = area.min_lat + ((area.max_lat - area.min_lat) * row) / steps
			const longitude = area.min_lon + ((area.max_lon - area.min_lon) * column) / steps

			if (pointInEncodedRings(area.rings, longitude, latitude)) return { latitude, longitude }
		}
	}

	return undefined
}
