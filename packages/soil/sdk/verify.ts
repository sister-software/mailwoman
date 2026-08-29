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
 *   reaches the GEOMETRY — the truth table — rather than the reduction: the reduction is a per-cell
 *   distribution and has no single map unit to compare. That makes this a check on the CONVERSION, which is
 *   what it is for; the reduction is checked by the fixtures and by the share-sum invariant.
 *
 *   IT REACHES IT THROUGH THE CELL INDEX, NOT THROUGH A BOUNDING-BOX SCAN. A `WHERE min_lat <= ? AND …` over
 *   the geometry table reads like a prefilter and is a full table scan: none of those columns is indexed and
 *   every row carries a ring blob, so at the pilot's 2.7 million delineations it reads gigabytes per point.
 *   Naming the point's cell is a primary-key range scan over a `WITHOUT ROWID` table, which is the whole
 *   reason the index exists.
 */

import {
	decodeRings,
	interiorPointOfEncodedRings,
	pointInEncodedRings,
	segmentDistanceMetres,
	shortCellToInt,
	type H3Cell,
} from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToParent, latLngToCell } from "h3-js"

import { SoilCapabilityLookup, SoilReadingKind } from "../index.ts"
import type { SoilDatabase } from "../schema.ts"
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
	const database = new DatabaseClient<SoilDatabase>(options.databasePath, { readOnly: true })
	const lookup = new SoilCapabilityLookup({ databasePath: options.databasePath })

	// Read once: the stored index is mixed-resolution because the whole tier is compacted, and a probe that assumed one
	// resolution would read every row at the others as an absence.
	const resolutions = (
		database.prepare("SELECT DISTINCT resolution FROM soil_map_unit_cell ORDER BY resolution").all() as Array<{
			resolution: number
		}>
	).map((row) => row.resolution)

	const { indexResolution } = lookup.identity

	try {
		const agreement: SoilAgreementRow[] = []

		for (const point of options.points) {
			const local = localDelineationAt(database, resolutions, indexResolution, point.latitude, point.longitude)
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
		await database.destroy()
	}
}

/**
 * The candidate delineations reaching a point, found THROUGH THE CELL INDEX rather than by scanning the geometry table.
 *
 * A bounding-box `WHERE` over `soil_map_unit_area` reads as a prefilter and is a FULL TABLE SCAN: none of those columns
 * is indexed, the rows carry the ring blobs, and at the pilot's scale that is 2.7 million rows and several gigabytes
 * read per point. The cell index exists to make exactly this question cheap — `soil_map_unit_cell` is `WITHOUT ROWID`
 * keyed `(h3_cell, area_id)`, so naming the point's cell is a primary-key range scan.
 *
 * EVERY STORED RESOLUTION IS PROBED, not just the index one. The whole tier is compacted parent-ward, so a delineation
 * that fills a run of cells is stored at a coarser resolution and a probe at the index resolution alone would read it
 * as an absence — the same ancestor walk the reader does, and the same false negative it avoids.
 */
function candidateDelineations(
	database: DatabaseClient<SoilDatabase>,
	resolutions: readonly number[],
	indexResolution: number,
	latitude: number,
	longitude: number
): Array<{ mukey: string; rings: Uint8Array }> {
	const selectCandidates = database.prepare(
		"SELECT c.area_id AS area_id, a.mukey AS mukey, a.rings AS rings FROM soil_map_unit_cell c " +
			"JOIN soil_map_unit_area a ON a.area_id = c.area_id WHERE c.h3_cell = ?"
	)

	const indexCell = latLngToCell(latitude, longitude, indexResolution) as H3Cell
	const seen = new Set<string>()
	const candidates: Array<{ mukey: string; rings: Uint8Array }> = []

	for (const resolution of resolutions) {
		const cell = resolution === indexResolution ? indexCell : (cellToParent(indexCell, resolution) as H3Cell)

		for (const row of selectCandidates.all(shortCellToInt(cell)) as Array<{
			area_id: string
			mukey: string
			rings: Uint8Array
		}>) {
			// DEDUPE ON THE DELINEATION, NEVER ON ITS MAP UNIT. A delineation reached through two resolutions is one
			// delineation and must be tested once; two DIFFERENT delineations of the same map unit are two shapes covering
			// different ground and must both be tested. Keying on the map unit drops the second, and it drops it silently —
			// the point test simply finds nothing and the row reads as a disagreement with the authority. Measured at Iowa
			// scale: one point in 60, where the artifact's own geometry does contain the point and the index-driven read
			// could not reach the delineation that holds it.
			if (seen.has(row.area_id)) continue

			seen.add(row.area_id)
			candidates.push({ mukey: row.mukey, rings: row.rings })
		}
	}

	return candidates
}

/**
 * Which map unit the ARTIFACT's own geometry puts at a point, and how far the point is from that delineation's nearest
 * edge.
 *
 * The cell index narrows; the ray cast decides. The edge distance is measured against every candidate, so a near-miss
 * is reported with a distance rather than with nothing.
 */
function localDelineationAt(
	database: DatabaseClient<SoilDatabase>,
	resolutions: readonly number[],
	indexResolution: number,
	latitude: number,
	longitude: number
): { mukey: string | null; nearestEdgeMetres?: number } {
	const candidates = candidateDelineations(database, resolutions, indexResolution, latitude, longitude)

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
 * ONE ROW IS READ PER SAMPLE POINT AND NO MORE. A `WHERE rowid % stride = 0` scan looks like the same thing and is not:
 * it walks the table itself, which means reading every ring blob to keep a few dozen. `ORDER BY area_id LIMIT 1 OFFSET
 * n` walks the primary-key index to the offset and fetches exactly the row it lands on.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number }> {
	const count = options.count ?? 60
	const database = new DatabaseClient<SoilDatabase>(databasePath, { readOnly: true })

	try {
		const total = (database.prepare("SELECT count(*) AS n FROM soil_map_unit_area").get() as { n: number }).n
		const stride = Math.max(1, Math.floor(total / Math.max(1, count)))

		// One OFFSET probe per sample point rather than one materialized key list. The list looks cheap because it reads
		// only the primary key, and at the pilot's 2.7 million delineations it is still 2.7 million strings held to keep
		// sixty of them.
		const selectByOffset = database.prepare(
			"SELECT area_id, mukey, min_lat, min_lon, max_lat, max_lon, rings FROM soil_map_unit_area ORDER BY area_id LIMIT 1 OFFSET ?"
		)

		const points: Array<{ label: string; latitude: number; longitude: number }> = []

		for (let index = 0; index < total && points.length < count; index += stride) {
			const area = selectByOffset.get(index) as
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

			const interior = interiorPointOfEncodedRings(area, 7)

			if (!interior) continue

			points.push({ label: `map unit ${area.mukey} delineation ${area.area_id}`, ...interior })
		}

		return points
	} finally {
		database.destroy()
	}
}
