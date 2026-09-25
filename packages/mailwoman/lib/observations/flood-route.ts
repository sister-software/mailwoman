/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Attaches an authority's flood designation to a geocode answer as an observation. The route
 *   never changes answer selection.
 */

import {
	FloodReadingKind,
	FloodZoneLookup,
	type FloodContainmentPath,
	type FloodLayerIdentity,
	type FloodZoneReading,
} from "@mailwoman/flood"
import type { PathBuilderLike } from "path-ts"

import {
	createDesignationRoute,
	describeCoverage,
	describeLayerProvenance,
	observationCoverageRecord,
	observationLayerRecord,
	type ObservationCoverageRecord,
	type ObservationLayerRecord,
} from "#observations/layer-record"

/**
 * An authority's flood designation for a coordinate, with its coverage and provenance.
 *
 * The observation describes the authority's map.
 * It makes no claim about the risk to an individual property.
 */
export interface AuthorityDesignationObservation {
	/**
	 * Either `designated` or `designated_absence`.
	 * An `unknown` reading produces a refusal instead.
	 */
	reading: FloodReadingKind
	/**
	 * The authority's code, verbatim.
	 *
	 * It is absent on a designated absence, because the authority publishes no code for that case.
	 */
	code?: string
	/**
	 * The authority's definition of the code and the URL where it is published.
	 */
	definition?: { code: string; label: string; definition: string; definitionURL: string }
	/**
	 * The ID of the polygon that contains the point, when one does.
	 */
	areaID?: string
	containment: FloodContainmentPath
	/**
	 * The coverage record for the location inside the authority's footprint.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell that was probed.
	 */
	indexCellIndex: string
	/**
	 * The authority's statement of what its map covers and the URL where it is published.
	 */
	extent: { authority: string; statement: string; statementURL: string }
	/**
	 * The product's exclusions, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * The reasons a coordinate can produce no flood observation.
 */
export const DESIGNATION_REFUSALS = [
	/**
	 * The geocode produced no coordinate.
	 */
	"no_coordinate",
	/**
	 * The layer has no coverage row for the location.
	 *
	 * The hazard there is unknown, which must never be reported as low.
	 */
	"outside_authority_footprint",
] as const

/**
 * One {@link DESIGNATION_REFUSALS} value.
 */
export type DesignationRefusal = (typeof DESIGNATION_REFUSALS)[number]

/**
 * The observation or refusal for one coordinate.
 */
export type DesignationDecision =
	| { fired: true; observation: AuthorityDesignationObservation }
	| { fired: false; refusal: DesignationRefusal }

/**
 * Reads flood designations from one sealed layer.
 */
export interface AuthorityDesignationRoute extends Disposable {
	identity: FloodLayerIdentity
	/**
	 * Reads the layer at one coordinate.
	 * A missing coordinate returns the `no_coordinate` refusal.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => DesignationDecision
}

/**
 * Options for {@link createAuthorityDesignationRoute}.
 */
export interface AuthorityDesignationRouteOptions {
	/**
	 * The sealed layer to read.
	 * The route has no default layer.
	 */
	databasePath: PathBuilderLike
}

/**
 * Builds the route against one sealed layer.
 *
 * The reader's constructor throws on a manifest for a different layer,
 * an empty coverage table or a missing footprint row.
 * Without that check, such a layer would never fire, and the silence would look like an unmapped region.
 */
export function createAuthorityDesignationRoute(options: AuthorityDesignationRouteOptions): AuthorityDesignationRoute {
	const lookup = new FloodZoneLookup({ databasePath: options.databasePath })

	return createDesignationRoute(lookup, {
		read: (latitude, longitude) => lookup.lookup(latitude, longitude),
		refusalFor: (reading) => (reading.kind === FloodReadingKind.Unknown ? "outside_authority_footprint" : undefined),
		toObservation: (reading, latitude, longitude) =>
			toObservation(reading, lookup.identity, latitude, longitude, options.databasePath.toString()),
	})
}

/**
 * Builds the observation for a reading that passed the refusal check.
 */
function toObservation(
	reading: FloodZoneReading,
	identity: FloodLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): AuthorityDesignationObservation {
	const { manifest, extent } = identity

	return {
		reading: reading.kind,
		...(reading.zoneCode ? { code: reading.zoneCode } : {}),
		...(reading.definition ? { definition: reading.definition } : {}),
		...(reading.areaID ? { areaID: reading.areaID } : {}),
		containment: reading.containment,
		...observationCoverageRecord(reading.coverage),
		indexCellIndex: reading.indexCellIndex,
		extent: {
			authority: extent.authority,
			statement: extent.statement,
			statementURL: extent.statementURL,
		},
		limits: reading.limits,
		layer: observationLayerRecord(manifest),
		databasePath,
		coordinate: { latitude, longitude },
	}
}

/**
 * Returns the clause that states what the authority's map assigns.
 *
 * The one-line description and the marker message share this wording.
 */
export function floodZoneAssignmentClause(observation: AuthorityDesignationObservation): string {
	return observation.code
		? `assigns ${observation.code}`
		: `assigns no zone, which its own guidance defines as ${observation.definition?.label ?? "the absent case"}`
}

/**
 * Returns a one-line description of the observation, including the authority,
 * coverage and layer provenance.
 */
export function describeAuthorityDesignation(observation: AuthorityDesignationObservation): string {
	return (
		`${observation.extent.authority}'s map ${floodZoneAssignmentClause(observation)} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} ` +
		`(${observation.containment}); ${describeCoverage(observation.coverage, { completeness: true })}; ${describeLayerProvenance(observation.layer)}`
	)
}
