/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two-path agreement check, and its negative half.
 *
 *   POSITIVE HALF. A sample of points is answered from the sealed artifact and then re-asked of the
 *   Department's own feature service — the same authority, a different distribution channel, and geometry
 *   this package has never touched. The point test is run again on the service's own rings, so what is
 *   compared is a verdict against a verdict rather than a file against itself. That is what makes it a check
 *   on OUR CONVERSION rather than on the authority.
 *
 *   AND THE SERVICE ANSWERS IN THE PUBLISHER'S OWN RING CONVENTION, so the comparison exercises the hole
 *   handling twice over. `outSR=4326` on the query path returns the same clockwise-exterior rings the bulk
 *   export carries, so this side re-derives the roles the same way the ingest did — and a point inside a hole
 *   comes back OUTSIDE on both paths or on neither.
 *
 *   NEGATIVE HALF, AND IT MATTERS MORE HERE THAN FOR ANY SIBLING LAYER. Donegal is the one local authority of
 *   31 the Department does not publish, and Northern Ireland is outside the product entirely — so points in
 *   both must come back `unknown` with NO designation. A positive-only check would pass on an artifact that
 *   reported the whole island as zoned, and this layer's entire coverage posture exists because an absent
 *   polygon is not a statement.
 *
 *   THE CHANNELS DIFFER IN COORDINATE PRECISION AND THAT IS WHY A BOUNDARY POINT IS NOT A FAILURE. The
 *   archive publishes nine decimals through this package's ingest; the service's own JSON rounds. A point
 *   within roughly a metre of a zone boundary can land on opposite sides of two renderings of the same edge.
 *   Those are reported as `boundary_tolerance` with their distance to the nearest edge, and the count is part
 *   of the receipt.
 *
 *   THE DISTANCE IS TO THE EDGE, NOT TO THE NEAREST VERTEX. A point a centimetre from a long edge can be
 *   metres from every vertex of it — a sibling layer's one near-miss read 1.58 m to vertices and 0.009 m to
 *   edges, an overstatement of 175-fold — so measuring vertices makes the boundary tolerance far stricter than
 *   it reads, which is how a rendering difference gets reported as a conversion defect.
 */

import { interiorPointOfEncodedRings, pointInEncodedRings, segmentDistanceMetres } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { ZoningLookup, ZoningReadingKind, type ZoningReading } from "../index.ts"
import { encodeRings, resolveRingRoles, type MultiPolygonRings, type PolygonRings } from "../rings.ts"
import type { ZoningDatabase } from "../schema.ts"
import type { GZTClient } from "./client.ts"

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
	local: ZoningReading
	/**
	 * Whether the service's own geometry places the point inside a zoning polygon.
	 */
	serviceInside: boolean
	/**
	 * The local code the SERVICE reports at the point, where it reports one. Compared verbatim against the artifact's,
	 * because carrying the code verbatim is what this layer is for: two paths that agree on containment and disagree on
	 * the code would be a silent vocabulary defect.
	 */
	serviceLocalCode?: string
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
 * The negative half: a point this product's publication does not reach.
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

export interface VerifyZoningResult {
	agreement: AgreementRow[]
	agreed: number
	disagreed: number
	boundaryTolerance: number
	/**
	 * Points where both paths placed the location inside a zone and the local codes differed.
	 */
	codeMismatches: number
	outside: OutsideRow[]
	outsidePassed: number
}

/**
 * Points this product's publication does not reach, named. Each is a place, not a bare pair of numbers: a coordinate a
 * reader cannot name is a coordinate nobody can check.
 *
 * TWO POPULATIONS, AND BOTH ARE LOAD-BEARING. The Donegal points are the case this layer's coverage posture exists for
 * — the Department has not published that authority's zoning, and a builder that read absence as "unrestricted" would
 * answer them confidently. The Northern Irish points confirm the artifact is clipped to the Republic rather than to the
 * island: zoning there is a different jurisdiction's instrument under a different planning act.
 */
export const OUTSIDE_PUBLICATION_POINTS: ReadonlyArray<{ label: string; latitude: number; longitude: number }> = [
	{ label: "Letterkenny town centre, Donegal", latitude: 54.9503, longitude: -7.7345 },
	{ label: "Buncrana, Donegal", latitude: 55.1367, longitude: -7.4561 },
	{ label: "Donegal Town", latitude: 54.6538, longitude: -8.1096 },
	{ label: "Belfast city centre, Northern Ireland", latitude: 54.5973, longitude: -5.9301 },
	{ label: "Derry city centre, Northern Ireland", latitude: 54.9966, longitude: -7.3086 },
	{ label: "Enniskillen, Northern Ireland", latitude: 54.3438, longitude: -7.6316 },
]

/**
 * Half-width of the bounding box the service is asked for, in degrees. About 11 m at this latitude — wide enough that a
 * polygon containing the point is certainly returned, narrow enough that the response stays small.
 */
const PROBE_HALF_WIDTH_DEGREES = 0.0001

/**
 * How close to a service-polygon edge a disagreement is attributed to the channels' differing coordinate precision
 * rather than to the conversion.
 *
 * Half a metre. The two channels render the same edge from the same source coordinates through different rounding, so a
 * point between the two renderings lands on opposite sides; half a metre is far below any real zoning boundary and far
 * above the rounding difference.
 */
const BOUNDARY_TOLERANCE_METRES = 0.5

/**
 * One feature as the service publishes it — the only shape the comparison reads.
 */
export interface ServiceFeature {
	properties?: Record<string, unknown>
	geometry?: { type: string; coordinates: unknown }
}

/**
 * The ONE call the verification makes against the service: the features it publishes near a point.
 *
 * A function rather than the client, and that is what makes the check's own logic testable. The comparison's value is
 * that it decides which of three outcomes a point gets; expressed against an HTTP client it could only ever be watched
 * on a live run, and a scripted reader lets those decisions be pinned. {@link createServiceReader} builds the real
 * one.
 */
export type ServiceFeatureReader = (latitude: number, longitude: number) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: a bounding-box query against the Department's own service.
 *
 * The service answers a BOX, not a point, so this returns what it published nearby and the containment decision is made
 * in {@link readServiceContainment} against those rings — comparing the artifact's verdict against a bare "the service
 * returned something here" would pass on any polygon within eleven metres.
 */
export function createServiceReader(client: Pick<GZTClient, "readFeaturesNear">): ServiceFeatureReader {
	return async (latitude, longitude) => client.readFeaturesNear(latitude, longitude, PROBE_HALF_WIDTH_DEGREES)
}

export interface VerifyZoningOptions {
	databasePath: string
	readServiceFeatures: ServiceFeatureReader
	/**
	 * Points to re-ask the service about. A caller samples them from the artifact — see {@link sampleAgreementPoints}.
	 */
	points: ReadonlyArray<{ label: string; latitude: number; longitude: number; localCode?: string }>
	outsidePoints?: ReadonlyArray<{ label: string; latitude: number; longitude: number }>
	onProgress?: (message: string) => void
}

/**
 * Run both halves.
 */
export async function verifyZoningDatabase(options: VerifyZoningOptions): Promise<VerifyZoningResult> {
	const lookup = new ZoningLookup({ databasePath: options.databasePath })

	try {
		const agreement: AgreementRow[] = []

		for (const point of options.points) {
			const local = lookup.lookup(point.latitude, point.longitude)
			const service = await readServiceContainment(options.readServiceFeatures, point.latitude, point.longitude)
			const localInside = local.kind === ZoningReadingKind.Designated
			const nearEdge = service.nearestEdgeMetres !== undefined && service.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			agreement.push({
				label: point.label,
				latitude: point.latitude,
				longitude: point.longitude,
				local,
				serviceInside: service.inside,
				...(service.localCode === undefined ? {} : { serviceLocalCode: service.localCode }),
				outcome: localInside === service.inside ? "agree" : nearEdge ? "boundary_tolerance" : "disagree",
				...(service.nearestEdgeMetres === undefined ? {} : { nearestEdgeMetres: service.nearestEdgeMetres }),
			})

			options.onProgress?.(`${agreement.length}/${options.points.length} points compared`)
		}

		const outside: OutsideRow[] = []

		for (const point of options.outsidePoints ?? OUTSIDE_PUBLICATION_POINTS) {
			const reading = lookup.lookup(point.latitude, point.longitude)

			outside.push({
				label: point.label,
				latitude: point.latitude,
				longitude: point.longitude,
				kind: reading.kind,
				designations: reading.designations.length,
				passed: reading.kind === ZoningReadingKind.Unknown && reading.designations.length === 0,
			})
		}

		return {
			agreement,
			agreed: agreement.filter((row) => row.outcome === "agree").length,
			disagreed: agreement.filter((row) => row.outcome === "disagree").length,
			boundaryTolerance: agreement.filter((row) => row.outcome === "boundary_tolerance").length,
			codeMismatches: agreement.filter(
				(row) =>
					row.outcome === "agree" &&
					row.serviceInside &&
					row.serviceLocalCode !== undefined &&
					!row.local.designations.some((designation) => designation.localCode === row.serviceLocalCode)
			).length,
			outside,
			outsidePassed: outside.filter((row) => row.passed).length,
		}
	} finally {
		lookup[Symbol.dispose]()
	}
}

/**
 * Whether the SERVICE's own geometry contains the point, decided here with the same ring-role resolution and the same
 * even-odd rule the artifact's reader uses — so what is compared is a verdict against a verdict.
 */
async function readServiceContainment(
	readServiceFeatures: ServiceFeatureReader,
	latitude: number,
	longitude: number
): Promise<{ inside: boolean; localCode?: string; nearestEdgeMetres?: number }> {
	const features = await readServiceFeatures(latitude, longitude)

	let nearest = Infinity
	let inside = false
	let localCode: string | undefined

	for (const feature of features) {
		const geometry = feature.geometry

		if (!geometry) continue

		const raw: MultiPolygonRings =
			geometry.type === "MultiPolygon"
				? (geometry.coordinates as MultiPolygonRings)
				: [geometry.coordinates as PolygonRings]

		for (const rings of raw) {
			for (const ring of rings) {
				for (let index = 1; index < ring.length; index++) {
					const distance = segmentDistanceMetres(longitude, latitude, ring[index - 1]!, ring[index]!)

					if (distance < nearest) {
						nearest = distance
					}
				}
			}
		}

		// THE SERVICE'S RINGS GET THE SAME ROLE RESOLUTION THE INGEST GAVE THE ARCHIVE'S. The publisher uses one convention on
		// both channels, so reading this side as nested GeoJSON would answer "inside" for a point in a hole and report the
		// artifact as wrong at exactly the locations the hole handling exists for.
		const resolved = resolveRingRoles(raw, `service feature near ${latitude},${longitude}`)

		// ENCODED AND RE-READ RATHER THAN RAY-CAST DIRECTLY, deliberately: the artifact answers through
		// `pointInEncodedRings`, and running the service's geometry through a different predicate would compare two answers
		// that were never asked the same question.
		if (pointInEncodedRings(encodeRings(resolved.polygons), longitude, latitude)) {
			inside = true

			const code = feature.properties?.ZONE_ORIG

			if (typeof code === "string" && localCode === undefined) {
				localCode = code
			}
		}
	}

	return {
		inside,
		...(localCode === undefined ? {} : { localCode }),
		...(Number.isFinite(nearest) ? { nearestEdgeMetres: nearest } : {}),
	}
}

/**
 * Draw a reproducible sample of points from the artifact — interior points of stored polygons, spread across
 * authorities.
 *
 * SPREAD ACROSS AUTHORITIES RATHER THAN DRAWN FROM ONE, because 30 local authorities publish 581 distinct local codes
 * between them and a sample from one would verify one authority's conversion while reporting on all of them. The draw
 * is a deterministic stride over the primary key, not a random one, so a re-run compares the same points and a
 * disagreement can be looked at rather than re-rolled.
 *
 * THE KEYS ARE CHOSEN BEFORE ANY GEOMETRY IS READ. A `WHERE rowid % stride = 0` scan looks like the same thing and is
 * not: it walks the table itself, which means reading ring blobs to keep a few dozen of them. Selecting `area_id` alone
 * is an index-only walk over the primary key, and the rows it names are then fetched by key.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number; localCode: string }> {
	const count = options.count ?? 48
	using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

	const points: Array<{ label: string; latitude: number; longitude: number; localCode: string }> = []

	// ORDERED BY THE AUTHORITY FIRST, so a stride walks across the 30 of them rather than down one. A stride over
	// `area_id` alone would follow the publisher's own feature numbering, which is grouped by authority — and would draw
	// every sample from whichever authorities happen to sit on the stride.
	const areaIDs = (
		database.prepare("SELECT area_id FROM zoning_area ORDER BY jurisdiction_id, area_id").all() as Array<{
			area_id: string
		}>
	).map((row) => row.area_id)

	if (!areaIDs.length) return points

	const stride = Math.max(1, Math.floor(areaIDs.length / Math.max(1, count)))

	const selectArea = database.prepare(
		"SELECT area_id, jurisdiction_id, local_code, min_lat, min_lon, max_lat, max_lon, rings FROM zoning_area WHERE area_id = ?"
	)

	for (let index = 0; index < areaIDs.length && points.length < count; index += stride) {
		const area = selectArea.get(areaIDs[index]!) as
			| {
					area_id: string
					jurisdiction_id: string
					local_code: string
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
			label: `${area.jurisdiction_id} ${JSON.stringify(area.local_code)} polygon ${area.area_id}`,
			localCode: area.local_code,
			...interior,
		})
	}

	return points
}
