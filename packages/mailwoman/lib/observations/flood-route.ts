/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Add an authority's flood designation as an observation after geocoding.
 *   The route never changes answer selection. It reports designated and designated-absence
 *   readings inside mapped coverage; unknown locations produce a named refusal.
 *   Observations describe the map, not individual property risk, and carry source limitations.
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
 * Authority designation, coverage, and provenance recorded beside an answer.
 */
export interface AuthorityDesignationObservation {
	/**
	 * `designated` or `designated_absence`.
	 *
	 * Never `unknown`: that reading produces no observation.
	 */
	reading: FloodReadingKind
	/**
	 * The authority's code, verbatim.
	 *
	 * Absent on a designated absence, which the authority represents by publishing nothing.
	 */
	code?: string
	/**
	 * The authority's own words for the answered code, and where they are published.
	 */
	definition?: { code: string; label: string; definition: string; definitionURL: string }
	/**
	 * The polygon the ray cast matched, where one did.
	 */
	areaID?: string
	containment: FloodContainmentPath
	/**
	 * The coverage side of the claim, present whenever the location falls inside the authority's footprint.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell probed.
	 */
	indexCellIndex: string
	/**
	 * The authority's own statement of what its map covers, and where it is published.
	 */
	extent: { authority: string; statement: string; statementURL: string }
	/**
	 * What the product excludes, in the authority's own words.
	 */
	limits: ReadonlyArray<string>
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Named reasons a coordinate produced no observation.
 */
export const DESIGNATION_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * The layer holds no coverage row for the location.
	 *
	 * Outside the authority's footprint, which is unknown and never a low-hazard reading.
	 */
	"outside_authority_footprint",
] as const

export type DesignationRefusal = (typeof DESIGNATION_REFUSALS)[number]

/**
 * Observation or named refusal for one coordinate.
 */
export type DesignationDecision =
	| { fired: true; observation: AuthorityDesignationObservation }
	| { fired: false; refusal: DesignationRefusal }

export interface AuthorityDesignationRoute extends Disposable {
	identity: FloodLayerIdentity
	/**
	 * Read the layer for one coordinate; missing coordinates return a named refusal.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => DesignationDecision
}

export interface AuthorityDesignationRouteOptions {
	/**
	 * The sealed layer to read.
	 *
	 * Required: there is no default layer, and a route that guessed one would report
	 * a designation from an authority nobody asked about.
	 */
	databasePath: PathBuilderLike
}

/**
 * Build the route against one sealed layer.
 *
 * Everything that would make the route answer a well-formed wrong thing is
 * refused by the reader's own constructor — a manifest naming a different layer,
 * a coverage table with no rows, a missing footprint row.
 * Each of those would otherwise present as a route that simply never fires, which on a
 * receipt is indistinguishable from a region the authority genuinely has not mapped.
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
 * Build the observation for a reading the refusal check let through.
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
 * What the authority's map assigns, in one wording — shared by the one-line
 * description and the marker message.
 */
export function floodZoneAssignmentClause(observation: AuthorityDesignationObservation): string {
	return observation.code
		? `assigns ${observation.code}`
		: `assigns no zone, which its own guidance defines as ${observation.definition?.label ?? "the absent case"}`
}

/**
 * One line a reader can check the claim from, with the authority and its vintage on it.
 */
export function describeAuthorityDesignation(observation: AuthorityDesignationObservation): string {
	return (
		`${observation.extent.authority}'s map ${floodZoneAssignmentClause(observation)} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} ` +
		`(${observation.containment}); ${describeCoverage(observation.coverage, { completeness: true })}; ${describeLayerProvenance(observation.layer)}`
	)
}
