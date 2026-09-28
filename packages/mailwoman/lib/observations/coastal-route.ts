/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Records only designated locations without changing the selected answer, and no designation is not evidence of safety because the source cannot distinguish inland from unmapped coast.
 */

import {
	CoastalErosionLookup,
	CoastalReadingKind,
	DEFAULT_NCERM_SCENARIO,
	type CoastalContainmentPath,
	type CoastalDesignation,
	type CoastalErosionReading,
	type CoastalLayerIdentity,
} from "@mailwoman/coastal"
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
 * Coastal-erosion designation and provenance recorded beside an answer.
 */
export interface CoastalErosionObservation {
	/**
	 * Always `designated`; `unknown` produces no observation — see this file's header.
	 */
	reading: CoastalReadingKind
	scenario: { key: string; management: string; horizon: number; climateAllowance: string; label: string }
	designations: CoastalDesignation[]
	containment: CoastalContainmentPath
	/**
	 * Its basis is `source_present`, which supports presence and no other claim.
	 */
	coverage?: ObservationCoverageRecord
	indexCellIndex: string
	limits: ReadonlyArray<string>
	/**
	 * Why this layer's coverage licenses no claim that a location is not at risk.
	 */
	coverageLimit: string
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Reasons a coordinate produced no observation.
 */
export const COASTAL_REFUSALS = [
	"no_coordinate",
	/**
	 * Not an absence claim: the location may be inland or on the coast outside the mapped
	 * risk area, and ncerm publishes no data that tells those apart.
	 */
	"no_designation_here",
] as const

export type CoastalRefusal = (typeof COASTAL_REFUSALS)[number]

/**
 * Observation or explicit refusal for one coordinate.
 */
export type CoastalDecision =
	| { fired: true; observation: CoastalErosionObservation }
	| { fired: false; refusal: CoastalRefusal }

export interface CoastalErosionRoute extends Disposable {
	identity: CoastalLayerIdentity
	scenarioKey: string
	/**
	 * Read the layer for one coordinate, or return a reasoned refusal for missing coordinates.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => CoastalDecision
}

export interface CoastalErosionRouteOptions {
	/**
	 * The sealed layer to read.
	 *
	 * Required, because a route that guessed a default would report a designation
	 * from an authority not configured for this request.
	 */
	databasePath: PathBuilderLike
	/**
	 * The scenario to answer under, defaulting to the least projected of the
	 * twelve (`DEFAULT_NCERM_SCENARIO`).
	 */
	scenarioKey?: string
}

/**
 * Builds the route against one sealed layer, refusing at construction anything that would make it
 * answer a well-formed wrong thing, above all a coverage row whose basis would support an exclusion.
 */
export function createCoastalErosionRoute(options: CoastalErosionRouteOptions): CoastalErosionRoute {
	const lookup = new CoastalErosionLookup({ databasePath: options.databasePath })
	const scenarioKey = options.scenarioKey ?? DEFAULT_NCERM_SCENARIO

	return {
		...createDesignationRoute(lookup, {
			read: (latitude, longitude) => lookup.lookup(latitude, longitude, scenarioKey),
			refusalFor: (reading) => (reading.kind !== CoastalReadingKind.Designated ? "no_designation_here" : undefined),
			toObservation: (reading, latitude, longitude) =>
				toObservation(reading, lookup.identity, latitude, longitude, options.databasePath.toString()),
		}),
		scenarioKey,
	}
}

function toObservation(
	reading: CoastalErosionReading,
	identity: CoastalLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): CoastalErosionObservation {
	const { manifest } = identity

	return {
		reading: reading.kind,
		scenario: {
			key: reading.scenario.key,
			management: reading.scenario.management,
			horizon: reading.scenario.horizon,
			climateAllowance: reading.scenario.climateAllowance,
			label: reading.scenario.label,
		},
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
 * What the authority's mapping assigns, in one wording shared by the one-line
 * description and the marker message.
 */
export function coastalErosionAssignmentClause(observation: CoastalErosionObservation): string {
	const first = observation.designations[0]

	return first
		? `places the location inside a coastal-erosion zone at ${first.distanceM} m of cumulative erosion` +
				(observation.designations.length > 1 ? ` (and ${observation.designations.length - 1} more overlapping)` : "")
		: "places the location inside a coastal-erosion zone"
}

/**
 * One line a reader can check the claim from, with the scenario and the vintage on it.
 */
export function describeCoastalErosion(observation: CoastalErosionObservation): string {
	return (
		`Environment Agency NCERM ${coastalErosionAssignmentClause(observation)} under scenario ${observation.scenario.key} (${observation.scenario.label}) ` +
		`at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} (${observation.containment}); ${describeCoverage(observation.coverage)}; ` +
		`${describeLayerProvenance(observation.layer)}`
	)
}
