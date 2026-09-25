/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Add an advisory coastal-erosion observation after geocoding.
 *   The route never changes the selected answer and records only designated locations.
 *   Every observation names its scenario, layer provenance, coverage limits, and exclusions.
 *   No designation is not evidence of safety: the source cannot distinguish inland from unmapped coast.
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
	 * Always `designated`.
	 *
	 * `unknown` produces no observation — see this file's header.
	 */
	reading: CoastalReadingKind
	/**
	 * The scenario the reading answered under, in the authority's own terms.
	 */
	scenario: { key: string; management: string; horizon: number; climateAllowance: string; label: string }
	/**
	 * Every polygon of that scenario containing the point.
	 *
	 * Usually one.
	 * Several where the authority's own frontages overlap.
	 */
	designations: CoastalDesignation[]
	containment: CoastalContainmentPath
	/**
	 * The coverage side of the claim.
	 *
	 * Its basis is `source_present`, which supports presence and no other claim.
	 */
	coverage?: ObservationCoverageRecord
	/**
	 * The index cell probed.
	 */
	indexCellIndex: string
	/**
	 * What the product excludes, in the authority's own words.
	 */
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
 * Named reasons a coordinate produced no observation.
 */
export const COASTAL_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is no coordinate to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * The authority's mapping assigns no erosion zone here under the scenario asked about.
	 *
	 * Not an absence claim: the location may be inland, or on the coast outside the
	 * mapped risk area, and ncerm publishes no data that tells those apart.
	 */
	"no_designation_here",
] as const

export type CoastalRefusal = (typeof COASTAL_REFUSALS)[number]

/**
 * Observation or named refusal for one coordinate.
 */
export type CoastalDecision =
	| { fired: true; observation: CoastalErosionObservation }
	| { fired: false; refusal: CoastalRefusal }

export interface CoastalErosionRoute extends Disposable {
	identity: CoastalLayerIdentity
	/**
	 * The scenario every reading from this route answers under.
	 */
	scenarioKey: string
	/**
	 * Read the layer for one coordinate, or return a named refusal for missing coordinates.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => CoastalDecision
}

export interface CoastalErosionRouteOptions {
	/**
	 * The sealed layer to read.
	 *
	 * Required: there is no default layer, and a route that guessed one would report
	 * a designation from an authority nobody asked about.
	 */
	databasePath: PathBuilderLike
	/**
	 * The scenario to answer under.
	 *
	 * Defaults to the least projected of the twelve — see `DEFAULT_NCERM_SCENARIO`.
	 */
	scenarioKey?: string
}

/**
 * Build the route against one sealed layer.
 *
 * Everything that would make the route answer a well-formed wrong thing is
 * refused by the reader's own constructor.
 * A manifest naming a different layer, a coverage table with no rows, and above all
 * a coverage row whose basis would support an exclusion.
 *
 * That last one would otherwise present as a route reporting the whole of inland
 * England as designated free of coastal erosion.
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

/**
 * Build the observation for a reading the refusal check let through.
 */
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
 * What the authority's mapping assigns, in one wording — shared by the one-line
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
