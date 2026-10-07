/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The check compares the artifact with a second path. A separate half tests locations outside its coverage.
 *
 *   The positive half samples points from the sealed artifact and asks the Department's feature service about them.
 *   The service supplies geometry through a separate distribution channel. This package has not touched that geometry.
 *   The check runs the point test on the service's rings. It compares two verdicts from the same authority.
 *   This measures our conversion against the authority's published geometry.
 *
 *   The service returns geometry in the publisher's ring convention. `outSR=4326` returns the same clockwise-exterior
 *   rings as the bulk export. This path re-derives ring roles as ingest does. A point inside a hole then falls outside
 *   on both paths or inside on both paths.
 *
 *   The negative half checks locations outside the publication area. The Department omits Donegal, one of 31 local
 *   authorities. The product also excludes Northern Ireland. Points in both areas must return `unknown` with no
 *   designation. A positive-only check could pass an artifact that reports the whole island as zoned. The layer treats
 *   a missing polygon as no zoning statement.
 *
 *   The channels use different coordinate precision. A boundary-point disagreement therefore does not establish a
 *   conversion defect. The archive publishes nine decimals through this package's ingest. The service rounds its JSON.
 *   A point within roughly a meter of a zone boundary can fall on opposite sides of the two rendered edges. The check
 *   reports these cases as `boundary_tolerance` with the distance to the nearest edge. The receipt includes their count.
 *
 *   The distance measures to the edge rather than to the nearest vertex. A point a centimeter from a long edge can be
 *   meters from every vertex. In one sibling-layer near-miss, vertex distance measured 1.58 m and edge distance
 *   measured 0.009 m. The vertex measurement overstated distance by 175 times. It would make the stated boundary
 *   tolerance stricter and report a rendering difference as a conversion defect.
 */

import type { OGCFeature } from "@mailwoman/core/api"
import { stringifyJSON } from "@mailwoman/core/json"
import type { OutsideCoverageRow } from "@mailwoman/core/layers"
import {
	nearestRingEdgeMetres,
	pointInEncodedRings,
	strideSampleInteriorPoints,
	encodeRings,
	type MultiPolygonRings,
	type PolygonRings,
} from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

import { ZoningLookup, ZoningReadingKind, type ZoningReading } from "#index"
import { resolveRingRoles } from "#rings"
import type { ZoningDatabase } from "#schema"
import type { GZTClient } from "#sdk/client"

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
	local: ZoningReading
	/**
	 * Whether the service's own geometry places the point inside a zoning polygon.
	 */
	serviceInside: boolean
	/**
	 * The local code the service reports at the point, where it reports one.
	 *
	 * Compared verbatim against the artifact's, because carrying the code verbatim
	 * is what this layer is for: two paths that agree on containment and disagree
	 * on the code would be a silent vocabulary defect.
	 */
	serviceLocalCode: string | null
	outcome: "agree" | "disagree" | "boundary_tolerance"
	/**
	 * Meters from the point to the nearest edge of any polygon the service returned nearby.
	 *
	 * Every row includes this distance.
	 * It separates a real defect from a difference caused by the two channels
	 * rendering the same edge differently.
	 *
	 * A receipt without it forces a re-run.
	 * `null` means the service returned no polygon at all near the point.
	 */
	nearestEdgeMetres: number | null
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
	outside: OutsideCoverageRow[]
	outsidePassed: number
}

/**
 * Point identifiers for locations outside this product's publication area.
 *
 * Each is a place rather than a bare pair of numbers: a coordinate a reader a
 * coordinate without a reference source cannot be checked.
 *
 * The check requires points from two populations.
 * The Donegal points are the case this layer's coverage posture exists for.
 *
 * The Department has not published that authority's zoning.
 * A builder that reads the absence as "unrestricted" would answer these points confidently.
 *
 * The Northern Irish points confirm the artifact is clipped to the Republic rather than to the
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
 * Half-width of the bounding box the service is asked for, in degrees.
 *
 * About 11 m at this latitude — wide enough that a polygon containing the point is
 * certainly returned, narrow enough that the response stays small.
 */
const PROBE_HALF_WIDTH_DEGREES = 0.0001

/**
 * How close to a service-polygon edge a disagreement is attributed to the channels'
 * differing coordinate precision rather than to the conversion.
 *
 * Half a meter.
 * The two channels render the same edge from the same source coordinates through different
 * rounding, so a point between the two renderings lands on opposite sides.
 *
 * Half a meter is far below any real zoning boundary and far above the rounding difference.
 */
const BOUNDARY_TOLERANCE_METRES = 0.5

/**
 * One feature as the service publishes it.
 * The only shape the comparison reads.
 */
export type ServiceFeature = OGCFeature

/**
 * The one call the verification makes against the service: the features it publishes near a point.
 *
 * The function exposes only the service read.
 * This keeps the check's own logic testable.
 *
 * The comparison's value is that it decides which of three outcomes a point gets.
 *
 * An HTTP client would let tests observe these decisions only during a live run.
 * A scripted reader pins the decisions. {@link createServiceReader} builds the real reader.
 */
export type ServiceFeatureReader = (latitude: number, longitude: number) => Promise<ServiceFeature[]>

/**
 * The reader the live check uses: a bounding-box query against the Department's own service.
 *
 * The service answers a BOX rather than a point, so this returns what it published nearby
 * and the containment decision is made in {@link readServiceContainment} against
 * those rings — comparing the artifact's verdict against a bare "the service returned
 * something here" would pass on any polygon within eleven meters.
 */
export function createServiceReader(client: Pick<GZTClient, "readFeaturesNear">): ServiceFeatureReader {
	return async (latitude, longitude) => client.readFeaturesNear(latitude, longitude, PROBE_HALF_WIDTH_DEGREES)
}

export interface VerifyZoningOptions {
	databasePath: PathBuilderLike
	readServiceFeatures: ServiceFeatureReader
	/**
	 * Points to re-ask the service about.
	 *
	 * A caller samples them from the artifact — see {@link sampleAgreementPoints}.
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
			const nearEdge = service.nearestEdgeMetres !== null && service.nearestEdgeMetres <= BOUNDARY_TOLERANCE_METRES

			agreement.push({
				label: point.label,
				latitude: point.latitude,
				longitude: point.longitude,
				local,
				serviceInside: service.inside,
				serviceLocalCode: service.localCode,
				outcome: localInside === service.inside ? "agree" : nearEdge ? "boundary_tolerance" : "disagree",
				nearestEdgeMetres: service.nearestEdgeMetres,
			})

			options.onProgress?.(`${agreement.length}/${options.points.length} points compared`)
		}

		const outside: OutsideCoverageRow[] = []

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
					row.serviceLocalCode !== null &&
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
 * Whether the service's own geometry contains the point, decided here with the same
 * ring-role resolution and the same even-odd rule the artifact's reader uses.
 * So what is compared is a verdict against a verdict.
 */
async function readServiceContainment(
	readServiceFeatures: ServiceFeatureReader,
	latitude: number,
	longitude: number
): Promise<{ inside: boolean; localCode: string | null; nearestEdgeMetres: number | null }> {
	const features = await readServiceFeatures(latitude, longitude)

	let nearest = Infinity
	let inside = false
	let localCode: string | null = null

	for (const feature of features) {
		const geometry = feature.geometry

		if (!geometry) continue

		const raw: MultiPolygonRings =
			geometry.type === "MultiPolygon"
				? (geometry.coordinates as MultiPolygonRings)
				: [geometry.coordinates as PolygonRings]

		const distance = nearestRingEdgeMetres(geometry, longitude, latitude)

		if (distance < nearest) {
			nearest = distance
		}

		// the service'S rings GET the same role resolution the ingest gave the archive'S.
		// The publisher uses one convention on both channels, so reading this side as nested
		// GeoJSON would answer "inside" for a point in a hole and report the artifact as
		// wrong at exactly the locations the hole handling exists for.
		const resolved = resolveRingRoles(raw, `service feature near ${latitude},${longitude}`)

		// encoded and RE-read rather than RAY-cast directly, deliberately: the artifact answers
		// through `pointInEncodedRings`, and running the service's geometry through a different
		// predicate would compare two answers that were never asked the same question.
		if (pointInEncodedRings(encodeRings(resolved.polygons), longitude, latitude)) {
			inside = true

			const code = feature.properties?.ZONE_ORIG

			if (typeof code === "string" && !localCode) {
				localCode = code
			}
		}
	}

	return {
		inside,
		localCode,
		nearestEdgeMetres: Number.isFinite(nearest) ? nearest : null,
	}
}

/**
 * Draw a reproducible sample of points from the artifact — interior points of
 * stored polygons, spread across authorities.
 *
 * Spread across authorities rather than drawn from one, because 30 local authorities
 * publish 581 distinct local codes between them and a sample from one would verify
 * one authority's conversion while reporting on all of them.
 * The stride discipline — keys chosen before any geometry is read, deterministic
 * rather than random — is `strideSampleInteriorPoints`'s.
 */
export function sampleAgreementPoints(
	databasePath: PathBuilderLike,
	options: { count?: number } = {}
): Array<{ label: string; latitude: number; longitude: number; localCode: string }> {
	const count = options.count ?? 48
	using database = new DatabaseClient<ZoningDatabase>(databasePath, { readOnly: true })

	// Sort by authority so the stride samples across the 30 authorities
	// instead of sampling one authority repeatedly.
	// A stride over `area_id` by itself would follow the publisher's feature numbering.
	// That numbering is grouped by authority, so the stride would select only the
	// authorities that fall on its positions.
	const areaIDs = (
		database.prepare("SELECT area_id FROM zoning_area ORDER BY jurisdiction_id, area_id").all() as Array<{
			area_id: string
		}>
	).map((row) => row.area_id)

	const selectArea = database.prepare(
		"SELECT area_id, jurisdiction_id, local_code, min_lat, min_lon, max_lat, max_lon, rings FROM zoning_area WHERE area_id = ?"
	)

	return strideSampleInteriorPoints(areaIDs, count, {
		fetch: (key) =>
			selectArea.get(key) as
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
				| undefined,
		gridSteps: 17,
		toPoint: (area, interior) => ({
			label: `${area.jurisdiction_id} ${stringifyJSON(area.local_code)} polygon ${area.area_id}`,
			localCode: area.local_code,
			...interior,
		}),
	})
}
