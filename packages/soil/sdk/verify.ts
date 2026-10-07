/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
import type { PathBuilderLike } from "path-ts"

import { SoilCapabilityLookup, SoilReadingKind } from "#index"
import type { SoilDatabase } from "#schema"
import type { SoilDataAccessClient } from "#sdk/client"

/**
 * One comparison row for a point.
 * It records both verdicts and whether they agree.
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
	 * Meters from the point to the nearest edge of the delineation the artifact matched.
	 *
	 * Included on every row because it separates a real defect from two channels
	 * rendering the same edge differently.
	 */
	nearestEdgeMetres: number | null
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
	 * True when the artifact answered `unknown`, the only acceptable reading outside the built survey areas.
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
 * Points outside the pilot region.
 *
 * Every neighboring state is included because a footprint clipped to "the
 * Midwest" would pass a one-state check.
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
 * One meter, far below the median delineation, so a disagreement within it is the two
 * channels rendering the same edge differently rather than a conversion defect.
 */
const BOUNDARY_TOLERANCE_METRES = 1

export interface VerifySoilOptions {
	databasePath: PathBuilderLike
	client: Pick<SoilDataAccessClient, "mukeyAtPoint">
	/**
	 * Points to re-ask the service about, sampled from the artifact — see {@link sampleAgreementPoints}.
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

	// Read once: the stored index is mixed-resolution, so a probe that assumed one
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

			const nearEdge = local.nearestEdgeMetres !== null && local.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			agreement.push({
				...point,
				localMukey: local.mukey,
				serviceMukey,
				outcome: local.mukey === serviceMukey ? "agree" : nearEdge ? "boundary_tolerance" : "disagree",
				nearestEdgeMetres: local.nearestEdgeMetres,
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
		lookup[Symbol.dispose]()
		await database.destroy()
	}
}

/**
 * The candidate delineations reaching a point, found through the cell index
 * because a bounding-box scan over `soil_map_unit_area` is a full table scan. every
 * stored resolution is probed since the tier is compacted parent-ward.
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
			// Dedupe on the delineation rather than its map unit, since two different delineations
			// of one map unit cover different ground and both must be tested.
			if (seen.has(row.area_id)) continue

			seen.add(row.area_id)
			candidates.push({ mukey: row.mukey, rings: row.rings })
		}
	}

	return candidates
}

/**
 * The map unit that the artifact's geometry places at a point.
 *
 * Also records the distance to that delineation's nearest edge.
 */
function localDelineationAt(
	database: DatabaseClient<SoilDatabase>,
	resolutions: readonly number[],
	indexResolution: number,
	latitude: number,
	longitude: number
): { mukey: string | null; nearestEdgeMetres: number | null } {
	const candidates = candidateDelineations(database, resolutions, indexResolution, latitude, longitude)

	let mukey: string | null = null
	let nearest = Infinity

	for (const candidate of candidates) {
		const distance = nearestEdgeDistance(candidate.rings, longitude, latitude)

		if (distance < nearest) {
			nearest = distance
		}

		if (!mukey && pointInEncodedRings(candidate.rings, longitude, latitude)) {
			mukey = candidate.mukey
		}
	}

	return { mukey, nearestEdgeMetres: Number.isFinite(nearest) ? nearest : null }
}

/**
 * Meters from a point to the nearest edge of an encoded ring set.
 *
 * This function decodes here because it runs once per verification rather than once per geocode.
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
 * Draw a reproducible sample of points from the artifact, a deterministic stride
 * over the primary key so a re-run compares the same points.
 */
export function sampleAgreementPoints(
	databasePath: PathBuilderLike,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number }> {
	const count = options.count ?? 60
	using database = new DatabaseClient<SoilDatabase>(databasePath, { readOnly: true })

	const total = (database.prepare("SELECT count(*) AS n FROM soil_map_unit_area").get() as { n: number }).n
	const stride = Math.max(1, Math.floor(total / Math.max(1, count)))

	// Use one offset probe per sample point instead of materializing a key list.
	// That list would retain every primary key to select sixty points.
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
}
