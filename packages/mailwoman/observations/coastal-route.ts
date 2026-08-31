/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The coastal-erosion route, observation-only: after the resolver has produced a coordinate, the
 *   Environment Agency's own erosion designation for that coordinate is recorded beside the answer — under a
 *   NAMED SCENARIO, with the cumulative distance as published, the shoreline-management policy where the
 *   scenario carries one, and the coverage record stating what the product does and does not license.
 *
 *   THE ROUTE READS; IT NEVER ANSWERS. It takes a finished coordinate and returns a record. Nothing here is
 *   consulted while an answer is being chosen, no candidate is read, no result is added, removed or
 *   re-ordered, and no abstain is reached or avoided because of it. A geocode with the route configured is
 *   the same geocode plus one advisory, which is a statement about construction rather than about a
 *   measurement.
 *
 *   PRESENCE IS THE SWITCH, AND IT IS A LAYER PATH. There is no boolean: a boolean would make the caller's
 *   factory construct the reader itself and put a sealed layer open on the default construction path. A
 *   session resolves the layer path, opens it if the file is there, and hands the route in; a session that
 *   finds no file hands in nothing and is byte-identical to one built before this route existed.
 *
 *   EVERY OBSERVATION NAMES ITS SCENARIO, AND THE ROUTE'S DEFAULT IS NEVER HIDDEN. NCERM publishes twelve
 *   erosion-zone layers because the answer depends on which management scenario, which horizon and which
 *   sea-level-rise allowance the reader means. The route answers under one of them and says which; a reading
 *   that named no scenario would let a 2105 projection be taken for a present-day designation.
 *
 *   ONLY A DESIGNATION REACHES A CALLER, AND THE SILENCE IS THE INVERSION OF THE FLOOD ROUTE. That route
 *   raises a marker for a designated ABSENCE, because inside England a location with no flood polygon is
 *   Flood Zone 1 by the Planning Practice Guidance's own definition. NCERM publishes no coverage statement at
 *   all, so a location with no erosion polygon is either inland or on the coast outside the mapped risk area
 *   and the product cannot tell those apart. There is therefore no absence observation to raise — an
 *   advisory there would be a determination nobody made — and the named refusal is what a receipt carries
 *   instead.
 *
 *   THE OBSERVATION IS ABOUT THE MAP, NEVER ABOUT THE PROPERTY. The Environment Agency states that its data
 *   "cannot provide details for individual properties". So the wording reports what the authority's mapping
 *   assigns at the location under a named scenario — a fact about the map — and the product's own exclusions
 *   ride on every observation, because a caller cannot see from an erosion distance that the answer is silent
 *   about flooding and about foreshore features.
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

import {
	observationCoverageRecord,
	observationLayerRecord,
	type ObservationCoverageRecord,
	type ObservationLayerRecord,
} from "#observations/layer-record"

/**
 * One coastal-erosion designation, recorded beside an answer.
 *
 * Everything a reader needs to check the claim is here: which authority, which product and vintage, which scenario, the
 * polygons the authority's mapping places the location inside with the distance each publishes, how containment was
 * established, and the coverage record with the sentence saying what it does not license. A reader holding the distance
 * alone cannot tell whether it was earned or which of twelve questions it answers.
 */
export interface CoastalErosionObservation {
	/**
	 * Always `designated`. `unknown` produces no observation — see this file's header.
	 */
	reading: CoastalReadingKind
	/**
	 * The scenario the reading answered under, in the authority's own terms.
	 */
	scenario: { key: string; management: string; horizon: number; climateAllowance: string; label: string }
	/**
	 * Every polygon of that scenario containing the point. Usually one; several where the authority's own frontages
	 * overlap.
	 */
	designations: CoastalDesignation[]
	containment: CoastalContainmentPath
	/**
	 * The coverage side of the claim. Its basis is `source_present`, which supports presence and nothing else.
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
	 * Why this layer's coverage licenses no claim that a location is NOT at risk.
	 */
	coverageLimit: string
	layer: ObservationLayerRecord
	databasePath: string
	coordinate: { latitude: number; longitude: number }
}

/**
 * Why a coordinate produced no observation. Every one of these is a SILENCE the route owes an account of — an unnamed
 * silence and a silence for the right reason read identically on a receipt.
 */
export const COASTAL_REFUSALS = [
	/**
	 * The geocode reached no coordinate, so there is nothing to ask the layer about.
	 */
	"no_coordinate",
	/**
	 * The authority's mapping assigns no erosion zone here under the scenario asked about. NOT an absence claim: the
	 * location may be inland, or on the coast outside the mapped risk area, and NCERM publishes nothing that tells those
	 * apart.
	 */
	"no_designation_here",
] as const

export type CoastalRefusal = (typeof COASTAL_REFUSALS)[number]

/**
 * What the route decided about one coordinate: an observation, or a named silence.
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
	 * Decide one resolved coordinate. Pure with respect to the pipeline: it reads the layer and returns a record.
	 *
	 * `null` and `undefined` are both accepted because a geocode result carries `lat`/`lon` as nullable — a caller that
	 * had to narrow them first would be narrowing on this route's behalf, and a coordinate-less answer is a named refusal
	 * here rather than a caller's problem.
	 */
	observe: (latitude: number | null | undefined, longitude: number | null | undefined) => CoastalDecision
}

export interface CoastalErosionRouteOptions {
	/**
	 * The sealed layer to read. Required: there is no default layer, and a route that guessed one would report a
	 * designation from an authority nobody asked about.
	 */
	databasePath: string
	/**
	 * The scenario to answer under. Defaults to the least projected of the twelve — see `DEFAULT_NCERM_SCENARIO`.
	 */
	scenarioKey?: string
}

/**
 * Build the route against one sealed layer.
 *
 * Everything that would make the route answer a well-formed wrong thing is refused by the reader's own constructor — a
 * manifest naming a different layer, a coverage table with no rows, and above all a coverage row whose basis would
 * support an exclusion. That last one would otherwise present as a route reporting the whole of inland England as
 * designated free of coastal erosion.
 */
export function createCoastalErosionRoute(options: CoastalErosionRouteOptions): CoastalErosionRoute {
	const lookup = new CoastalErosionLookup({ databasePath: options.databasePath })
	const scenarioKey = options.scenarioKey ?? DEFAULT_NCERM_SCENARIO

	return {
		identity: lookup.identity,
		scenarioKey,
		observe: (latitude, longitude) => {
			if (typeof latitude !== "number" || typeof longitude !== "number") {
				return { fired: false, refusal: "no_coordinate" }
			}

			return decide(
				lookup.lookup(latitude, longitude, scenarioKey),
				lookup.identity,
				latitude,
				longitude,
				options.databasePath
			)
		},
		[Symbol.dispose]() {
			lookup[Symbol.dispose]()
		},
	}
}

/**
 * Turn one reading into a decision.
 */
function decide(
	reading: CoastalErosionReading,
	identity: CoastalLayerIdentity,
	latitude: number,
	longitude: number,
	databasePath: string
): CoastalDecision {
	if (reading.kind !== CoastalReadingKind.Designated) {
		return { fired: false, refusal: "no_designation_here" }
	}

	const { manifest } = identity

	return {
		fired: true,
		observation: {
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
		},
	}
}

/**
 * One line a reader can check the claim from, with the scenario and the vintage on it.
 */
export function describeCoastalErosion(observation: CoastalErosionObservation): string {
	const first = observation.designations[0]

	const assigned = first
		? `places the location inside a coastal-erosion zone at ${first.distanceM} m of cumulative erosion` +
			(observation.designations.length > 1 ? ` (and ${observation.designations.length - 1} more overlapping)` : "")
		: "places the location inside a coastal-erosion zone"

	const coverage = observation.coverage
		? `coverage cell ${observation.coverage.h3CellIndex} (res ${observation.coverage.resolution}) on basis "${observation.coverage.basis}"`
		: "no coverage row"

	return (
		`Environment Agency NCERM ${assigned} under scenario ${observation.scenario.key} (${observation.scenario.label}) ` +
		`at ${observation.coordinate.latitude}, ${observation.coordinate.longitude} (${observation.containment}); ${coverage}; ` +
		`from ${observation.layer.name} ${observation.layer.version} (${observation.layer.source} ${observation.layer.sourceVintage}, ` +
		`${observation.layer.license}, build ${observation.layer.buildSHA})`
	)
}
