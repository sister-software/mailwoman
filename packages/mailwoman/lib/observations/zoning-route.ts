/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Attaches local-authority zoning designations to a geocode answer as an observation. The route
 *   never changes answer selection.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	ZoningLookup,
	ZoningReadingKind,
	type ZoningContainmentPath,
	type ZoningDesignation,
	type ZoningLayerIdentity,
	type ZoningReading,
} from "@mailwoman/zoning"
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
 * The published zoning designations for a coordinate, with their coverage and provenance.
 *
 * A location without a designation may still be restricted.
 */
export interface ZoningDesignationObservation {
	/**
	 * Always `designated`.
	 * Any other reading produces a refusal instead.
	 */
	reading: ZoningReadingKind
	/**
	 * Every designation polygon that contains the point.
	 *
	 * There are several when a Local Area Plan overlays a Development Plan on the same ground.
	 */
	designations: ZoningDesignation[]
	containment: ZoningContainmentPath
	/**
	 * The coverage record for the location.
	 *
	 * Its basis is `source_present`, which supports a presence claim only.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell that was probed.
	 */
	indexCellIndex: string
	/**
	 * The product's stated limitations, in the publisher's own words.
	 */
	limits: ReadonlyArray<string>
	/**
	 * The reason this layer's coverage cannot show that a location is unrestricted.
	 */
	coverageLimit: string
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * The reasons a coordinate can produce no zoning observation.
 */
export const ZONING_REFUSALS = [
	/**
	 * The geocode produced no coordinate.
	 */
	"no_coordinate",
	/**
	 * No adopted plan in this product designates the location.
	 *
	 * The product cannot distinguish land outside every plan area, unzoned land inside a plan,
	 * a jurisdiction that never zoned, and a jurisdiction that publishes no records.
	 */
	"no_designation_here",
] as const

/**
 * One {@link ZONING_REFUSALS} value.
 */
export type ZoningRefusal = (typeof ZONING_REFUSALS)[number]

/**
 * The observation or refusal for one coordinate.
 */
export type ZoningDecision =
	| { fired: true; observation: ZoningDesignationObservation }
	| { fired: false; refusal: ZoningRefusal }

/**
 * Reads zoning designations from one sealed layer.
 */
export interface ZoningDesignationRoute extends Disposable {
	identity: ZoningLayerIdentity
	/**
	 * Reads the layer at one coordinate.
	 * A missing coordinate returns the `no_coordinate` refusal.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => ZoningDecision
}

/**
 * Options for {@link createZoningDesignationRoute}.
 */
export interface ZoningDesignationRouteOptions {
	/**
	 * The sealed layer to read.
	 * The route has no default layer.
	 */
	databasePath: PathBuilderLike
}

/**
 * Builds the route against one sealed layer.
 * The reader validates the layer's manifest and coverage.
 */
export function createZoningDesignationRoute(options: ZoningDesignationRouteOptions): ZoningDesignationRoute {
	const lookup = new ZoningLookup({ databasePath: options.databasePath })

	return createDesignationRoute(lookup, {
		read: (latitude, longitude) => lookup.lookup(latitude, longitude),
		refusalFor: (reading) => (reading.kind !== ZoningReadingKind.Designated ? "no_designation_here" : undefined),
		toObservation: (reading, latitude, longitude) =>
			toObservation(reading, lookup.identity, latitude, longitude, options.databasePath.toString()),
	})
}

/**
 * Builds the observation for a reading that passed the refusal check.
 */
function toObservation(
	reading: ZoningReading,
	identity: ZoningLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): ZoningDesignationObservation {
	const { manifest } = identity

	return {
		reading: reading.kind,
		designations: reading.designations,
		containment: reading.containment,
		...observationCoverageRecord(reading.coverage),
		indexCellIndex: reading.indexCellIndex,
		limits: reading.limits,
		coverageLimit: reading.coverageLimit,
		layer: observationLayerRecord(manifest),
		databasePath,
		coordinate: { latitude, longitude },
	}
}

/**
 * Returns the clause that states what the adopted plan assigns.
 *
 * The clause gives the authority's code verbatim, the publisher's crosswalk code
 * when present, and the plan name.
 * The one-line description and the marker message share this wording.
 */
export function zoningAssignmentClause(observation: ZoningDesignationObservation): string {
	const first = observation.designations[0]

	return first
		? `${first.jurisdiction.name} zones the location ${stringifyJSON(first.localCode)}` +
				(first.crosswalk ? ` (${first.crosswalk.scheme} ${first.crosswalk.code})` : "") +
				` under ${first.plan.name}` +
				(observation.designations.length > 1 ? ` (and ${observation.designations.length - 1} more plan(s) here)` : "")
		: "an adopted plan zones the location"
}

/**
 * Returns a one-line description of the observation, including the plan, coverage and layer provenance.
 */
export function describeZoningDesignation(observation: ZoningDesignationObservation): string {
	return (
		`${zoningAssignmentClause(observation)} at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} ` +
		`(${observation.containment}); ${describeCoverage(observation.coverage)}; ${describeLayerProvenance(observation.layer, { tier: true })}`
	)
}
