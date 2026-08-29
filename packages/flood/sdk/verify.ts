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

import { DatabaseSync } from "@mailwoman/platform/sqlite"
import {
	expandH3Cell,
	interiorPointOfEncodedRings,
	pointInPolygonRings,
	segmentDistanceMetres,
	type H3CellShort,
} from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { cellToLatLng } from "h3-js"

import { FloodReadingKind, FloodZoneLookup, type FloodZoneReading } from "../index.ts"
import type { FloodDatabase } from "../schema.ts"
import { EA_FLOOD_LAYER } from "../vocabulary.ts"
import { EA_SPATIAL_BASE_URL, type EAFloodClient } from "./client.ts"

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
	 * The zone the service's own geometry assigns, or `null` where no service polygon contains the point.
	 */
	service: string | null
	outcome: "agree" | "disagree" | "boundary_tolerance"
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
 * them lands on opposite sides. Half a metre is threefold headroom over that and still far below any real polygon: the
 * feature that made this matter is a 20 m sliver.
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
	properties?: { flood_zone?: string }
	geometry?: { type: string; coordinates: unknown }
}

/**
 * The ONE call the verification makes against the service: the features it publishes near a point.
 *
 * A function rather than the client, and that is what makes the check's own logic testable. The comparison's value is
 * that it decides which of three outcomes a point gets; expressed against an HTTP client it could only ever be watched
 * on a live run, and a scripted reader lets those decisions be pinned. {@link createEAServiceReader} builds the real
 * one.
 */
export type ServiceFeatureReader = (latitude: number, longitude: number) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: an OGC API Features bbox query against the EA's own service.
 *
 * The service answers a BBOX, not a point, so this returns what it published nearby and the containment decision is
 * made in {@link readServiceZone} against those rings — comparing the artifact's verdict against a bare "the service
 * returned something here" would pass on any polygon within eleven metres.
 */
export function createEAServiceReader(client: Pick<EAFloodClient, "fetch">): ServiceFeatureReader {
	return async (latitude, longitude) => {
		const { data } = await client.fetch<{ features?: ServiceFeature[] }>({
			method: "GET",
			url: `${EA_SPATIAL_BASE_URL}/ogc/features/v1/collections/${EA_FLOOD_LAYER}/items`,
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
				outcome: localZone === service.zone ? "agree" : nearEdge ? "boundary_tolerance" : "disagree",
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
			outside,
			outsidePassed: outside.filter((row) => row.passed).length,
		}
	} finally {
		lookup.close()
	}
}

/**
 * What zone the SERVICE's own geometry assigns at a point, decided here with the same even-odd rule the artifact's
 * reader uses — so what is compared is a verdict against a verdict.
 */
async function readServiceZone(
	readServiceFeatures: ServiceFeatureReader,
	latitude: number,
	longitude: number
): Promise<{ zone: string | null; nearestEdgeMetres?: number }> {
	const features = await readServiceFeatures(latitude, longitude)

	let nearest = Infinity
	let zone: string | null = null

	for (const feature of features) {
		const geometry = feature.geometry

		if (!geometry) continue

		const polygons =
			geometry.type === "MultiPolygon"
				? (geometry.coordinates as number[][][][])
				: [geometry.coordinates as number[][][]]

		for (const rings of polygons) {
			for (const ring of rings) {
				for (let i = 1; i < ring.length; i++) {
					const distance = segmentDistanceMetres(longitude, latitude, ring[i - 1]!, ring[i]!)

					if (distance < nearest) {
						nearest = distance
					}
				}
			}

			if (zone === null && pointInPolygonRings(longitude, latitude, rings as [number, number][][])) {
				zone = feature.properties?.flood_zone ?? null
			}
		}
	}

	return Number.isFinite(nearest) ? { zone, nearestEdgeMetres: nearest } : { zone }
}

/**
 * Draw a reproducible sample of points from the artifact: some inside polygons, some inside the footprint and outside
 * every polygon.
 *
 * BOTH KINDS ARE REQUIRED. A sample drawn only from inside polygons never exercises the designated-absence reading,
 * which is the reading this product's Zone-1-as-absence design turns on — and an artifact that answered `unknown`
 * everywhere except inside a polygon would pass a polygon-only sample.
 *
 * The draw is a deterministic stride over the primary key and over the coverage cells, not a random one, so a re-run
 * compares the same points and a disagreement can be looked at rather than re-rolled.
 *
 * THE KEYS ARE CHOSEN BEFORE ANY GEOMETRY IS READ. A `WHERE rowid % stride = 0` scan looks like the same thing and is
 * not: it walks the table itself, which at national scale means reading gigabytes of ring blobs to keep forty of them.
 * Selecting `area_id` alone is an index-only walk over the primary key, and the rows it names are then fetched by key.
 */
export function sampleAgreementPoints(
	databasePath: string,
	options: { insideCount?: number; absenceCount?: number } = {}
): Array<{ label: string; latitude: number; longitude: number }> {
	const insideCount = options.insideCount ?? 40
	const absenceCount = options.absenceCount ?? 20
	const database = new DatabaseClient<FloodDatabase>(databasePath, { readOnly: true })

	try {
		const points: Array<{ label: string; latitude: number; longitude: number }> = []

		const areaIDs = (
			database.prepare("SELECT area_id FROM flood_zone_area ORDER BY area_id").all() as Array<{ area_id: string }>
		).map((row) => row.area_id)

		const stride = Math.max(1, Math.floor(areaIDs.length / Math.max(1, insideCount)))

		const selectArea = database.prepare(
			"SELECT area_id, zone_code, min_lat, min_lon, max_lat, max_lon, rings FROM flood_zone_area WHERE area_id = ?"
		)

		for (let index = 0; index < areaIDs.length && points.length < insideCount; index += stride) {
			const area = selectArea.get(areaIDs[index]!) as
				| {
						area_id: string
						zone_code: string
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

			points.push({ label: `${area.zone_code} polygon ${area.area_id}`, ...interior })
		}

		// A designated absence is a coverage cell the authority determined and no polygon reaches — exactly the cells whose
		// `observed_rows` is zero, which is the storable form of a Zone 1 designation.
		const emptyCount = (
			database.prepare("SELECT count(*) AS n FROM layer_coverage WHERE observed_rows = 0").get() as { n: number }
		).n

		const emptyStride = Math.max(1, Math.floor(emptyCount / Math.max(1, absenceCount)))

		const emptyCells = database
			.prepare("SELECT h3_cell FROM layer_coverage WHERE observed_rows = 0 ORDER BY h3_cell")
			.all() as Array<{ h3_cell: number }>

		const coverageResolution = (
			database.prepare("SELECT coverage_resolution AS r FROM flood_map_extent").get() as { r: number }
		).r

		for (let index = 0; index < emptyCells.length && points.length < insideCount + absenceCount; index += emptyStride) {
			const short = emptyCells[index]!.h3_cell.toString(16).padStart(13, "0") as H3CellShort
			const cell = expandH3Cell(short, coverageResolution)
			const [latitude, longitude] = cellToLatLng(cell)

			points.push({ label: `designated absence in ${cell}`, latitude, longitude })
		}

		return points
	} finally {
		database.destroy()
	}
}
